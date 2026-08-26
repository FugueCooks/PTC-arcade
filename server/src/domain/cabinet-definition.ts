import { isSafeMetadata, type SafeJsonValue } from './json-value.js';

/**
 * Milestone 11.1 — a cabinet definition describes *what a cabinet is*, never how
 * an emulator works. Nothing here may hold a Three.js object, a DOM node, an
 * emulator instance, or a socket: those belong to the four sibling concerns
 * (room state, scene object, game session, emulator adapter) that this type is
 * deliberately separated from.
 */
export interface Vector3Data { readonly x: number; readonly y: number; readonly z: number }

export interface CabinetScreenConfiguration {
  readonly widthMeters: number;
  readonly heightMeters: number;
  readonly offset: Vector3Data;
  readonly rotationY: number;
}

export interface CabinetInteractionPolicy {
  /** Metres from `interactionPosition` within which a player may request the cabinet. */
  readonly interactionDistance: number;
  /** Milliseconds a reservation survives without activation, or null for the manager default. */
  readonly activationTimeoutMs: number | null;
  /** False only for scenery a player may look at but never occupy. */
  readonly requiresOwnership: boolean;
}

export interface CabinetDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly cabinetType: string;
  /**
   * Deviation from the Phase 11 brief, which types this as a required string:
   * 10 of the 39 shipped cabinets are unassigned placeholders ("XBOX // READY 01").
   * Modelling that as null is honest; inventing filler game IDs to satisfy the
   * type would make `GameRegistry.get()` lie.
   */
  readonly gameId: string | null;
  readonly zoneId: string;
  readonly enabled: boolean;
  readonly interactionPosition: Vector3Data;
  readonly playerPosition: Vector3Data;
  readonly playerRotationY: number;
  readonly modelAssetId?: string;
  readonly marqueeAssetId?: string;
  readonly screenConfiguration?: CabinetScreenConfiguration;
  readonly interactionPolicy: CabinetInteractionPolicy;
  readonly competitivePolicyId?: string;
  readonly pluginId?: string;
  readonly metadata?: Record<string, SafeJsonValue>;
}

export const DEFAULT_INTERACTION_POLICY: CabinetInteractionPolicy = Object.freeze({
  interactionDistance: 2.6,
  activationTimeoutMs: null,
  requiresOwnership: true
});

const ID_PATTERN = /^[a-z0-9-]{2,64}$/;

export function isVector3Data(value: unknown): value is Vector3Data {
  if (!value || typeof value !== 'object') return false;
  const point = value as Partial<Vector3Data>;
  return [point.x, point.y, point.z].every((component) => typeof component === 'number' && Number.isFinite(component));
}

export interface CabinetDefinitionIssue { readonly cabinetId: string; readonly problem: string }

/**
 * Maps one validated registry row onto the domain type. Returns an issue rather
 * than throwing so a large registry can report every bad row in one pass instead
 * of failing on the first.
 */
export function toCabinetDefinition(value: unknown): CabinetDefinition | CabinetDefinitionIssue {
  if (!value || typeof value !== 'object') return { cabinetId: '<non-object>', problem: 'entry is not an object' };
  const row = value as Record<string, unknown>;
  const id = row.id;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return { cabinetId: String(id ?? '<missing>'), problem: 'id must match /^[a-z0-9-]{2,64}$/' };

  const displayName = typeof row.name === 'string' ? row.name : undefined;
  if (!displayName || displayName.length > 80) return { cabinetId: id, problem: 'name must be a string of at most 80 characters' };

  const cabinetType = row.cabinetType;
  if (typeof cabinetType !== 'string' || !ID_PATTERN.test(cabinetType)) return { cabinetId: id, problem: 'cabinetType must match /^[a-z0-9-]{2,64}$/' };

  const zoneId = row.zoneId;
  if (typeof zoneId !== 'string' || !ID_PATTERN.test(zoneId)) return { cabinetId: id, problem: 'zoneId must match /^[a-z0-9-]{2,64}$/' };

  const rawGameId = row.gameId ?? row.defaultGameId ?? null;
  if (rawGameId !== null && (typeof rawGameId !== 'string' || !ID_PATTERN.test(rawGameId))) {
    return { cabinetId: id, problem: 'gameId must be null or match /^[a-z0-9-]{2,64}$/' };
  }
  if (typeof row.enabled !== 'boolean') return { cabinetId: id, problem: 'enabled must be a boolean' };
  if (!isVector3Data(row.interactionPosition)) return { cabinetId: id, problem: 'interactionPosition must be a finite vector' };
  if (!isVector3Data(row.playerPosition)) return { cabinetId: id, problem: 'playerPosition must be a finite vector' };
  if (typeof row.playerRotationY !== 'number' || !Number.isFinite(row.playerRotationY)) {
    return { cabinetId: id, problem: 'playerRotationY must be a finite number' };
  }
  if (!isSafeMetadata(row.metadata)) return { cabinetId: id, problem: 'metadata must be a plain JSON object' };

  const policy = toInteractionPolicy(row.interactionPolicy);
  if (policy === undefined) return { cabinetId: id, problem: 'interactionPolicy is malformed' };

  return Object.freeze({
    id,
    displayName,
    cabinetType,
    gameId: rawGameId,
    zoneId,
    enabled: row.enabled,
    interactionPosition: Object.freeze({ ...row.interactionPosition }),
    playerPosition: Object.freeze({ ...row.playerPosition }),
    playerRotationY: row.playerRotationY,
    ...(typeof row.modelAssetId === 'string' ? { modelAssetId: row.modelAssetId } : {}),
    ...(typeof row.marqueeAssetId === 'string' ? { marqueeAssetId: row.marqueeAssetId } : {}),
    ...(typeof row.competitivePolicyId === 'string' ? { competitivePolicyId: row.competitivePolicyId } : {}),
    ...(typeof row.pluginId === 'string' ? { pluginId: row.pluginId } : {}),
    ...(row.metadata ? { metadata: row.metadata as Record<string, SafeJsonValue> } : {}),
    interactionPolicy: policy
  });
}

export function isCabinetDefinitionIssue(value: CabinetDefinition | CabinetDefinitionIssue): value is CabinetDefinitionIssue {
  return 'problem' in value;
}

function toInteractionPolicy(value: unknown): CabinetInteractionPolicy | undefined {
  if (value === undefined) return DEFAULT_INTERACTION_POLICY;
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  const distance = row.interactionDistance ?? DEFAULT_INTERACTION_POLICY.interactionDistance;
  const timeout = row.activationTimeoutMs ?? null;
  const requiresOwnership = row.requiresOwnership ?? true;
  if (typeof distance !== 'number' || !Number.isFinite(distance) || distance <= 0 || distance > 64) return undefined;
  if (timeout !== null && (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0)) return undefined;
  if (typeof requiresOwnership !== 'boolean') return undefined;
  return Object.freeze({ interactionDistance: distance, activationTimeoutMs: timeout, requiresOwnership });
}
