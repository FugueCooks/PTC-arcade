/**
 * Milestone 11.4 — the stable emulator adapter contract.
 *
 * Adapters are split into policy and mechanism. Everything here and in the
 * shipped adapters is *policy*: which iframe to open, what handshake a backend
 * speaks, what it can actually do. The DOM work — creating the iframe, posting
 * messages, tearing it down — is *mechanism*, supplied by the host runtime that
 * the launcher injects. That split is what lets these modules be unit-tested
 * without a browser, and it is why an adapter never touches `document`.
 */

/** Every capability defaults to false: an adapter must opt in, never opt out. */
export const EMULATOR_CAPABILITY_KEYS = Object.freeze([
  'saveStates',
  'inputRecording',
  'deterministicReplay',
  'memoryInspection',
  'screenshotCapture',
  'scoreExtraction',
  'pauseSupport',
  'controllerRemapping',
  'audioControl'
]);

export function createCapabilities(overrides = {}) {
  const unknown = Object.keys(overrides).filter((key) => !EMULATOR_CAPABILITY_KEYS.includes(key));
  if (unknown.length > 0) throw new Error(`Unknown emulator capability: ${unknown.join(', ')}`);
  const capabilities = {};
  for (const key of EMULATOR_CAPABILITY_KEYS) capabilities[key] = overrides[key] === true;
  return Object.freeze(capabilities);
}

export const SESSION_STOP_REASONS = Object.freeze([
  'player-exit', 'cabinet-released', 'disconnect', 'emulator-error',
  'preflight-failed', 'server-drain', 'operator-action', 'timeout'
]);

/**
 * Frame-message interpretations. The launcher switches on `kind`, so a new
 * backend never needs the launcher edited — only its own adapter.
 */
export const FRAME_SIGNALS = Object.freeze({
  READY: 'ready',
  PROGRESS: 'progress',
  SOURCE_ACCEPTED: 'source-accepted',
  SOURCE_LOADING: 'source-loading',
  ERROR: 'error',
  CLOSED: 'closed',
  IGNORE: 'ignore'
});

/**
 * Structural check used at registration time. A misdeclared adapter is refused
 * at startup rather than at the moment a player walks up to a cabinet.
 */
export function assertValidAdapter(adapter) {
  const required = ['id', 'supportedPlatforms', 'capabilities', 'usesSourceHandshake', 'preflight', 'describeFrame', 'interpretMessage', 'warmupAssets', 'createSession', 'start', 'stop', 'dispose'];
  for (const key of required) {
    if (adapter?.[key] === undefined) throw new Error(`Emulator adapter is missing "${key}".`);
  }
  if (typeof adapter.id !== 'string' || !/^[a-z0-9-]{2,64}$/.test(adapter.id)) throw new Error('Emulator adapter id must match /^[a-z0-9-]{2,64}$/.');
  if (!Array.isArray(adapter.supportedPlatforms) || adapter.supportedPlatforms.length === 0) throw new Error(`Adapter ${adapter.id} must support at least one platform.`);
  if (typeof adapter.usesSourceHandshake !== 'boolean') throw new Error(`Adapter ${adapter.id} must declare usesSourceHandshake.`);
  for (const key of EMULATOR_CAPABILITY_KEYS) {
    if (typeof adapter.capabilities[key] !== 'boolean') throw new Error(`Adapter ${adapter.id} does not declare capability "${key}".`);
  }
  for (const method of ['preflight', 'describeFrame', 'interpretMessage', 'warmupAssets', 'createSession', 'start', 'stop', 'dispose']) {
    if (typeof adapter[method] !== 'function') throw new Error(`Adapter ${adapter.id} member "${method}" must be a function.`);
  }
  return adapter;
}

/**
 * Shared preflight: confirm every required asset resolves before an iframe is
 * created. Returns rather than throws so the launcher can report a specific
 * missing asset instead of a generic failure.
 */
export function preflightAssets(context) {
  const missing = [];
  for (const requirement of context.game?.assetRequirements ?? []) {
    if (!requirement.required) continue;
    if (!context.resolveAsset || !context.resolveAsset(requirement)) missing.push(requirement.assetId);
  }
  return missing.length === 0
    ? { ok: true, missingAssets: [] }
    : { ok: false, reason: 'missing-assets', missingAssets: missing };
}

/**
 * The load timeout scales with download size: a 4 GB GameCube image cannot be
 * held to the same deadline as a 30 MB SNES ROM. Preserved verbatim from the
 * pre-Phase-11 launcher so timing behaviour does not shift under the refactor.
 */
export function estimateLoadTimeoutMs(downloadBytes) {
  return Math.max(20_000, Math.min(180_000, 20_000 + (Number(downloadBytes) || 0) / 524_288 * 1_000));
}
