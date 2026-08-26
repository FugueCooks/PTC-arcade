import { randomUUID } from 'node:crypto';
import type { SafeJsonValue } from '../domain/json-value.js';

/**
 * Milestone 11.36 — the background-job abstraction.
 *
 * Requirements this satisfies directly: retries with backoff, dead-letter
 * handling, idempotent processors, metrics, operator visibility, no infinite
 * retries, and safe shutdown.
 *
 * The in-memory queue below is the Phase 11 implementation. It is deliberately
 * behind an interface so a durable Redis- or PostgreSQL-backed queue can replace
 * it without touching a processor, and it is honest about its limits: jobs do
 * not survive a restart. Work that must survive process failure should not be
 * enqueued here until a durable backend exists, and `durable` reports false so
 * an operator can see that from the dashboard.
 */
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'dead-lettered';

export interface Job {
  readonly id: string;
  readonly name: string;
  readonly payload: SafeJsonValue;
  /** Callers supply this to make retries and duplicates idempotent. */
  readonly idempotencyKey: string | null;
  status: JobStatus;
  attempts: number;
  readonly maxAttempts: number;
  readonly enqueuedAt: number;
  runAfter: number;
  lastError: string | null;
  completedAt: number | null;
}

export interface JobProcessor {
  readonly name: string;
  readonly maxAttempts?: number;
  /**
   * Must be idempotent: a job can be delivered more than once after a retry.
   * Throwing schedules a retry until maxAttempts, then dead-letters.
   */
  process(payload: SafeJsonValue, job: Job): Promise<void> | void;
}

export interface JobQueueStats {
  durable: boolean;
  depth: number;
  running: number;
  completed: number;
  deadLettered: number;
  byName: Record<string, number>;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 5 * 60 * 1_000;

/** Exponential backoff, capped so a failing job never schedules absurdly far out. */
export function backoffFor(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1));
}

export interface JobQueueOptions {
  onEvent?: (event: 'completed' | 'dead-lettered', job: Job) => void;
  metrics?: { increment(name: string, amount?: number): void };
  maxDeadLettered?: number;
  /**
   * Single source of time for the queue. Enqueue timestamps, retry deadlines,
   * and the default for `runDue` all read it, so a caller supplying a clock
   * gets a queue that behaves consistently rather than one that mixes an
   * injected clock with wall-clock scheduling.
   */
  now?: () => number;
}

export class JobQueue {
  private readonly queue: Job[] = [];
  private readonly deadLetters: Job[] = [];
  private readonly processors = new Map<string, JobProcessor>();
  private readonly completedKeys = new Set<string>();
  private running = 0;
  private completed = 0;
  private stopped = false;

  /** In-memory: jobs do not survive a restart. Reported, never implied. */
  readonly durable = false;

  private readonly now: () => number;

  constructor(private readonly options: JobQueueOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  register(processor: JobProcessor): void {
    if (this.processors.has(processor.name)) throw new Error(`Duplicate job processor: ${processor.name}`);
    this.processors.set(processor.name, processor);
  }

  /**
   * Enqueues a job. A repeat of an idempotency key that already completed is
   * dropped rather than re-run, which is what makes at-least-once delivery safe
   * for callers that use keys.
   */
  enqueue(name: string, payload: SafeJsonValue, options: { idempotencyKey?: string; runAfter?: number } = {}): Job | undefined {
    if (this.stopped) return undefined;
    const processor = this.processors.get(name);
    if (!processor) throw new Error(`No processor registered for job "${name}".`);
    const key = options.idempotencyKey ?? null;
    if (key !== null && this.completedKeys.has(key)) return undefined;
    if (key !== null && this.queue.some((job) => job.idempotencyKey === key && job.status !== 'completed')) return undefined;

    const job: Job = {
      id: randomUUID(),
      name,
      payload,
      idempotencyKey: key,
      status: 'queued',
      attempts: 0,
      maxAttempts: processor.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      enqueuedAt: this.now(),
      runAfter: options.runAfter ?? this.now(),
      lastError: null,
      completedAt: null
    };
    this.queue.push(job);
    this.options.metrics?.increment('jobs_enqueued_total');
    return job;
  }

  /**
   * Runs every job whose backoff has elapsed. Returns how many were attempted,
   * so a caller can drain in a loop during shutdown.
   */
  async runDue(now = this.now()): Promise<number> {
    const due = this.queue.filter((job) => job.status === 'queued' && job.runAfter <= now);
    for (const job of due) await this.#run(job, now);
    return due.length;
  }

  async #run(job: Job, now: number): Promise<void> {
    const processor = this.processors.get(job.name);
    if (!processor) return;
    job.status = 'running';
    job.attempts += 1;
    this.running += 1;
    try {
      await processor.process(job.payload, job);
      job.status = 'completed';
      job.completedAt = now;
      job.lastError = null;
      this.completed += 1;
      if (job.idempotencyKey !== null) this.completedKeys.add(job.idempotencyKey);
      this.#remove(job);
      this.options.metrics?.increment('jobs_completed_total');
      this.options.onEvent?.('completed', job);
    } catch (error) {
      job.lastError = error instanceof Error ? error.message : String(error);
      if (job.attempts >= job.maxAttempts) {
        // Never retry forever: the job moves to the dead-letter list where an
        // operator can see it.
        job.status = 'dead-lettered';
        this.#remove(job);
        this.deadLetters.push(job);
        const cap = this.options.maxDeadLettered ?? 500;
        if (this.deadLetters.length > cap) this.deadLetters.splice(0, this.deadLetters.length - cap);
        this.options.metrics?.increment('jobs_dead_lettered_total');
        this.options.onEvent?.('dead-lettered', job);
      } else {
        job.status = 'queued';
        job.runAfter = now + backoffFor(job.attempts);
        this.options.metrics?.increment('jobs_retried_total');
      }
    } finally {
      this.running -= 1;
    }
  }

  #remove(job: Job): void {
    const at = this.queue.indexOf(job);
    if (at !== -1) this.queue.splice(at, 1);
  }

  /** Operator visibility: what is waiting, and what has failed for good. */
  stats(): JobQueueStats {
    const byName: Record<string, number> = {};
    for (const job of this.queue) byName[job.name] = (byName[job.name] ?? 0) + 1;
    return {
      durable: this.durable,
      depth: this.queue.length,
      running: this.running,
      completed: this.completed,
      deadLettered: this.deadLetters.length,
      byName
    };
  }

  listDeadLetters(limit = 50): readonly Job[] { return this.deadLetters.slice(-Math.max(1, limit)).reverse(); }

  /** Operator action: clear a stuck job. */
  clearDeadLetter(jobId: string): boolean {
    const at = this.deadLetters.findIndex((job) => job.id === jobId);
    if (at === -1) return false;
    this.deadLetters.splice(at, 1);
    return true;
  }

  /**
   * Safe shutdown: stop accepting work, then drain what is already due. Jobs
   * still in backoff are abandoned, which is correct for a non-durable queue —
   * pretending otherwise would be worse than saying so.
   */
  async stop(now = this.now()): Promise<{ drained: number; abandoned: number }> {
    this.stopped = true;
    const drained = await this.runDue(now);
    return { drained, abandoned: this.queue.filter((job) => job.status === 'queued').length };
  }
}

/**
 * Adapts this queue to the narrow `ReplayJobQueue` shape the replay service
 * depends on. The replay code arrived from a parallel Phase 11 branch that had
 * its own simpler queue; rather than keep two queues, it now enqueues through
 * this one and inherits retries, backoff, and dead-lettering.
 */
export function asReplayJobQueue(queue: JobQueue) {
  return {
    async enqueue(type: string, payload: SafeJsonValue, idempotencyKey: string): Promise<void> {
      queue.enqueue(type, payload, { idempotencyKey });
    }
  };
}
