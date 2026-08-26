import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { GameDefinition, ReplayCapability, SafeJson } from '../../../shared/platform-contracts.js';

interface LegacyDisc { label: string; file: string; sizeBytes: number }
interface LegacyGame {
  id: string; cabinetId: string; name: string; system: string; file: string;
  emulatorId: number; sizeBytes: number; enabled: boolean; discs?: LegacyDisc[];
}

/** Validated, immutable game metadata. ROM bytes never enter this service. */
export class GameRegistryService {
  private readonly byId = new Map<string, GameDefinition>();
  private readonly byPlatform = new Map<string, GameDefinition[]>();
  private readonly byLegacyCabinet = new Map<string, GameDefinition>();

  constructor(games: readonly GameDefinition[] = loadGameDefinitions()) {
    for (const game of games) {
      if (this.byId.has(game.id)) throw new Error(`Duplicate game ID: ${game.id}`);
      this.byId.set(game.id, Object.freeze(game));
      const platformGames = this.byPlatform.get(game.platformId) ?? [];
      platformGames.push(game); this.byPlatform.set(game.platformId, platformGames);
      const cabinetId = game.metadata?.legacyCabinetId;
      if (typeof cabinetId === 'string') this.byLegacyCabinet.set(cabinetId, game);
    }
  }

  get size(): number { return this.byId.size; }
  get(gameId: string): GameDefinition | undefined { return this.byId.get(gameId); }
  forPlatform(platformId: string): readonly GameDefinition[] { return this.byPlatform.get(platformId) ?? []; }
  forLegacyCabinet(cabinetId: string): GameDefinition | undefined { return this.byLegacyCabinet.get(cabinetId); }
  listEnabled(): GameDefinition[] { return [...this.byId.values()].filter((game) => game.enabled); }
}

export function loadGameDefinitions(): GameDefinition[] {
  const registryPath = path.resolve(process.cwd(), 'assets', 'games', 'registry.json');
  const parsed = JSON.parse(readFileSync(registryPath, 'utf8')) as { games?: unknown };
  if (!Array.isArray(parsed.games)) throw new Error('Game registry must contain a games array.');
  return parsed.games.map((value) => normalizeLegacyGame(value));
}

function normalizeLegacyGame(value: unknown): GameDefinition {
  if (!isLegacyGame(value)) throw new Error('Game registry contains an invalid game.');
  const discs = value.discs?.map((disc, index) => ({
    id: `${value.id}:disc-${index + 1}`, kind: 'disc' as const, file: disc.file, sizeBytes: disc.sizeBytes, required: index === 0
  }));
  const metadata: Record<string, SafeJson> = {
    legacyCabinetId: value.cabinetId,
    legacyEmulatorNumericId: value.emulatorId,
    primaryFile: value.file,
    primarySizeBytes: value.sizeBytes
  };
  if (value.discs) metadata.discs = value.discs.map((disc) => ({ ...disc }));
  return {
    id: value.id,
    displayName: value.name,
    platformId: value.system,
    launcherAdapterId: 'browser-local',
    emulatorAdapterId: 'legacy-browser-emulator',
    assetRequirements: discs ?? [{ id: `${value.id}:game`, kind: 'game', file: value.file, sizeBytes: value.sizeBytes, required: true }],
    inputProfileId: `standard-${value.system}`,
    replayCapability: replayCapability(value.system),
    enabled: value.enabled,
    metadata
  };
}

function replayCapability(_platformId: string): ReplayCapability {
  // Current cores do not expose reproducible emulator ticks or state hashing.
  return 'INPUT_LOG';
}

function isLegacyGame(value: unknown): value is LegacyGame {
  if (!value || typeof value !== 'object') return false;
  const game = value as Partial<LegacyGame>;
  return typeof game.id === 'string' && /^[a-z0-9-]+$/.test(game.id)
    && typeof game.cabinetId === 'string' && typeof game.name === 'string'
    && typeof game.system === 'string' && typeof game.file === 'string'
    && Number.isInteger(game.emulatorId) && Number.isFinite(game.sizeBytes)
    && typeof game.enabled === 'boolean' && (game.discs === undefined || game.discs.every(isDisc));
}

function isDisc(value: unknown): value is LegacyDisc {
  if (!value || typeof value !== 'object') return false;
  const disc = value as Partial<LegacyDisc>;
  return typeof disc.label === 'string' && typeof disc.file === 'string' && Number.isFinite(disc.sizeBytes);
}
