import type { Logger } from '../logging/logger.js';
import type { RuntimeMetrics } from '../metrics/metrics.js';
import type { RoomDirectory } from './room-directory.js';
import type { RoomManager, RoomManagerEvent } from './room-manager.js';

export class RoomLifecycleService {
  private unsubscribe?: () => void;
  private pending = Promise.resolve();

  constructor(private readonly rooms: RoomManager, private readonly directory: RoomDirectory, private readonly metrics: RuntimeMetrics, private readonly logger: Logger) {}

  async start(): Promise<void> {
    for (const room of this.rooms.records) await this.directory.register(room);
    this.unsubscribe = this.rooms.subscribe((event) => {
      this.pending = this.pending.then(() => this.handle(event)).catch((error: unknown) => {
        this.logger.error('room_directory_update_failed', { errorMessage: error instanceof Error ? error.message : 'unknown' });
      });
    });
  }

  beginDraining(): void { this.rooms.setAllStatuses('draining'); }
  closeIdle(idleTimeoutMs: number, now = Date.now()): string[] { return this.rooms.closeIdle(idleTimeoutMs, now); }
  async flush(): Promise<void> { await this.pending; }
  stop(): void { this.unsubscribe?.(); this.unsubscribe = undefined; }

  private async handle(event: RoomManagerEvent): Promise<void> {
    if (event.type === 'RoomCreated') {
      await this.directory.register(event.room); this.metrics.increment('room_creation_total');
      this.logger.info('room_created', { roomId: event.room.id, capacity: event.room.capacity }); return;
    }
    if (event.type === 'RoomClosed') {
      await this.directory.remove(event.room.id); this.metrics.increment('room_closure_total');
      this.logger.info('room_closed', { roomId: event.room.id }); return;
    }
    await this.directory.update(event.room);
  }
}
