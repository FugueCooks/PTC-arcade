import type { SafeJsonValue } from '../domain/json-value.js';
import { PluginContext, type PluginHostServices } from './plugin-context.js';
import {
  PLUGIN_API_VERSION, satisfiesDependency, validateConfiguration, validateManifest,
  type ArcadePluginManifest
} from './plugin-manifest.js';
import { PluginPermissionSet } from './plugin-permissions.js';
import { InMemoryPluginStorageBackend, PluginStorage, type PluginStorageBackend, type PluginStorageQuota } from './plugin-storage.js';

/**
 * Milestone 11.9 — the plugin lifecycle, and 11.7's controlled registration.
 *
 * The rule that shapes this file: a noncritical plugin failure must never take
 * the arcade down. Every call into plugin code is wrapped, a failure moves that
 * plugin to FAILED and records the reason, and the host keeps going. Only a
 * plugin explicitly marked `critical` in its manifest turns its own failure
 * into a startup failure.
 *
 * Plugins are supplied by the operator as already-resolved objects. There is no
 * discovery-by-URL and no dynamic import of a remote path anywhere in this
 * file: "install a plugin" is an operator action against local code, which is
 * what keeps Milestone 11.7's no-arbitrary-remote-code rule true.
 */
export type PluginLifecycleStatus =
  | 'discovered' | 'validated' | 'initialized' | 'started'
  | 'stopped' | 'disposed' | 'failed' | 'disabled';

export type PluginStopReason = 'shutdown' | 'operator-action' | 'dependency-failed' | 'error';

export interface ArcadePlugin {
  readonly manifest: unknown;
  initialize(context: PluginContext): Promise<void> | void;
  start(): Promise<void> | void;
  stop(reason: PluginStopReason): Promise<void> | void;
  dispose(): Promise<void> | void;
}

export interface PluginRecord {
  readonly id: string;
  readonly manifest: ArcadePluginManifest;
  status: PluginLifecycleStatus;
  error: string | null;
  readonly context: PluginContext | null;
}

export interface PluginInstallation {
  plugin: ArcadePlugin;
  /** Operator-supplied configuration, validated against the manifest schema. */
  configuration?: Record<string, SafeJsonValue>;
  /** Operator approval. An unapproved plugin is never initialized. */
  approved?: boolean;
}

type Logger = (level: 'info' | 'warn' | 'error', event: string, details: Record<string, unknown>) => void;

const noopLogger: Logger = () => undefined;

export interface PluginHostOptions {
  services: PluginHostServices;
  storageBackend?: PluginStorageBackend;
  quota?: PluginStorageQuota;
  apiVersion?: string;
  logger?: Logger;
}

export class CriticalPluginError extends Error {
  constructor(readonly pluginId: string, readonly problem: string) {
    super(`Critical plugin ${pluginId} failed: ${problem}`);
    this.name = 'CriticalPluginError';
  }
}

export class PluginHost {
  private readonly records = new Map<string, {
    manifest: ArcadePluginManifest;
    plugin: ArcadePlugin;
    status: PluginLifecycleStatus;
    error: string | null;
    context: PluginContext | null;
    storage: PluginStorage;
  }>();
  private readonly storageBackend: PluginStorageBackend;
  private readonly quota: PluginStorageQuota | undefined;
  private readonly apiVersion: string;
  private readonly logger: Logger;

  constructor(private readonly options: PluginHostOptions) {
    this.storageBackend = options.storageBackend ?? new InMemoryPluginStorageBackend();
    this.quota = options.quota;
    this.apiVersion = options.apiVersion ?? PLUGIN_API_VERSION;
    this.logger = options.logger ?? noopLogger;
  }

  get size(): number { return this.records.size; }

  list(): readonly PluginRecord[] {
    return [...this.records.values()].map(({ manifest, status, error, context }) => ({
      id: manifest.id, manifest, status, error, context
    }));
  }

  get(pluginId: string): PluginRecord | undefined {
    return this.list().find((record) => record.id === pluginId);
  }

  statusOf(pluginId: string): PluginLifecycleStatus | undefined { return this.records.get(pluginId)?.status; }

  /**
   * Validates and registers a plugin. Returns the problems rather than throwing
   * for a noncritical plugin, so one bad manifest never stops the rest loading.
   */
  install(installation: PluginInstallation): { ok: boolean; problems: readonly string[] } {
    const validation = validateManifest(installation.plugin?.manifest, this.apiVersion);
    if (!validation.ok || !validation.manifest) {
      this.logger('warn', 'plugin_rejected', { problems: validation.problems });
      return { ok: false, problems: validation.problems };
    }
    const manifest = validation.manifest;

    if (this.records.has(manifest.id)) {
      // Milestone 11.8: duplicate registration prevention.
      const problem = `plugin ${manifest.id} is already installed`;
      this.logger('warn', 'plugin_rejected', { pluginId: manifest.id, problems: [problem] });
      return { ok: false, problems: [problem] };
    }

    const dependencyProblems = this.checkDependencies(manifest);
    if (dependencyProblems.length > 0) {
      this.logger('warn', 'plugin_rejected', { pluginId: manifest.id, problems: dependencyProblems });
      return { ok: false, problems: dependencyProblems };
    }

    const configuration = validateConfiguration(manifest.configurationSchema, installation.configuration);
    if (!configuration.ok) {
      this.logger('warn', 'plugin_rejected', { pluginId: manifest.id, problems: configuration.problems });
      return { ok: false, problems: configuration.problems };
    }

    // Milestone 11.7: plugins are installed and approved by the operator. An
    // unapproved plugin is recorded as disabled and never initialized.
    const approved = installation.approved !== false;
    const storage = new PluginStorage(manifest.id, this.storageBackend, this.quota);
    const context = new PluginContext(
      manifest,
      Object.freeze(configuration.configuration),
      storage,
      new PluginPermissionSet(manifest.id, manifest.permissions),
      this.options.services,
      this.logger
    );

    this.records.set(manifest.id, {
      manifest,
      plugin: installation.plugin,
      status: approved ? 'validated' : 'disabled',
      error: approved ? null : 'not approved by operator',
      context,
      storage
    });
    this.logger('info', approved ? 'plugin_validated' : 'plugin_disabled', { pluginId: manifest.id, version: manifest.version });
    return { ok: true, problems: [] };
  }

  /**
   * Initializes and starts every approved plugin. A noncritical failure is
   * contained and reported; a critical one is rethrown so startup can refuse.
   */
  async startAll(): Promise<void> {
    for (const record of this.records.values()) {
      if (record.status !== 'validated') continue;
      const started = await this.#runLifecycle(record.manifest.id, async () => {
        await record.plugin.initialize(record.context!);
        record.status = 'initialized';
        await record.plugin.start();
        record.status = 'started';
      });
      if (!started && record.manifest.critical === true) {
        throw new CriticalPluginError(record.manifest.id, record.error ?? 'unknown failure');
      }
    }
  }

  /** Stops and disposes everything. Used on drain; never throws. */
  async stopAll(reason: PluginStopReason = 'shutdown'): Promise<void> {
    for (const record of this.records.values()) {
      if (record.status !== 'started') continue;
      await this.#runLifecycle(record.manifest.id, async () => {
        await record.plugin.stop(reason);
        record.status = 'stopped';
        await record.plugin.dispose();
        record.status = 'disposed';
      });
    }
  }

  /** Operator action: stop one plugin without touching the others. */
  async disable(pluginId: string, reason: PluginStopReason = 'operator-action'): Promise<boolean> {
    const record = this.records.get(pluginId);
    if (!record || record.status === 'disabled') return false;
    if (record.status === 'started') {
      await this.#runLifecycle(pluginId, async () => {
        await record.plugin.stop(reason);
        await record.plugin.dispose();
      });
    }
    record.status = 'disabled';
    this.logger('info', 'plugin_disabled', { pluginId, reason });
    return true;
  }

  /** Operator action: a safe restart, from whatever state the plugin is in. */
  async restart(pluginId: string): Promise<boolean> {
    const record = this.records.get(pluginId);
    if (!record) return false;
    if (record.status === 'started') {
      await this.#runLifecycle(pluginId, async () => {
        await record.plugin.stop('operator-action');
        await record.plugin.dispose();
      });
    }
    record.error = null;
    record.status = 'validated';
    const ok = await this.#runLifecycle(pluginId, async () => {
      await record.plugin.initialize(record.context!);
      record.status = 'initialized';
      await record.plugin.start();
      record.status = 'started';
    });
    this.logger('info', 'plugin_restarted', { pluginId, ok });
    return ok;
  }

  /** Removes a plugin and erases its storage namespace. */
  async uninstall(pluginId: string): Promise<boolean> {
    const record = this.records.get(pluginId);
    if (!record) return false;
    await this.disable(pluginId, 'operator-action');
    await record.storage.clear();
    this.records.delete(pluginId);
    this.logger('info', 'plugin_uninstalled', { pluginId });
    return true;
  }

  /** Operator- and dashboard-facing view. */
  health(): { total: number; started: number; failed: number; disabled: number; failures: Array<{ pluginId: string; error: string }> } {
    const records = [...this.records.values()];
    return {
      total: records.length,
      started: records.filter(({ status }) => status === 'started').length,
      failed: records.filter(({ status }) => status === 'failed').length,
      disabled: records.filter(({ status }) => status === 'disabled').length,
      failures: records
        .filter((record) => record.status === 'failed' && record.error !== null)
        .map((record) => ({ pluginId: record.manifest.id, error: record.error! }))
    };
  }

  private checkDependencies(manifest: ArcadePluginManifest): string[] {
    const problems: string[] = [];
    for (const dependency of manifest.dependencies ?? []) {
      const installed = this.records.get(dependency.id);
      if (!installed) { problems.push(`missing dependency ${dependency.id}@${dependency.version}`); continue; }
      if (!satisfiesDependency(installed.manifest.version, dependency.version)) {
        problems.push(`dependency ${dependency.id}@${installed.manifest.version} does not satisfy ${dependency.version}`);
      }
    }
    return problems;
  }

  /**
   * The containment boundary. Plugin code runs only inside here, so a throw or
   * a rejected promise marks that plugin failed and returns false rather than
   * propagating into the arcade.
   */
  async #runLifecycle(pluginId: string, run: () => Promise<void>): Promise<boolean> {
    const record = this.records.get(pluginId);
    if (!record) return false;
    try {
      await run();
      record.error = null;
      return true;
    } catch (error) {
      record.status = 'failed';
      record.error = error instanceof Error ? error.message : String(error);
      this.logger('error', 'plugin_failed', { pluginId, error: record.error });
      return false;
    }
  }
}
