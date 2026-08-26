export interface PluginStorage {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface PluginStorageQuotas { maxKeys: number; maxValueBytes: number }

/** Quota-bound storage facade. The plugin never sees the backing database or Redis client. */
export class InMemoryPluginStorage implements PluginStorage {
  private readonly values = new Map<string, string>();
  constructor(readonly namespace: string, private readonly quotas: PluginStorageQuotas = { maxKeys: 100, maxValueBytes: 64 * 1024 }) {
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(namespace)) throw new Error('Invalid plugin storage namespace.');
  }
  async get<T>(key: string): Promise<T | undefined> { const value = this.values.get(validKey(key)); return value === undefined ? undefined : JSON.parse(value) as T; }
  async set<T>(key: string, value: T): Promise<void> {
    const normalized = validKey(key), encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > this.quotas.maxValueBytes) throw new Error('Plugin storage value exceeds quota.');
    if (!this.values.has(normalized) && this.values.size >= this.quotas.maxKeys) throw new Error('Plugin storage key quota exceeded.');
    this.values.set(normalized, encoded);
  }
  async delete(key: string): Promise<void> { this.values.delete(validKey(key)); }
  get size(): number { return this.values.size; }
}

function validKey(value: string): string {
  if (!/^[A-Za-z0-9:_-]{1,96}$/.test(value)) throw new Error('Invalid plugin storage key.');
  return value;
}
