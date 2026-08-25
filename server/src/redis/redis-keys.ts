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
  reconnect(tokenHash: string): string { return `${this.prefix}:reconnect:${tokenHash}`; }
  socketStream(): string { return `${this.prefix}:socket-stream`; }
  socketSessions(): string { return `${this.prefix}:socket-session:`; }
  activeIdentity(playerId: string): string { return `${this.prefix}:active-identity:${playerId}`; }
  identityPresence(playerId: string): string { return `${this.prefix}:identity-presence:${playerId}`; }
  walletChallenge(challengeId: string): string { return `${this.prefix}:wallet-challenges:${challengeId}`; }
  walletAuthRateLimit(identifierHash: string): string { return `${this.prefix}:wallet-auth-rate-limit:${identifierHash}`; }
  walletAccountLock(network: string, addressHash: string): string { return `${this.prefix}:wallet-account-lock:${network}:${addressHash}`; }
}
