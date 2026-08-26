/**
 * Milestone 11.10 — the complete set of things a plugin may ask for.
 *
 * This is an allowlist, and it is the whole security model: a capability that
 * is not named here cannot be requested, granted, or exercised. Note what is
 * absent by design — there is no permission for a database client, a Redis
 * client, the filesystem, session cookies, wallet signatures, private keys,
 * environment secrets, ROM files, or raw authentication tokens. Plugins reach
 * the platform only through the narrow services on PluginContext.
 */
export const PLUGIN_PERMISSIONS = Object.freeze([
  'register:cabinet-type',
  'register:game',
  'register:emulator-adapter',
  'register:world-interaction',
  'register:api-route',
  'register:socket-event',
  'register:dashboard-widget',
  'register:scheduled-job',
  'read:player-safe-profile',
  'read:room-state',
  'write:plugin-storage',
  'emit:room-event'
] as const);

export type PluginPermission = typeof PLUGIN_PERMISSIONS[number];

export function isPluginPermission(value: unknown): value is PluginPermission {
  return typeof value === 'string' && (PLUGIN_PERMISSIONS as readonly string[]).includes(value);
}

export class PluginPermissionError extends Error {
  constructor(readonly pluginId: string, readonly permission: PluginPermission) {
    super(`Plugin ${pluginId} lacks permission ${permission}.`);
    this.name = 'PluginPermissionError';
  }
}

/**
 * Enforcement point. Every capability a plugin exercises passes through
 * `require`, so a missing grant fails loudly at the call rather than being
 * checked once at load and then trusted.
 */
export class PluginPermissionSet {
  private readonly granted: ReadonlySet<PluginPermission>;

  constructor(readonly pluginId: string, granted: readonly PluginPermission[]) {
    this.granted = new Set(granted);
  }

  has(permission: PluginPermission): boolean { return this.granted.has(permission); }

  require(permission: PluginPermission): void {
    if (!this.granted.has(permission)) throw new PluginPermissionError(this.pluginId, permission);
  }

  list(): readonly PluginPermission[] { return [...this.granted].sort(); }
}
