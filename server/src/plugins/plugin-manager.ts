import type { ArcadePluginManifest, PluginCapability, PluginLifecycleStatus, PluginPermission } from '../../../shared/plugin-contracts.js';
import type { Logger } from '../logging/logger.js';
import { InMemoryPluginStorage, type PluginStorage } from './plugin-storage.js';
import { requiresPermission, validatePluginManifest } from './plugin-manifest.js';

export type PluginStopReason = 'shutdown' | 'restart' | 'disabled' | 'failure';
export interface PluginContext {
  pluginId: string;
  storage: PluginStorage;
  logger: Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;
  register<T>(capability: PluginCapability, id: string, value: T): void;
}
export interface ArcadePlugin {
  manifest: ArcadePluginManifest;
  initialize(context: PluginContext): Promise<void>;
  start(): Promise<void>;
  stop(reason: PluginStopReason): Promise<void>;
  dispose(): Promise<void>;
}
export interface PluginRecord { id: string; version: string; status: PluginLifecycleStatus; critical: boolean; error?: string }
export type PluginFactory = (manifest: ArcadePluginManifest) => ArcadePlugin;

/** Approved factories only: no remote entrypoints, arbitrary paths, or player-provided code. */
export class PluginManager {
  private readonly records = new Map<string, PluginRecord>();
  private readonly plugins = new Map<string, ArcadePlugin>();
  private readonly registrations = new Map<string, Map<string, unknown>>();
  constructor(private readonly logger: Logger) {}

  async install(rawManifest: unknown, factory: PluginFactory): Promise<PluginRecord> {
    const manifest = validatePluginManifest(rawManifest);
    if (this.records.has(manifest.id)) throw new Error(`Duplicate plugin registration: ${manifest.id}`);
    for (const dependency of manifest.dependencies ?? []) {
      const installed = this.records.get(dependency.id);
      if (!installed || installed.version !== dependency.version || installed.status !== 'started') throw new Error(`Missing plugin dependency: ${dependency.id}@${dependency.version}`);
    }
    const record: PluginRecord = { id: manifest.id, version: manifest.version, status: 'validated', critical: manifest.critical ?? false };
    this.records.set(manifest.id, record);
    const plugin = factory(manifest);this.plugins.set(manifest.id, plugin);
    try {
      await plugin.initialize(this.context(manifest));record.status = 'initialized';
      await plugin.start();record.status = 'started';this.logger.info('plugin_started', { pluginId: manifest.id, version: manifest.version });
    } catch (error) {
      record.status = 'failed';record.error = safeError(error);this.logger.error('plugin_failed', { pluginId: manifest.id, errorMessage: record.error });
      try { await plugin.dispose(); } catch { /* original failure is authoritative */ }
      if (record.critical) throw error;
    }
    return { ...record };
  }

  async stop(pluginId: string, reason: PluginStopReason = 'disabled'): Promise<PluginRecord | undefined> {
    const record = this.records.get(pluginId), plugin = this.plugins.get(pluginId);if (!record || !plugin) return undefined;
    if (!['stopped','disposed','disabled'].includes(record.status)) await plugin.stop(reason);
    record.status = reason === 'disabled' ? 'disabled' : 'stopped';this.logger.info('plugin_stopped', { pluginId, reason });return { ...record };
  }
  async disposeAll(): Promise<void> { for (const [id, plugin] of this.plugins) { await this.stop(id, 'shutdown');await plugin.dispose();this.records.get(id)!.status = 'disposed'; } }
  list(): PluginRecord[] { return [...this.records.values()].map((record) => ({ ...record })); }
  registrationsFor(capability: PluginCapability): ReadonlyMap<string, unknown> { return this.registrations.get(capability) ?? new Map(); }

  private context(manifest: ArcadePluginManifest): PluginContext {
    const allowed = new Set<PluginPermission>(manifest.permissions);
    return {
      pluginId: manifest.id, storage: new InMemoryPluginStorage(manifest.id),
      logger: {
        debug: (event, fields) => this.logger.debug(event, { ...fields, pluginId: manifest.id }),
        info: (event, fields) => this.logger.info(event, { ...fields, pluginId: manifest.id }),
        warn: (event, fields) => this.logger.warn(event, { ...fields, pluginId: manifest.id }),
        error: (event, fields) => this.logger.error(event, { ...fields, pluginId: manifest.id })
      },
      register: <T>(capability: PluginCapability, id: string, value: T) => {
        const permission = requiresPermission(capability);if (!allowed.has(permission)) throw new Error(`Plugin lacks permission: ${permission}`);
        let registrations = this.registrations.get(capability);if (!registrations) { registrations = new Map();this.registrations.set(capability, registrations); }
        if (registrations.has(id)) throw new Error(`Duplicate ${capability} registration: ${id}`);registrations.set(id, value);
      }
    };
  }
}

function safeError(error: unknown): string { return error instanceof Error ? error.message.slice(0, 300) : 'Plugin failed.'; }
