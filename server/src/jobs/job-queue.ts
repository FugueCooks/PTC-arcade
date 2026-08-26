import type { SafeJson } from '../../../shared/platform-contracts.js';

export interface BackgroundJob { id: string; type: string; payload: Record<string, SafeJson>; idempotencyKey: string; attempts: number; availableAt: number }
export interface BackgroundJobQueue { enqueue(type: string, payload: Record<string, SafeJson>, idempotencyKey: string): Promise<void>; claim(now?: number): Promise<BackgroundJob | undefined>; complete(id: string): Promise<void>; fail(id: string, retryAt?: number): Promise<void>; depth(): Promise<number> }

/** Development queue. Production adapters may persist the same contract in PostgreSQL. */
export class InMemoryBackgroundJobQueue implements BackgroundJobQueue {
  private readonly jobs = new Map<string, BackgroundJob>();private readonly keys = new Map<string, string>();
  async enqueue(type: string, payload: Record<string, SafeJson>, idempotencyKey: string): Promise<void> {
    if (this.keys.has(idempotencyKey)) return;const id = crypto.randomUUID();this.keys.set(idempotencyKey,id);
    this.jobs.set(id,{id,type,payload:structuredClone(payload),idempotencyKey,attempts:0,availableAt:Date.now()});
  }
  async claim(now=Date.now()): Promise<BackgroundJob|undefined> { const job=[...this.jobs.values()].find(candidate=>candidate.availableAt<=now);if(!job)return undefined;job.availableAt=Number.POSITIVE_INFINITY;job.attempts+=1;return structuredClone(job); }
  async complete(id:string):Promise<void>{const job=this.jobs.get(id);if(!job)return;this.jobs.delete(id);this.keys.delete(job.idempotencyKey)}
  async fail(id:string,retryAt=Date.now()+1_000):Promise<void>{const job=this.jobs.get(id);if(!job)return;if(job.attempts>=5){this.jobs.delete(id);this.keys.delete(job.idempotencyKey);return}job.availableAt=retryAt}
  async depth():Promise<number>{return this.jobs.size}
}
