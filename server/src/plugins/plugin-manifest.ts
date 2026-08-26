import { isSafeMetadata, type SafeJsonValue } from '../domain/json-value.js';
import { isPluginPermission, type PluginPermission } from './plugin-permissions.js';

/**
 * Milestone 11.8 — the versioned plugin manifest.
 *
 * Every field is validated before a plugin is allowed anywhere near the
 * lifecycle. The rules that matter most for safety are the entrypoint checks:
 * an entrypoint must be a relative path inside the plugin's own directory, so
 * a manifest cannot point the loader at a URL, an absolute path, or a parent
 * directory. That is what keeps "install a plugin" from meaning "execute
 * arbitrary remote code".
 */

/** The platform API version plugins compile against. Bump the major on a break. */
export const PLUGIN_API_VERSION = '1.0.0';

export type PluginCapability =
  | 'cabinet-type' | 'game' | 'emulator-adapter' | 'world-interaction'
  | 'ui-panel' | 'api-route' | 'socket-event' | 'scheduled-job'
  | 'leaderboard-adapter' | 'replay-processor' | 'dashboard-module';

const CAPABILITIES: readonly PluginCapability[] = Object.freeze([
  'cabinet-type', 'game', 'emulator-adapter', 'world-interaction', 'ui-panel',
  'api-route', 'socket-event', 'scheduled-job', 'leaderboard-adapter',
  'replay-processor', 'dashboard-module'
]);

export interface PluginDependency {
  readonly id: string;
  /** Exact or caret range, e.g. "1.2.0" or "^1.2.0". */
  readonly version: string;
}

export interface ArcadePluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly description?: string;
  readonly entrypoints: { readonly client?: string; readonly server?: string };
  readonly permissions: readonly PluginPermission[];
  readonly dependencies?: readonly PluginDependency[];
  readonly capabilities: readonly PluginCapability[];
  readonly configurationSchema?: PluginConfigurationSchema;
  /** True when the arcade must refuse to start if this plugin fails. */
  readonly critical?: boolean;
}

/**
 * A deliberately small JSON Schema subset: object types with typed, optionally
 * enumerated and bounded properties. Supporting the full specification would
 * mean shipping a schema engine; this covers plugin configuration and refuses
 * anything it does not understand rather than silently ignoring it.
 */
export interface PluginConfigurationSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, PluginConfigurationProperty>>;
  readonly required?: readonly string[];
}

export interface PluginConfigurationProperty {
  readonly type: 'string' | 'number' | 'boolean';
  readonly enum?: readonly SafeJsonValue[];
  readonly minimum?: number;
  readonly maximum?: number;
  readonly maxLength?: number;
  readonly default?: SafeJsonValue;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-.]+)?$/;
/** Relative, no traversal, no scheme, no leading slash, .js or .mjs only. */
const ENTRYPOINT_PATTERN = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.m?js$/;

export interface ManifestValidationResult {
  ok: boolean;
  manifest?: ArcadePluginManifest;
  problems: readonly string[];
}

export function validateManifest(value: unknown, platformApiVersion = PLUGIN_API_VERSION): ManifestValidationResult {
  const problems: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, problems: ['manifest must be a JSON object'] };
  }
  const row = value as Record<string, unknown>;

  const id = row.id;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) problems.push('id must match /^[a-z0-9][a-z0-9-]{1,63}$/');
  if (typeof row.name !== 'string' || row.name.length === 0 || row.name.length > 80) problems.push('name must be 1-80 characters');
  if (typeof row.version !== 'string' || !SEMVER_PATTERN.test(row.version)) problems.push('version must be semantic versioning');
  if (row.description !== undefined && (typeof row.description !== 'string' || row.description.length > 400)) {
    problems.push('description must be at most 400 characters');
  }
  if (row.critical !== undefined && typeof row.critical !== 'boolean') problems.push('critical must be a boolean');

  if (typeof row.apiVersion !== 'string' || !SEMVER_PATTERN.test(row.apiVersion)) {
    problems.push('apiVersion must be semantic versioning');
  } else if (!isApiVersionCompatible(row.apiVersion, platformApiVersion)) {
    problems.push(`apiVersion ${row.apiVersion} is not supported by platform ${platformApiVersion}`);
  }

  problems.push(...validateEntrypoints(row.entrypoints));

  if (!Array.isArray(row.permissions) || !row.permissions.every(isPluginPermission)) {
    problems.push('permissions must be an array of known permissions');
  }
  if (!Array.isArray(row.capabilities) || row.capabilities.length === 0
    || !row.capabilities.every((entry) => CAPABILITIES.includes(entry as PluginCapability))) {
    problems.push('capabilities must be a non-empty array of known capabilities');
  }
  problems.push(...validateDependencies(row.dependencies));
  problems.push(...validateSchema(row.configurationSchema));

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    problems: [],
    manifest: Object.freeze({
      id: id as string,
      name: row.name as string,
      version: row.version as string,
      apiVersion: row.apiVersion as string,
      ...(row.description ? { description: row.description as string } : {}),
      entrypoints: Object.freeze({ ...(row.entrypoints as object) }),
      permissions: Object.freeze([...(row.permissions as PluginPermission[])]),
      ...(row.dependencies ? { dependencies: Object.freeze([...(row.dependencies as PluginDependency[])]) } : {}),
      capabilities: Object.freeze([...(row.capabilities as PluginCapability[])]),
      ...(row.configurationSchema ? { configurationSchema: row.configurationSchema as PluginConfigurationSchema } : {}),
      ...(row.critical !== undefined ? { critical: row.critical as boolean } : {})
    })
  };
}

/** Same major, and the plugin must not need a minor newer than the platform. */
export function isApiVersionCompatible(required: string, platform: string): boolean {
  const wanted = parseVersion(required);
  const available = parseVersion(platform);
  if (!wanted || !available) return false;
  if (wanted.major !== available.major) return false;
  return wanted.minor < available.minor || (wanted.minor === available.minor && wanted.patch <= available.patch);
}

/** Supports an exact version or a caret range, which is all a manifest may use. */
export function satisfiesDependency(installedVersion: string, requirement: string): boolean {
  const installed = parseVersion(installedVersion);
  if (!installed) return false;
  if (requirement.startsWith('^')) {
    const wanted = parseVersion(requirement.slice(1));
    if (!wanted || wanted.major !== installed.major) return false;
    if (installed.minor > wanted.minor) return true;
    return installed.minor === wanted.minor && installed.patch >= wanted.patch;
  }
  const exact = parseVersion(requirement);
  return exact !== null && exact.major === installed.major && exact.minor === installed.minor && exact.patch === installed.patch;
}

function parseVersion(value: string): { major: number; minor: number; patch: number } | null {
  const matched = SEMVER_PATTERN.exec(value);
  if (!matched) return null;
  return { major: Number(matched[1]), minor: Number(matched[2]), patch: Number(matched[3]) };
}

function validateEntrypoints(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['entrypoints must be an object'];
  const row = value as Record<string, unknown>;
  const problems: string[] = [];
  if (row.client === undefined && row.server === undefined) problems.push('entrypoints must declare a client or server entry');
  for (const side of ['client', 'server'] as const) {
    const entry = row[side];
    if (entry === undefined) continue;
    if (typeof entry !== 'string' || !ENTRYPOINT_PATTERN.test(entry)) {
      // Rejects "../", "/abs", "https://", and anything that is not a .js/.mjs
      // file inside the plugin directory.
      problems.push(`entrypoints.${side} must be a relative .js or .mjs path inside the plugin directory`);
    }
  }
  return problems;
}

function validateDependencies(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return ['dependencies must be an array'];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') { problems.push('each dependency must be an object'); continue; }
    const dependency = entry as Record<string, unknown>;
    if (typeof dependency.id !== 'string' || !ID_PATTERN.test(dependency.id)) { problems.push('dependency id is invalid'); continue; }
    if (seen.has(dependency.id)) problems.push(`duplicate dependency ${dependency.id}`);
    seen.add(dependency.id);
    const version = dependency.version;
    if (typeof version !== 'string' || !SEMVER_PATTERN.test(version.startsWith('^') ? version.slice(1) : version)) {
      problems.push(`dependency ${dependency.id} version must be exact or a caret range`);
    }
  }
  return problems;
}

function validateSchema(value: unknown): string[] {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object') return ['configurationSchema must be an object'];
  const schema = value as Record<string, unknown>;
  if (schema.type !== 'object') return ['configurationSchema.type must be "object"'];
  if (!schema.properties || typeof schema.properties !== 'object') return ['configurationSchema.properties must be an object'];
  const problems: string[] = [];
  for (const [key, property] of Object.entries(schema.properties as Record<string, unknown>)) {
    if (!property || typeof property !== 'object') { problems.push(`property ${key} must be an object`); continue; }
    const typed = property as Record<string, unknown>;
    if (!['string', 'number', 'boolean'].includes(typed.type as string)) problems.push(`property ${key} has an unsupported type`);
    if (typed.enum !== undefined && !Array.isArray(typed.enum)) problems.push(`property ${key} enum must be an array`);
    if (typed.default !== undefined && !isSafeMetadata({ value: typed.default as SafeJsonValue })) problems.push(`property ${key} default must be JSON`);
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every((entry) => typeof entry === 'string'))) {
    problems.push('configurationSchema.required must be an array of strings');
  }
  return problems;
}

export interface ConfigurationValidationResult {
  ok: boolean;
  problems: readonly string[];
  configuration: Record<string, SafeJsonValue>;
}

/**
 * Validates plugin configuration against its declared schema, applying declared
 * defaults. Unknown keys are rejected rather than passed through, so a typo in
 * operator configuration surfaces instead of silently doing nothing.
 */
export function validateConfiguration(schema: PluginConfigurationSchema | undefined, supplied: unknown): ConfigurationValidationResult {
  const configuration: Record<string, SafeJsonValue> = {};
  if (schema === undefined) return { ok: true, problems: [], configuration };
  if (supplied !== undefined && (!supplied || typeof supplied !== 'object' || Array.isArray(supplied))) {
    return { ok: false, problems: ['configuration must be an object'], configuration };
  }
  const input = (supplied ?? {}) as Record<string, unknown>;
  const problems: string[] = [];

  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(schema.properties, key)) problems.push(`unknown configuration key "${key}"`);
  }

  for (const [key, property] of Object.entries(schema.properties)) {
    const provided = input[key];
    if (provided === undefined) {
      if (property.default !== undefined) configuration[key] = property.default;
      else if (schema.required?.includes(key)) problems.push(`missing required configuration "${key}"`);
      continue;
    }
    if (typeof provided !== property.type) { problems.push(`configuration "${key}" must be a ${property.type}`); continue; }
    if (property.enum && !property.enum.includes(provided as SafeJsonValue)) { problems.push(`configuration "${key}" is not an allowed value`); continue; }
    if (property.type === 'number') {
      const numeric = provided as number;
      if (!Number.isFinite(numeric)) { problems.push(`configuration "${key}" must be finite`); continue; }
      if (property.minimum !== undefined && numeric < property.minimum) { problems.push(`configuration "${key}" is below its minimum`); continue; }
      if (property.maximum !== undefined && numeric > property.maximum) { problems.push(`configuration "${key}" is above its maximum`); continue; }
    }
    if (property.type === 'string' && property.maxLength !== undefined && (provided as string).length > property.maxLength) {
      problems.push(`configuration "${key}" is longer than ${property.maxLength}`);
      continue;
    }
    configuration[key] = provided as SafeJsonValue;
  }
  return { ok: problems.length === 0, problems, configuration };
}
