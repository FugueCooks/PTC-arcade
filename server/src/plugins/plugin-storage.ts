import type { SafeJsonValue } from '../domain/json-value.js';
import { isSafeJsonValue } from '../domain/json-value.js';

/**
 * Milestone 11.11 — plugin-scoped storage.
 *
 * Every key a plugin writes is prefixed with its own ID by this layer, and the
 * plugin never sees or supplies the prefix. That is what makes collisions and
 * cross-plugin reads structurally impossible rather than merely discouraged:
 * there is no API through which a plugin can name another plugin's key.
 *
 * Quotas are enforced on entry count and on serialized byte size, so a plugin
 * cannot grow storage without bound.
 */
export const PLUGIN_KEY_PREFIX = 'arcade:plugin';

export interface PluginStorageQuota {
  readonly maxKeys: number;
  readonly maxValueBytes: number;
  readonly maxTotalBytes: number;
}

export const DEFAULT_PLUGIN_QUOTA: PluginStorageQuota = Object.freeze({
  maxKeys: 500,
  maxValueBytes: 64 * 1024,
  maxTotalBytes: 1024 * 1024
});

export class PluginQuotaError extends Error {
  constructor(readonly pluginId: string, reason: string) {
    super(`Plugin ${pluginId} storage quota exceeded: ${reason}`);
    this.name = 'PluginQuotaError';
  }
}

/**
 * The storage mechanism. Phase 11 ships an in-memory implementation and a
 * filesystem one; a Redis or PostgreSQL backend slots in here without any
 * call-site change, which is why plugins are never handed a client directly.
 */
export interface PluginStorageBackend {
  read(namespacedKey: string): Promise<string | undefined>;
  write(namespacedKey: string, value: string): Promise<void>;
  delete(namespacedKey: string): Promise<void>;
  listKeys(namespacePrefix: string): Promise<readonly string[]>;
}

export class InMemoryPluginStorageBackend implements PluginStorageBackend {
  private readonly entries = new Map<string, string>();

  async read(namespacedKey: string): Promise<string | undefined> { return this.entries.get(namespacedKey); }
  async write(namespacedKey: string, value: string): Promise<void> { this.entries.set(namespacedKey, value); }
  async delete(namespacedKey: string): Promise<void> { this.entries.delete(namespacedKey); }
  async listKeys(namespacePrefix: string): Promise<readonly string[]> {
    return [...this.entries.keys()].filter((key) => key.startsWith(namespacePrefix));
  }
}

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * The only storage surface a plugin sees. It holds the plugin's ID and applies
 * it to every operation, so a plugin cannot address anything outside its own
 * namespace even if it tries.
 */
export class PluginStorage {
  constructor(
    private readonly pluginId: string,
    private readonly backend: PluginStorageBackend,
    private readonly quota: PluginStorageQuota = DEFAULT_PLUGIN_QUOTA
  ) {}

  /** `arcade:plugin:{pluginId}:{key}` — the prefix is never caller-supplied. */
  private namespaced(key: string): string {
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
      // Refusing ':' here is what stops a crafted key from escaping the
      // namespace by writing its own prefix separator.
      throw new Error(`Plugin ${this.pluginId} used an invalid storage key.`);
    }
    return `${PLUGIN_KEY_PREFIX}:${this.pluginId}:${key}`;
  }

  private get prefix(): string { return `${PLUGIN_KEY_PREFIX}:${this.pluginId}:`; }

  async get(key: string): Promise<SafeJsonValue | undefined> {
    const raw = await this.backend.read(this.namespaced(key));
    if (raw === undefined) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return isSafeJsonValue(parsed) ? parsed : undefined;
  }

  async set(key: string, value: SafeJsonValue): Promise<void> {
    if (!isSafeJsonValue(value)) throw new Error(`Plugin ${this.pluginId} stored a value that is not plain JSON.`);
    const namespacedKey = this.namespaced(key);
    const serialized = JSON.stringify(value);
    const valueBytes = Buffer.byteLength(serialized, 'utf8');
    if (valueBytes > this.quota.maxValueBytes) throw new PluginQuotaError(this.pluginId, `value exceeds ${this.quota.maxValueBytes} bytes`);

    const existingKeys = await this.backend.listKeys(this.prefix);
    const replacing = existingKeys.includes(namespacedKey);
    if (!replacing && existingKeys.length >= this.quota.maxKeys) {
      throw new PluginQuotaError(this.pluginId, `key count would exceed ${this.quota.maxKeys}`);
    }

    // Total is measured against what storage would hold after the write, so a
    // replacement that shrinks a value is never refused for the old size.
    let total = valueBytes;
    for (const key of existingKeys) {
      if (key === namespacedKey) continue;
      total += Buffer.byteLength((await this.backend.read(key)) ?? '', 'utf8');
    }
    if (total > this.quota.maxTotalBytes) throw new PluginQuotaError(this.pluginId, `total would exceed ${this.quota.maxTotalBytes} bytes`);

    await this.backend.write(namespacedKey, serialized);
  }

  async delete(key: string): Promise<void> { await this.backend.delete(this.namespaced(key)); }

  /** Plugin-visible keys, with the namespace stripped back off. */
  async keys(): Promise<readonly string[]> {
    return (await this.backend.listKeys(this.prefix)).map((key) => key.slice(this.prefix.length)).sort();
  }

  /** Cleanup on uninstall. Only ever removes this plugin's own namespace. */
  async clear(): Promise<void> {
    for (const key of await this.backend.listKeys(this.prefix)) await this.backend.delete(key);
  }

  async usage(): Promise<{ keys: number; bytes: number }> {
    const keys = await this.backend.listKeys(this.prefix);
    let bytes = 0;
    for (const key of keys) bytes += Buffer.byteLength((await this.backend.read(key)) ?? '', 'utf8');
    return { keys: keys.length, bytes };
  }
}
