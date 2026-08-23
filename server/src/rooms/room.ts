/** A room only manages membership and spawn geometry; player state lives in PlayerManager. */
export interface SpawnPoint {
  x: number;
  y: number;
  z: number;
  rotationY: number;
}

export interface RoomConfig {
  id: string;
  capacity?: number;
  spawnPoints: readonly SpawnPoint[];
  spawnSeparation: number;
}

export class Room {
  private readonly members = new Set<string>();

  constructor(readonly config: RoomConfig) {}

  get id(): string {
    return this.config.id;
  }

  add(playerId: string): void {
    this.members.add(playerId);
  }

  remove(playerId: string): void {
    this.members.delete(playerId);
  }

  has(playerId: string): boolean {
    return this.members.has(playerId);
  }

  get memberIds(): readonly string[] {
    return [...this.members];
  }

  get isEmpty(): boolean {
    return this.members.size === 0;
  }

  get isFull(): boolean {
    return this.members.size >= (this.config.capacity ?? 48);
  }

  chooseSpawn(occupied: readonly { x: number; z: number }[]): SpawnPoint {
    const available = this.config.spawnPoints.find((spawn) => occupied.every((player) => (
      Math.hypot(player.x - spawn.x, player.z - spawn.z) >= this.config.spawnSeparation
    )));
    if (available) return available;

    // Future rooms can simply configure more spawn points. This fallback prevents overlap.
    const base = this.config.spawnPoints[this.members.size % this.config.spawnPoints.length];
    const ring = Math.floor(this.members.size / this.config.spawnPoints.length) + 1;
    const angle = this.members.size * 2.399963229728653;
    return {
      x: base.x + Math.cos(angle) * ring * this.config.spawnSeparation,
      y: base.y,
      z: base.z + Math.sin(angle) * ring * this.config.spawnSeparation,
      rotationY: base.rotationY
    };
  }
}
