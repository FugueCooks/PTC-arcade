import type { ServerConfig } from '../config.js';
import type { RuntimeMetrics } from '../metrics/metrics.js';
import type { ServerRecord } from '../servers/server-registry.js';
import type { RoomAdmission, AdmissionReservation } from './room-admission.js';
import type { RoomDirectory } from './room-directory.js';
import type { RoomLifecycleService } from './room-lifecycle-service.js';
import type { RoomManager } from './room-manager.js';
import type { RoomRecord } from './room.js';

export interface PlacementRequest { requestedRoomId?: string; reconnectRoomId?: string; preferredRegion?: string }
export interface PlacementResult { ok: boolean; room?: RoomRecord; reservation?: AdmissionReservation; created?: boolean; reason?: 'no-capacity' | 'unavailable' }
export interface ServerDiscovery { listHealthy(now?: number): Promise<ServerRecord[]>; get?(serverId: string): Promise<ServerRecord | undefined> }

export interface PublicPlacementResult extends PlacementResult { realtimeUrl?: string }

export class RoomPlacementService {
  constructor(
    private readonly rooms: RoomManager,
    private readonly directory: RoomDirectory,
    private readonly lifecycle: RoomLifecycleService,
    private readonly admission: RoomAdmission,
    private readonly servers: ServerDiscovery | undefined,
    private readonly config: ServerConfig,
    private readonly metrics: RuntimeMetrics
  ) {}

  async place(request: PlacementRequest, now = Date.now()): Promise<PlacementResult> {
    for (const id of [request.reconnectRoomId, request.requestedRoomId]) {
      if (!id) continue;
      const room = await this.directory.get(id);
      const result = room ? await this.tryRoom(room, now) : undefined;
      if (result) return result;
    }
    const healthyServers = this.servers ? await this.servers.listHealthy(now) : [];
    const serverById = new Map(healthyServers.map((server) => [server.serverId, server]));
    const candidates = (await this.directory.list(['available']))
      .filter((room) => room.health === 'healthy' && room.playerCount < room.capacity)
      .filter((room) => !this.servers || serverById.has(room.serverId))
      .sort((left, right) => score(right, request.preferredRegion, serverById) - score(left, request.preferredRegion, serverById));
    for (const room of candidates) {
      const result = await this.tryRoom(room, now);
      if (result) { this.metrics.increment('matchmaking_success_total'); return result; }
    }
    if (this.rooms.roomCount < this.config.maxRoomsPerServer) {
      const created = this.rooms.create('main', now); await this.lifecycle.flush();
      const result = await this.tryRoom(created.record(), now);
      if (result) { this.metrics.increment('matchmaking_room_created_total'); return { ...result, created: true }; }
    }
    this.metrics.increment('matchmaking_failure_total');
    return { ok: false, reason: 'no-capacity' };
  }

  async placePublic(request: PlacementRequest, now = Date.now()): Promise<PublicPlacementResult> {
    const result = await this.place(request, now);
    if (!result.ok || !result.room) return result;
    const owner = result.room.serverId === this.config.serverId
      ? { publicRealtimeUrl: this.config.publicRealtimeUrl }
      : await this.servers?.get?.(result.room.serverId);
    if (!owner?.publicRealtimeUrl && result.room.serverId !== this.config.serverId) {
      await this.admission.release(result.room.id, undefined, result.reservation?.token);
      return { ok: false, reason: 'unavailable' };
    }
    return { ...result, realtimeUrl: owner?.publicRealtimeUrl ?? this.config.publicRealtimeUrl };
  }

  private async tryRoom(room: RoomRecord, now: number): Promise<PlacementResult | undefined> {
    if (room.status !== 'available' || room.health !== 'healthy') return undefined;
    const reservation = await this.admission.reserve(room.id, room.capacity, now);
    return reservation ? { ok: true, room, reservation, created: false } : undefined;
  }
}

function score(room: RoomRecord, preferredRegion: string | undefined, servers: Map<string, ServerRecord>): number {
  const regionBonus = preferredRegion && servers.get(room.serverId)?.region === preferredRegion ? 10_000 : 0;
  return regionBonus + room.playerCount * 100 - room.playerCount / Math.max(1, room.capacity);
}
