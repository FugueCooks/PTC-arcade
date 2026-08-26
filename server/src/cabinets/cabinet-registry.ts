import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { CabinetDefinition as CabinetDomainDefinition, SafeJson } from '../../../shared/platform-contracts.js';

export interface CabinetPoint { x: number; y: number; z: number }
interface LegacyCabinetDefinition {
  id: string; name: string; sceneKey: string; enabled: boolean;
  interactionPosition: CabinetPoint; playerPosition: CabinetPoint; playerRotationY: number;
  defaultGameId?: string; system?: string; emulatorId?: string;
  zoneId?: string; cabinetType?: string; interactionPolicy?: 'standard' | 'disabled' | 'competitive';
}

/** Compatibility alias retained while older managers still read `name`. */
export type CabinetDefinition = CabinetDomainDefinition & { name: string; system?: string; emulatorId?: string };

/** One approved registry is consumed by both the browser and authoritative server. */
export const CABINET_REGISTRY: readonly CabinetDefinition[] = loadRegistry();

function loadRegistry(): CabinetDefinition[] {
  const registryPath = path.resolve(process.cwd(), 'assets', 'cabinets', 'registry.json');
  const parsed: unknown = JSON.parse(readFileSync(registryPath, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('Cabinet registry must be an array.');
  const ids = new Set<string>();
  return parsed.map((candidate) => {
    if (!isDefinition(candidate) || ids.has(candidate.id)) throw new Error('Cabinet registry contains an invalid or duplicate ID.');
    ids.add(candidate.id);
    const definition: CabinetDefinition = {
      id: candidate.id,
      name: candidate.name,
      displayName: candidate.name,
      sceneKey: candidate.sceneKey,
      cabinetType: candidate.cabinetType ?? cabinetType(candidate.id),
      gameId: candidate.defaultGameId ?? `unassigned:${candidate.id}`,
      zoneId: candidate.zoneId ?? zoneId(candidate),
      enabled: candidate.enabled,
      interactionPosition: candidate.interactionPosition,
      playerPosition: candidate.playerPosition,
      playerRotationY: candidate.playerRotationY,
      interactionPolicy: candidate.interactionPolicy ?? (candidate.enabled ? 'standard' : 'disabled'),
      metadata: compactMetadata(candidate.system, candidate.emulatorId),
      system: candidate.system,
      emulatorId: candidate.emulatorId
    };
    return Object.freeze(definition);
  });
}

function isDefinition(value: unknown): value is LegacyCabinetDefinition {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<LegacyCabinetDefinition>;
  return typeof candidate.id === 'string' && /^[a-z0-9-]+$/.test(candidate.id)
    && typeof candidate.name === 'string' && typeof candidate.sceneKey === 'string'
    && typeof candidate.enabled === 'boolean' && isPoint(candidate.interactionPosition)
    && isPoint(candidate.playerPosition) && Number.isFinite(candidate.playerRotationY)
    && (candidate.system === undefined || typeof candidate.system === 'string')
    && (candidate.emulatorId === undefined || typeof candidate.emulatorId === 'string');
}

function isPoint(value: unknown): value is CabinetPoint {
  if (!value || typeof value !== 'object') return false;
  const point = value as Partial<CabinetPoint>;
  return [point.x, point.y, point.z].every(Number.isFinite);
}

function zoneId(definition: LegacyCabinetDefinition): string {
  if (definition.id.startsWith('megaman-')) return 'megaman-room';
  if (definition.id.startsWith('n64-')) return 'n64-room';
  if (definition.id.startsWith('gamecube-')) return 'gamecube-room';
  if (definition.id.startsWith('ps2-')) return 'ps2-room';
  if (definition.id.startsWith('xbox-')) return 'xbox-room';
  if (definition.system === 'psx' || ['crash-bandicoot', 'gex-enter-the-gecko'].includes(definition.id)) return 'playstation-room';
  return 'main-social';
}

function cabinetType(id: string): string {
  return ['crash-bandicoot', 'gex-enter-the-gecko'].includes(id) ? 'themed-upright' : 'standard-upright';
}

function compactMetadata(system?: string, emulatorId?: string): Record<string, SafeJson> | undefined {
  const metadata: Record<string, SafeJson> = {};
  if (system) metadata.legacySystem = system;
  if (emulatorId) metadata.legacyEmulatorId = emulatorId;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}
