import type { RoomRecord, RoomStatus } from './room.js';

export interface RoomDirectory {
  register(room: RoomRecord): Promise<void>;
  update(room: RoomRecord): Promise<void>;
  remove(roomId: string): Promise<void>;
  get(roomId: string): Promise<RoomRecord | undefined>;
  list(statuses?: readonly RoomStatus[]): Promise<RoomRecord[]>;
}

/** Development implementation; Redis replaces it without changing RoomManager. */
export class InMemoryRoomDirectory implements RoomDirectory {
  private readonly rooms = new Map<string, RoomRecord>();
  async register(room: RoomRecord): Promise<void> { this.rooms.set(room.id, clone(room)); }
  async update(room: RoomRecord): Promise<void> { this.rooms.set(room.id, clone(room)); }
  async remove(roomId: string): Promise<void> { this.rooms.delete(roomId); }
  async get(roomId: string): Promise<RoomRecord | undefined> { const room = this.rooms.get(roomId); return room ? clone(room) : undefined; }
  async list(statuses?: readonly RoomStatus[]): Promise<RoomRecord[]> {
    const allowed = statuses ? new Set(statuses) : undefined;
    return [...this.rooms.values()].filter((room) => !allowed || allowed.has(room.status)).map(clone);
  }
}

function clone(room: RoomRecord): RoomRecord { return { ...room }; }
