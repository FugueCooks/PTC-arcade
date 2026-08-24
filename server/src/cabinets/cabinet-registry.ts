import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface CabinetPoint { x: number; y: number; z: number }
export interface CabinetDefinition {
  id: string; name: string; sceneKey: string; enabled: boolean;
  interactionPosition: CabinetPoint; playerPosition: CabinetPoint; playerRotationY: number;
  defaultGameId?: string; system?: string; emulatorId?: string;
}

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
    return Object.freeze(candidate);
  });
}

function isDefinition(value: unknown): value is CabinetDefinition {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CabinetDefinition>;
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
