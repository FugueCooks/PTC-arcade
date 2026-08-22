import { DEFAULT_ROOM_ID } from '../protocol.js';
import { Room, type RoomConfig } from './room.js';

const defaultRoom: RoomConfig = {
  id: DEFAULT_ROOM_ID,
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

  constructor(configs: readonly RoomConfig[] = [defaultRoom]) {
    configs.forEach((config) => this.rooms.set(config.id, new Room(config)));
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  getDefault(): Room {
    return this.rooms.get(DEFAULT_ROOM_ID)!;
  }
}
