import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isGameDefinitionIssue, toGameDefinition, type GameDefinition } from '../domain/game-definition.js';

/**
 * Milestone 11.2 — one centralized registry, indexed by game ID. The historical
 * file is keyed by `cabinetId` (the game pointed at the cabinet); the cabinet
 * now references a game ID instead, so `byCabinetId` survives only as a
 * compatibility view for callers not yet migrated.
 */
export class GameRegistry {
  private readonly byId = new Map<string, GameDefinition>();
  private readonly cabinetToGameId = new Map<string, string>();
  private readonly byPlatform = new Map<string, GameDefinition[]>();
  private readonly byAdapter = new Map<string, GameDefinition[]>();

  constructor(definitions: readonly GameDefinition[], cabinetAssignments: ReadonlyMap<string, string> = new Map()) {
    for (const definition of definitions) {
      if (this.byId.has(definition.id)) throw new Error(`Duplicate game ID in registry: ${definition.id}`);
      this.byId.set(definition.id, definition);
      index(this.byPlatform, definition.platformId, definition);
      if (definition.emulatorAdapterId) index(this.byAdapter, definition.emulatorAdapterId, definition);
    }
    for (const [cabinetId, gameId] of cabinetAssignments) {
      if (this.byId.has(gameId)) this.cabinetToGameId.set(cabinetId, gameId);
    }
  }

  get size(): number { return this.byId.size; }

  /** O(1). Returns undefined for an unknown ID rather than throwing: callers decide. */
  get(gameId: string): GameDefinition | undefined { return this.byId.get(gameId); }

  has(gameId: string): boolean { return this.byId.has(gameId); }

  all(): readonly GameDefinition[] { return [...this.byId.values()]; }

  forPlatform(platformId: string): readonly GameDefinition[] { return this.byPlatform.get(platformId) ?? []; }

  forAdapter(adapterId: string): readonly GameDefinition[] { return this.byAdapter.get(adapterId) ?? []; }

  /** Compatibility view for the pre-Phase-11 game-per-cabinet lookup. */
  forCabinet(cabinetId: string): GameDefinition | undefined {
    const gameId = this.cabinetToGameId.get(cabinetId);
    return gameId === undefined ? undefined : this.byId.get(gameId);
  }
}

export interface GameRegistryLoadResult {
  registry: GameRegistry;
  issues: readonly string[];
}

/**
 * Loads and validates the registry file. Disabled games are dropped, matching
 * the browser loader's long-standing behaviour. Every malformed row is reported
 * rather than only the first, so one bad edit does not hide the rest.
 */
export function loadGameRegistry(projectRoot: string = process.cwd()): GameRegistryLoadResult {
  const registryPath = path.resolve(projectRoot, 'assets', 'games', 'registry.json');
  const parsed: unknown = JSON.parse(readFileSync(registryPath, 'utf8'));
  if (!parsed || typeof parsed !== 'object') throw new Error('Game registry must be an object.');
  const document = parsed as { version?: unknown; games?: unknown };
  if (document.version !== 1 && document.version !== 2) throw new Error(`Unsupported game registry version: ${String(document.version)}`);
  if (!Array.isArray(document.games)) throw new Error('Game registry must contain a games array.');

  const definitions: GameDefinition[] = [];
  const cabinetAssignments = new Map<string, string>();
  const issues: string[] = [];

  for (const row of document.games) {
    const candidate = toGameDefinition(row);
    if (isGameDefinitionIssue(candidate)) {
      issues.push(`${candidate.gameId}: ${candidate.problem}`);
      continue;
    }
    if (!candidate.enabled) continue;
    definitions.push(candidate);
    const cabinetId: unknown = (row as { cabinetId?: unknown }).cabinetId;
    if (typeof cabinetId === 'string') cabinetAssignments.set(cabinetId, candidate.id);
  }

  return { registry: new GameRegistry(definitions, cabinetAssignments), issues };
}

function index(map: Map<string, GameDefinition[]>, key: string, definition: GameDefinition): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(definition);
  else map.set(key, [definition]);
}
