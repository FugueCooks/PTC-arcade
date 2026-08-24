import type { Logger } from '../logging/logger.js';
import type { RuntimeMetrics } from '../metrics/metrics.js';
import type { RoomDirectory } from './room-directory.js';
import type { RoomManager, RoomManagerEvent } from './room-manager.js';
import type { RoomLease, RoomOwnershipService } from '../redis/room-ownership-service.js';

export class RoomLifecycleService {
  private unsubscribe?: () => void;
  private pending = Promise.resolve();
  private refreshTimer?: NodeJS.Timeout;
  private readonly leases = new Map<string, RoomLease>();

  constructor(
    private readonly rooms: RoomManager,
    private readonly directory: RoomDirectory,
    private readonly metrics: RuntimeMetrics,
    private readonly logger: Logger,
    private readonly ownership?: RoomOwnershipService,
    private readonly refreshIntervalMs = 10_000
  ) {}

  async start(): Promise<void> {
    for (const room of this.rooms.records) await this.register(room.id);
    this.unsubscribe = this.rooms.subscribe((event) => {
      this.pending = this.pending.then(() => this.handle(event)).catch((error: unknown) => {
        this.logger.error('room_directory_update_failed', { errorMessage: error instanceof Error ? error.message : 'unknown' });
      });
    });
    if (this.ownership) {
      this.refreshTimer = setInterval(() => { this.pending = this.pending.then(() => this.refresh()).catch((error: unknown) => this.failed(error)); }, this.refreshIntervalMs);
      this.refreshTimer.unref();
    }
  }

  beginDraining(): void { this.rooms.setAllStatuses('draining'); }
  closeIdle(idleTimeoutMs: number, now = Date.now()): string[] { return this.rooms.closeIdle(idleTimeoutMs, now); }
  ensureAvailable(minimum: number, maximumRooms: number, now = Date.now()): string[] {
    return this.rooms.ensureAvailable(minimum, maximumRooms, now).map((room) => room.id);
  }
  async flush(): Promise<void> { await this.pending; }
  async stop(): Promise<void> {
    this.unsubscribe?.(); this.unsubscribe = undefined;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    await this.pending;
    for (const room of this.rooms.records) await this.directory.remove(room.id);
    if (this.ownership) for (const lease of this.leases.values()) await this.ownership.release(lease);
    this.leases.clear();
  }

  private async handle(event: RoomManagerEvent): Promise<void> {
    if (event.type === 'RoomCreated') {
      if (!(await this.register(event.room.id))) return;
      this.metrics.increment('room_creation_total');
      this.logger.info('room_created', { roomId: event.room.id, capacity: event.room.capacity }); return;
    }
    if (event.type === 'RoomClosed') {
      await this.directory.remove(event.room.id); this.metrics.increment('room_closure_total');
      const lease = this.leases.get(event.room.id);
      if (lease && this.ownership) await this.ownership.release(lease);
      this.leases.delete(event.room.id);
      this.logger.info('room_closed', { roomId: event.room.id }); return;
    }
    if (!this.ownership || this.leases.has(event.room.id)) await this.directory.update(event.room);
  }

  private async register(roomId: string): Promise<boolean> {
    if (this.ownership) {
      const lease = await this.ownership.acquire(roomId);
      if (!lease) {
        this.rooms.setHealth(roomId, 'unhealthy');
        this.metrics.increment('room_ownership_conflict_total');
        this.logger.error('room_ownership_conflict', { roomId });
        return false;
      }
      this.leases.set(roomId, lease);
    }
    const room = this.rooms.get(roomId)?.record();
    if (!room) return false;
    await this.directory.register(room);
    return true;
  }

  private async refresh(): Promise<void> {
    for (const room of this.rooms.records) {
      if (this.ownership) {
        const lease = this.leases.get(room.id);
        if (lease && !(await this.ownership.renew(lease))) {
          this.rooms.setHealth(room.id, 'unhealthy');
          this.leases.delete(room.id);
          this.metrics.increment('room_ownership_lost_total');
          this.logger.error('room_ownership_lost', { roomId: room.id });
        }
        if (!this.leases.has(room.id)) {
          const replacement = await this.ownership.acquire(room.id);
          if (!replacement) {
            this.rooms.setHealth(room.id, 'unhealthy');
            this.metrics.increment('room_ownership_reacquire_failure_total');
            continue;
          }
          this.leases.set(room.id, replacement);
          this.rooms.setHealth(room.id, 'healthy');
          this.metrics.increment('room_ownership_reacquired_total');
          this.logger.info('room_ownership_reacquired', { roomId: room.id, fencingToken: replacement.fencingToken });
        }
      }
      await this.directory.update(this.rooms.get(room.id)?.record() ?? room);
    }
  }

  private failed(error: unknown): void {
    this.metrics.increment('room_directory_refresh_failure_total');
    this.logger.error('room_directory_refresh_failed', { errorMessage: error instanceof Error ? error.message : 'unknown' });
  }
}
