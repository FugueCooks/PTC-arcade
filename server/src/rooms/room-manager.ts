import { DEFAULT_ROOM_ID } from '../protocol.js';
import { Room, type RoomConfig } from './room.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const defaultRoom: RoomConfig = {
  id: DEFAULT_ROOM_ID,
  capacity: 48,
  spawnSeparation: 1.4,
  spawnPoints: [
    { x: 0, y: 1.65, z: 11, rotationY: Math.PI },
    { x: -2.2, y: 1.65, z: 11, rotationY: Math.PI },
    { x: 2.2, y: 1.65, z: 11, rotationY: Math.PI },
    { x: -1.1, y: 1.65, z: 8.8, rotationY: 0 },
    { x: 1.1, y: 1.65, z: 8.8, rotationY: 0 }
  ]
};

/** Registry seam for future additional rooms or a distributed room directory. */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();

  constructor(configs?: readonly RoomConfig[], maximumCapacity = 48) {
    const roomConfigs = configs ?? configuredRooms(maximumCapacity);
    roomConfigs.forEach((config) => this.rooms.set(config.id, new Room(config)));
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  getDefault(): Room {
    return this.rooms.get(DEFAULT_ROOM_ID)!;
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  get activeRoomCount(): number {
    return [...this.rooms.values()].filter((room) => !room.isEmpty).length;
  }

  get averagePopulation(): number {
    const active = [...this.rooms.values()].filter((room) => !room.isEmpty);
    return active.length === 0 ? 0 : active.reduce((total, room) => total + room.memberCount, 0) / active.length;
  }
}

function configuredRooms(maximumCapacity: number): RoomConfig[] {
  const registryPath = path.resolve(process.cwd(), 'assets', 'rooms', 'registry.json');
  const parsed = JSON.parse(readFileSync(registryPath, 'utf8')) as { rooms?: Array<{ id?: unknown; capacity?: unknown; enabled?: unknown }> };
  const rooms = (parsed.rooms ?? []).filter((room) => room.enabled === true && typeof room.id === 'string'
    && /^(main|main-[2-9])$/.test(room.id) && Number.isInteger(room.capacity) && Number(room.capacity) <= 48);
  if (!rooms.some((room) => room.id === DEFAULT_ROOM_ID)) throw new Error('Room registry must enable the default room.');
  return rooms.map((room) => ({ ...defaultRoom, id: String(room.id), capacity: Math.min(Number(room.capacity), maximumCapacity) }));
}
