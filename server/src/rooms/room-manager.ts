import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_ROOM_ID } from '../protocol.js';
import { Room, type RoomConfig, type RoomHealth, type RoomRecord, type RoomStatus } from './room.js';

const baseRoom: Omit<RoomConfig, 'id'> = {
  capacity: 48, spawnSeparation: 1.4,
  spawnPoints: [
    { x: 0, y: 1.65, z: 11, rotationY: Math.PI }, { x: -2.2, y: 1.65, z: 11, rotationY: Math.PI },
    { x: 2.2, y: 1.65, z: 11, rotationY: Math.PI }, { x: -1.1, y: 1.65, z: 8.8, rotationY: 0 },
    { x: 1.1, y: 1.65, z: 8.8, rotationY: 0 }
  ]
};

export type RoomManagerEvent =
  | { type: 'RoomCreated'; room: RoomRecord }
  | { type: 'RoomChanged'; room: RoomRecord }
  | { type: 'RoomClosed'; room: RoomRecord };

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly listeners = new Set<(event: RoomManagerEvent) => void>();
  private readonly templates: readonly RoomConfig[];
  private readonly defaultRoomId: string;

  constructor(configs?: readonly RoomConfig[], maximumCapacity = 48, private readonly serverId = 'local', globallyUniqueIds = false) {
    this.templates = (configs ?? configuredRooms(maximumCapacity)).map((config) => ({
      ...config, capacity: Math.min(config.capacity ?? maximumCapacity, maximumCapacity)
    }));
    if (globallyUniqueIds) {
      const template = this.templates.find((candidate) => candidate.id === DEFAULT_ROOM_ID) ?? this.templates[0];
      const suffix = randomUUID();
      const room = this.addRoom({ ...template, id: `room-${suffix}`, templateId: template.id, seeded: true }, Date.now(), false);
      this.defaultRoomId = room.id;
    } else {
      this.templates.forEach((config) => this.addRoom({ ...config, seeded: true }, Date.now(), false));
      this.defaultRoomId = DEFAULT_ROOM_ID;
    }
  }

  subscribe(listener: (event: RoomManagerEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  get(roomId: string): Room | undefined { return this.rooms.get(roomId) ?? (roomId === DEFAULT_ROOM_ID ? this.getDefault() : undefined); }
  getDefault(): Room { return this.rooms.get(this.defaultRoomId)!; }
  get roomCount(): number { return this.rooms.size; }
  get availableRoomCount(): number { return [...this.rooms.values()].filter((room) => room.acceptsPlayers).length; }
  get activeRoomCount(): number { return [...this.rooms.values()].filter((room) => !room.isEmpty).length; }
  get records(): RoomRecord[] { return [...this.rooms.values()].map((room) => room.record()); }

  get averagePopulation(): number {
    const active = [...this.rooms.values()].filter((room) => !room.isEmpty);
    return active.length === 0 ? 0 : active.reduce((total, room) => total + room.memberCount, 0) / active.length;
  }

  create(templateId = DEFAULT_ROOM_ID, now = Date.now()): Room {
    const template = this.templates.find((candidate) => candidate.id === templateId) ?? this.templates[0];
    const suffix = randomUUID();
    return this.addRoom({ ...template, id: `${template.id}-${suffix}`, name: `${template.name ?? 'Arcade'} ${suffix.slice(0, 4).toUpperCase()}`, seeded: false, templateId: template.id }, now, true);
  }

  ensureAvailable(minimum: number, maximumRooms: number, now = Date.now()): Room[] {
    const created: Room[] = [];
    while (this.availableRoomCount < minimum && this.roomCount < maximumRooms) created.push(this.create(DEFAULT_ROOM_ID, now));
    return created;
  }

  close(roomId: string, now = Date.now()): boolean {
    const room = this.rooms.get(roomId);
    if (!room || !room.isEmpty || room.config.seeded) return false;
    room.setStatus('closing', now); room.setStatus('closed', now); this.rooms.delete(roomId);
    this.publish({ type: 'RoomClosed', room: room.record() });
    return true;
  }

  closeIdle(idleTimeoutMs: number, now = Date.now()): string[] {
    const closed: string[] = [];
    for (const room of [...this.rooms.values()]) {
      if (room.config.seeded || !room.isEmpty || now - room.lastActivityAt < idleTimeoutMs) continue;
      if (this.close(room.id, now)) closed.push(room.id);
    }
    return closed;
  }

  setAllStatuses(status: RoomStatus, now = Date.now()): void { this.rooms.forEach((room) => room.setStatus(status, now)); }
  setHealth(roomId: string, health: RoomHealth, now = Date.now()): void { this.rooms.get(roomId)?.setHealth(health, now); }
  bumpStateRevision(roomId: string, domain: 'cabinet' | 'world', now = Date.now()): void { this.rooms.get(roomId)?.bumpRevision(domain, now); }

  private addRoom(config: RoomConfig, now: number, announce: boolean): Room {
    if (this.rooms.has(config.id)) throw new Error(`Duplicate room ID: ${config.id}`);
    const room = new Room(config, this.serverId, now, (changed) => this.publish({ type: 'RoomChanged', room: changed.record() }));
    this.rooms.set(room.id, room);
    if (announce) this.publish({ type: 'RoomCreated', room: room.record() });
    return room;
  }

  private publish(event: RoomManagerEvent): void { this.listeners.forEach((listener) => listener(event)); }
}

function configuredRooms(maximumCapacity: number): RoomConfig[] {
  const registryPath = path.resolve(process.cwd(), 'assets', 'rooms', 'registry.json');
  const parsed = JSON.parse(readFileSync(registryPath, 'utf8')) as { rooms?: Array<{ id?: unknown; name?: unknown; capacity?: unknown; enabled?: unknown }> };
  const rooms = (parsed.rooms ?? []).filter((room) => room.enabled === true && typeof room.id === 'string'
    && /^(main|main-(?:[2-9]|10))$/.test(room.id) && typeof room.name === 'string' && Number.isInteger(room.capacity) && Number(room.capacity) <= 48);
  if (!rooms.some((room) => room.id === DEFAULT_ROOM_ID)) throw new Error('Room registry must enable the default room.');
  return rooms.map((room) => ({ ...baseRoom, id: String(room.id), name: String(room.name), capacity: Math.min(Number(room.capacity), maximumCapacity), templateId: String(room.id) }));
}
