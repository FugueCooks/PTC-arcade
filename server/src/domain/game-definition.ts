import { isSafeMetadata, type SafeJsonValue } from './json-value.js';

/**
 * Milestone 11.2 — the game owns the launcher and emulator identity. Cabinets
 * reference a game ID and never inspect a ROM extension or name a core.
 */
export type GameAssetKind = 'game-image' | 'bios' | 'firmware' | 'support-file';

export interface GameAssetRequirement {
  readonly kind: GameAssetKind;
  /** Registry-relative file name, or an absolute URL for a shared asset such as a BIOS. */
  readonly assetId: string;
  readonly sizeBytes: number | null;
  readonly required: boolean;
  /** Human label for multi-disc images; null for single-asset games. */
  readonly label: string | null;
}

/**
 * Milestone 11.17's vocabulary. Phase 11 ships the *declaration* only — the
 * recording, verification, and playback systems are deferred to Phase 12 by
 * operator decision. Every shipped game therefore declares NONE, because none of
 * the three emulator backends exposes input, state, or score across its iframe
 * boundary. Declaring anything else here would be the exact false capability
 * claim Milestones 11.4 and 11.20 warn against.
 */
export type ReplayCapability =
  | 'NONE' | 'INPUT_LOG' | 'INPUT_AND_SEED' | 'SAVE_STATE_AND_INPUT'
  | 'DETERMINISTIC_REPLAY' | 'VIDEO_ONLY' | 'CUSTOM';

export const REPLAY_CAPABILITIES: readonly ReplayCapability[] = Object.freeze([
  'NONE', 'INPUT_LOG', 'INPUT_AND_SEED', 'SAVE_STATE_AND_INPUT', 'DETERMINISTIC_REPLAY', 'VIDEO_ONLY', 'CUSTOM'
]);

export interface GameDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly platformId: string;
  readonly launcherAdapterId: string;
  readonly emulatorAdapterId?: string;
  readonly assetRequirements: readonly GameAssetRequirement[];
  readonly inputProfileId: string;
  readonly replayCapability: ReplayCapability;
  /**
   * How many players share one cabinet. One unless the game says otherwise, so
   * every existing entry keeps meaning what it meant.
   */
  readonly maxPlayers: number;
  /** Below this the match will not start. A versus game is not playable alone. */
  readonly minPlayers: number;
  readonly leaderboardIds?: readonly string[];
  readonly enabled: boolean;
  readonly metadata?: Record<string, SafeJsonValue>;
}

const ID_PATTERN = /^[a-z0-9-]{2,64}$/;
const FILE_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface GameDefinitionIssue { readonly gameId: string; readonly problem: string }

export function isGameDefinitionIssue(value: GameDefinition | GameDefinitionIssue): value is GameDefinitionIssue {
  return 'problem' in value;
}

export function toGameDefinition(value: unknown): GameDefinition | GameDefinitionIssue {
  if (!value || typeof value !== 'object') return { gameId: '<non-object>', problem: 'entry is not an object' };
  const row = value as Record<string, unknown>;
  const id = row.id;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return { gameId: String(id ?? '<missing>'), problem: 'id must match /^[a-z0-9-]{2,64}$/' };

  const displayName = typeof row.name === 'string' ? row.name : row.displayName;
  if (typeof displayName !== 'string' || !displayName || displayName.length > 80) {
    return { gameId: id, problem: 'name must be a string of at most 80 characters' };
  }
  const platformId = row.platformId ?? row.system;
  if (typeof platformId !== 'string' || !ID_PATTERN.test(platformId)) return { gameId: id, problem: 'platformId must match /^[a-z0-9-]{2,64}$/' };

  const launcherAdapterId = row.launcherAdapterId;
  if (typeof launcherAdapterId !== 'string' || !ID_PATTERN.test(launcherAdapterId)) {
    return { gameId: id, problem: 'launcherAdapterId must match /^[a-z0-9-]{2,64}$/' };
  }
  const emulatorAdapterId = row.emulatorAdapterId;
  if (emulatorAdapterId !== undefined && (typeof emulatorAdapterId !== 'string' || !ID_PATTERN.test(emulatorAdapterId))) {
    return { gameId: id, problem: 'emulatorAdapterId must match /^[a-z0-9-]{2,64}$/' };
  }
  const inputProfileId = row.inputProfileId;
  if (typeof inputProfileId !== 'string' || !ID_PATTERN.test(inputProfileId)) {
    return { gameId: id, problem: 'inputProfileId must match /^[a-z0-9-]{2,64}$/' };
  }
  const replayCapability = row.replayCapability ?? 'NONE';
  if (!REPLAY_CAPABILITIES.includes(replayCapability as ReplayCapability)) {
    return { gameId: id, problem: `replayCapability must be one of ${REPLAY_CAPABILITIES.join(', ')}` };
  }
  const maxPlayers = row.maxPlayers ?? 1;
  if (!Number.isSafeInteger(maxPlayers) || (maxPlayers as number) < 1 || (maxPlayers as number) > 8) {
    return { gameId: id, problem: 'maxPlayers must be an integer between 1 and 8' };
  }
  const minPlayers = row.minPlayers ?? 1;
  if (!Number.isSafeInteger(minPlayers) || (minPlayers as number) < 1 || (minPlayers as number) > (maxPlayers as number)) {
    return { gameId: id, problem: 'minPlayers must be an integer between 1 and maxPlayers' };
  }
  if (typeof row.enabled !== 'boolean') return { gameId: id, problem: 'enabled must be a boolean' };
  if (!isSafeMetadata(row.metadata)) return { gameId: id, problem: 'metadata must be a plain JSON object' };

  const assetRequirements = toAssetRequirements(row.assetRequirements);
  if (assetRequirements === undefined) return { gameId: id, problem: 'assetRequirements is malformed' };

  const leaderboardIds = row.leaderboardIds;
  if (leaderboardIds !== undefined && (!Array.isArray(leaderboardIds) || !leaderboardIds.every((entry) => typeof entry === 'string' && ID_PATTERN.test(entry)))) {
    return { gameId: id, problem: 'leaderboardIds must be an array of IDs' };
  }

  return Object.freeze({
    id,
    displayName,
    platformId,
    launcherAdapterId,
    ...(emulatorAdapterId ? { emulatorAdapterId } : {}),
    assetRequirements,
    inputProfileId,
    replayCapability: replayCapability as ReplayCapability,
    maxPlayers: maxPlayers as number,
    minPlayers: minPlayers as number,
    ...(leaderboardIds ? { leaderboardIds: Object.freeze([...leaderboardIds as string[]]) } : {}),
    enabled: row.enabled,
    ...(row.metadata ? { metadata: row.metadata as Record<string, SafeJsonValue> } : {})
  });
}

function toAssetRequirements(value: unknown): readonly GameAssetRequirement[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const requirements: GameAssetRequirement[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return undefined;
    const row = entry as Record<string, unknown>;
    const kind = row.kind;
    if (kind !== 'game-image' && kind !== 'bios' && kind !== 'firmware' && kind !== 'support-file') return undefined;
    const assetId = row.assetId;
    // A bare file name stays inside the asset root; an absolute https URL is a
    // shared asset. Anything else — "../", a bare path, a data: URL — is refused
    // here so no traversal reaches the asset resolver.
    if (typeof assetId !== 'string' || !(FILE_PATTERN.test(assetId) || isHttpsUrl(assetId))) return undefined;
    const sizeBytes = row.sizeBytes ?? null;
    if (sizeBytes !== null && (!Number.isSafeInteger(sizeBytes) || (sizeBytes as number) <= 0)) return undefined;
    const label = row.label ?? null;
    if (label !== null && (typeof label !== 'string' || label.length > 24)) return undefined;
    if (typeof row.required !== 'boolean') return undefined;
    requirements.push(Object.freeze({ kind, assetId, sizeBytes: sizeBytes as number | null, required: row.required, label: label as string | null }));
  }
  return Object.freeze(requirements);
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}
