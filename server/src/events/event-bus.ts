/**
 * Milestone 11.35 — a typed internal event bus.
 *
 * Scope is deliberately narrow, because the brief warns this must not become an
 * uncontrolled global dependency. Three rules keep it bounded:
 *
 *  - the event map is a closed type, so a publisher cannot invent an event;
 *  - a subscriber that throws is isolated and counted, never allowed to break
 *    the publisher or starve later subscribers;
 *  - delivery is synchronous and in subscription order, and nothing here is
 *    durable. Work that must survive a process failure belongs in the job
 *    queue, not on this bus.
 *
 * Ownership: each event is published by exactly one subsystem, named below.
 * Subscribers must treat delivery as best-effort notification, never as a
 * transaction.
 */
export interface ArcadeEvents {
  /** Published by GameSessionService. */
  'game.session.created': { sessionId: string; cabinetId: string; gameId: string; roomId: string };
  'game.session.started': { sessionId: string; cabinetId: string; gameId: string; roomId: string };
  'game.session.ended': { sessionId: string; cabinetId: string; roomId: string; reason: string };
  /** Published by CabinetManager. */
  'cabinet.state.changed': { roomId: string; cabinetId: string; status: string; revision: number };
  /** Published by PluginHost. */
  'plugin.started': { pluginId: string; version: string };
  'plugin.failed': { pluginId: string; error: string };
  /** Published by RoomLifecycleService. */
  'room.created': { roomId: string };
  'room.closed': { roomId: string; reason: string };
  /** Published by the job queue. */
  'job.completed': { jobId: string; name: string; attempts: number };
  'job.dead-lettered': { jobId: string; name: string; error: string };
}

export type ArcadeEventName = keyof ArcadeEvents;
export type ArcadeEventHandler<K extends ArcadeEventName> = (payload: ArcadeEvents[K]) => void;

export interface EventBusStats {
  published: number;
  delivered: number;
  handlerFailures: number;
}

export class EventBus {
  private readonly handlers = new Map<ArcadeEventName, Set<(payload: never) => void>>();
  private published = 0;
  private delivered = 0;
  private handlerFailures = 0;

  constructor(private readonly onHandlerError: (event: string, error: unknown) => void = () => undefined) {}

  /** Returns an unsubscribe function; callers must use it on teardown. */
  on<K extends ArcadeEventName>(event: K, handler: ArcadeEventHandler<K>): () => void {
    const bucket = this.handlers.get(event) ?? new Set();
    bucket.add(handler as (payload: never) => void);
    this.handlers.set(event, bucket);
    return () => { bucket.delete(handler as (payload: never) => void); };
  }

  /**
   * Delivers to every subscriber. A throwing subscriber is caught, counted, and
   * reported so one bad listener cannot break the publisher or prevent later
   * subscribers from seeing the event.
   */
  emit<K extends ArcadeEventName>(event: K, payload: ArcadeEvents[K]): void {
    this.published += 1;
    const bucket = this.handlers.get(event);
    if (!bucket) return;
    for (const handler of [...bucket]) {
      try {
        (handler as ArcadeEventHandler<K>)(payload);
        this.delivered += 1;
      } catch (error) {
        this.handlerFailures += 1;
        this.onHandlerError(event, error);
      }
    }
  }

  listenerCount(event: ArcadeEventName): number { return this.handlers.get(event)?.size ?? 0; }

  stats(): EventBusStats {
    return { published: this.published, delivered: this.delivered, handlerFailures: this.handlerFailures };
  }

  removeAll(): void { this.handlers.clear(); }
}
