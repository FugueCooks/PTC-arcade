import type { RedisClientType } from 'redis';
import type { RoomDirectory } from '../rooms/room-directory.js';
import type { RoomRecord, RoomStatus } from '../rooms/room.js';
import type { RedisKeys } from './redis-keys.js';

export class RedisRoomDirectory implements RoomDirectory {
  constructor(private readonly client: RedisClientType, private readonly keys: RedisKeys, private readonly ttlMs: number) {}

  async register(room: RoomRecord): Promise<void> { await this.write(room); }
  async update(room: RoomRecord): Promise<void> { await this.write(room); }

  async remove(roomId: string): Promise<void> {
    const existing = await this.get(roomId);
    const commands = this.client.multi().del(this.keys.room(roomId)).zRem(this.keys.roomDirectory(), roomId);
    if (existing) commands.sRem(this.keys.serverRooms(existing.serverId), roomId);
    await commands.exec();
  }

  async get(roomId: string): Promise<RoomRecord | undefined> {
    const value = await this.client.get(this.keys.room(roomId));
    return value ? parseRoom(value) : undefined;
  }

  async list(statuses?: readonly RoomStatus[]): Promise<RoomRecord[]> {
    const ids = await this.client.zRange(this.keys.roomDirectory(), 0, -1);
    if (ids.length === 0) return [];
    const values = await this.client.mGet(ids.map((id) => this.keys.room(id)));
    const rooms = values.flatMap((value) => value ? [parseRoom(value)] : []);
    const staleIds = ids.filter((_id, index) => values[index] === null);
    if (staleIds.length) await this.client.zRem(this.keys.roomDirectory(), staleIds);
    const allowed = statuses ? new Set(statuses) : undefined;
    return rooms.filter((room) => !allowed || allowed.has(room.status));
  }

  private async write(room: RoomRecord): Promise<void> {
    const ttlSeconds = Math.max(1, Math.ceil(this.ttlMs / 1_000));
    await this.client.multi()
      .set(this.keys.room(room.id), JSON.stringify(room), { expiration: { type: 'EX', value: ttlSeconds } })
      .zAdd(this.keys.roomDirectory(), { score: room.lastActivityAt, value: room.id })
      .sAdd(this.keys.serverRooms(room.serverId), room.id)
      .expire(this.keys.serverRooms(room.serverId), ttlSeconds)
      .exec();
  }
}

function parseRoom(value: string): RoomRecord {
  const parsed = JSON.parse(value) as RoomRecord;
  if (!parsed || typeof parsed.id !== 'string' || typeof parsed.serverId !== 'string') throw new Error('Malformed room directory record.');
  return parsed;
}
