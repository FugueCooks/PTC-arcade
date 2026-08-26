import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isCabinetDefinitionIssue, toCabinetDefinition, type CabinetDefinition, type Vector3Data } from '../domain/cabinet-definition.js';

export type { CabinetDefinition } from '../domain/cabinet-definition.js';
/** Retained name for the pre-Phase-11 point type. */
export type CabinetPoint = Vector3Data;

/** One approved registry is consumed by both the browser and authoritative server. */
export const CABINET_REGISTRY: readonly CabinetDefinition[] = loadRegistry();

export interface CabinetRegistryLoadResult {
  definitions: readonly CabinetDefinition[];
  issues: readonly string[];
}

/**
 * Reads and validates the registry file. Every malformed row is collected rather
 * than throwing on the first, so a large registry reports all its problems in one
 * pass — the module-level export below still refuses to start on any issue.
 */
export function readCabinetRegistry(projectRoot: string = process.cwd()): CabinetRegistryLoadResult {
  const registryPath = path.resolve(projectRoot, 'assets', 'cabinets', 'registry.json');
  const parsed: unknown = JSON.parse(readFileSync(registryPath, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('Cabinet registry must be an array.');

  const definitions: CabinetDefinition[] = [];
  const issues: string[] = [];
  const seen = new Set<string>();

  for (const row of parsed) {
    const candidate = toCabinetDefinition(row);
    if (isCabinetDefinitionIssue(candidate)) {
      issues.push(`${candidate.cabinetId}: ${candidate.problem}`);
      continue;
    }
    if (seen.has(candidate.id)) {
      issues.push(`${candidate.id}: duplicate cabinet ID`);
      continue;
    }
    seen.add(candidate.id);
    definitions.push(candidate);
  }
  return { definitions, issues };
}

function loadRegistry(): readonly CabinetDefinition[] {
  const { definitions, issues } = readCabinetRegistry();
  if (issues.length > 0) throw new Error(`Cabinet registry is invalid:\n  ${issues.join('\n  ')}`);
  return Object.freeze(definitions);
}
