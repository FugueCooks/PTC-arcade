/** A room owns membership and lifecycle metadata; gameplay state stays in its domain managers. */
export interface SpawnPoint { x: number; y: number; z: number; rotationY: number }
export type RoomStatus = 'starting' | 'available' | 'full' | 'draining' | 'closing' | 'closed' | 'unhealthy';
export type RoomHealth = 'healthy' | 'unhealthy';

export interface RoomConfig {
  id: string; name?: string; capacity?: number; spawnPoints: readonly SpawnPoint[]; spawnSeparation: number;
  seeded?: boolean; templateId?: string;
}

export interface RoomRecord {
  id: string; name: string; templateId: string; serverId: string; playerCount: number; capacity: number;
  status: RoomStatus; health: RoomHealth; createdAt: number; lastActivityAt: number; seeded: boolean;
  cabinetRevision: number; worldRevision: number; jukeboxRevision: number;
}

export class Room {
  private readonly members = new Set<string>();
  private statusValue: RoomStatus = 'available';
  private healthValue: RoomHealth = 'healthy';
  private lastActivityValue: number;
  private cabinetRevisionValue = 0;
  private worldRevisionValue = 0;
  private jukeboxRevisionValue = 0;

  constructor(readonly config: RoomConfig, readonly serverId = 'local', readonly createdAt = Date.now(), private readonly onChanged?: (room: Room) => void) {
    this.lastActivityValue = createdAt;
  }

  get id(): string { return this.config.id; }
  get name(): string { return this.config.name ?? this.config.id; }
  get capacity(): number { return this.config.capacity ?? 48; }
  get status(): RoomStatus { return this.statusValue; }
  get health(): RoomHealth { return this.healthValue; }
  get lastActivityAt(): number { return this.lastActivityValue; }
  get memberIds(): readonly string[] { return [...this.members]; }
  get memberCount(): number { return this.members.size; }
  get isEmpty(): boolean { return this.members.size === 0; }
  get isFull(): boolean { return this.members.size >= this.capacity; }
  get acceptsPlayers(): boolean { return this.healthValue === 'healthy' && this.statusValue === 'available' && !this.isFull; }

  add(playerId: string, now = Date.now()): void {
    if (!this.tryAdd(playerId, now)) throw new Error(`Room ${this.id} cannot accept another player.`);
  }

  tryAdd(playerId: string, now = Date.now()): boolean {
    if (this.members.has(playerId)) return true;
    if (!this.acceptsPlayers) return false;
    this.members.add(playerId);
    this.touch(now);
    this.statusValue = this.isFull ? 'full' : 'available';
    this.changed();
    return true;
  }

  remove(playerId: string, now = Date.now()): void {
    if (!this.members.delete(playerId)) return;
    this.touch(now);
    if (this.statusValue === 'full') this.statusValue = 'available';
    this.changed();
  }

  setStatus(status: RoomStatus, now = Date.now()): void {
    if (this.statusValue === status) return;
    this.statusValue = status; this.touch(now); this.changed();
  }

  setHealth(health: RoomHealth, now = Date.now()): void {
    if (this.healthValue === health) return;
    this.healthValue = health;
    this.statusValue = health === 'unhealthy' ? 'unhealthy' : (this.isFull ? 'full' : 'available');
    this.touch(now); this.changed();
  }

  bumpRevision(domain: 'cabinet' | 'world' | 'jukebox', now = Date.now()): void {
    if (domain === 'cabinet') this.cabinetRevisionValue += 1;
    if (domain === 'world') this.worldRevisionValue += 1;
    if (domain === 'jukebox') this.jukeboxRevisionValue += 1;
    this.touch(now); this.changed();
  }

  record(): RoomRecord {
    return {
      id: this.id, name: this.name, templateId: this.config.templateId ?? this.id, serverId: this.serverId,
      playerCount: this.memberCount, capacity: this.capacity, status: this.statusValue, health: this.healthValue,
      createdAt: this.createdAt, lastActivityAt: this.lastActivityValue, seeded: this.config.seeded ?? false,
      cabinetRevision: this.cabinetRevisionValue, worldRevision: this.worldRevisionValue, jukeboxRevision: this.jukeboxRevisionValue
    };
  }

  chooseSpawn(occupied: readonly { x: number; z: number }[]): SpawnPoint {
    const available = this.config.spawnPoints.find((spawn) => occupied.every((player) => Math.hypot(player.x - spawn.x, player.z - spawn.z) >= this.config.spawnSeparation));
    if (available) return available;
    const base = this.config.spawnPoints[this.members.size % this.config.spawnPoints.length];
    const ring = Math.floor(this.members.size / this.config.spawnPoints.length) + 1;
    const angle = this.members.size * 2.399963229728653;
    return { x: base.x + Math.cos(angle) * ring * this.config.spawnSeparation, y: base.y, z: base.z + Math.sin(angle) * ring * this.config.spawnSeparation, rotationY: base.rotationY };
  }

  private touch(now: number): void { this.lastActivityValue = Math.max(this.lastActivityValue, now); }
  private changed(): void { this.onChanged?.(this); }
}
