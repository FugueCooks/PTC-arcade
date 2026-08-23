export class RedisKeys {
  constructor(readonly prefix: string) {}
  server(serverId: string): string { return `${this.prefix}:servers:${serverId}`; }
  serverHeartbeats(): string { return `${this.prefix}:server-heartbeats`; }
  room(roomId: string): string { return `${this.prefix}:rooms:${roomId}`; }
  roomDirectory(): string { return `${this.prefix}:room-directory`; }
  serverRooms(serverId: string): string { return `${this.prefix}:server-rooms:${serverId}`; }
  roomOwner(roomId: string): string { return `${this.prefix}:room-owner:${roomId}`; }
  roomFence(roomId: string): string { return `${this.prefix}:room-fence:${roomId}`; }
  roomMembers(roomId: string): string { return `${this.prefix}:room-members:${roomId}`; }
  roomReservations(roomId: string): string { return `${this.prefix}:room-reservations:${roomId}`; }
  socketStream(): string { return `${this.prefix}:socket-stream`; }
  socketSessions(): string { return `${this.prefix}:socket-session:`; }
}
