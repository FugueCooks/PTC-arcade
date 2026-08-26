import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PluginStorageBackend } from './plugin-storage.js';

/**
 * Filesystem-backed plugin storage.
 *
 * The operator decision for Phase 11 was to build storage behind an interface
 * with a filesystem adapter, so the eventual object-store or Redis backend is a
 * swap with no call-site change. Keys are hex-encoded into flat file names,
 * which removes every path-traversal question: a key can never contain a
 * separator once encoded, so no key can address a file outside the root.
 */
export class FilesystemPluginStorageBackend implements PluginStorageBackend {
  private ready: Promise<void> | undefined;

  constructor(private readonly root: string) {}

  private async ensureRoot(): Promise<void> {
    this.ready ??= mkdir(this.root, { recursive: true }).then(() => undefined);
    await this.ready;
  }

  /** Hex encoding makes the file name a function of the key, never a path. */
  private fileFor(namespacedKey: string): string {
    return path.join(this.root, `${Buffer.from(namespacedKey, 'utf8').toString('hex')}.json`);
  }

  private keyFor(fileName: string): string | null {
    if (!fileName.endsWith('.json')) return null;
    const hex = fileName.slice(0, -'.json'.length);
    if (!/^(?:[0-9a-f]{2})+$/.test(hex)) return null;
    return Buffer.from(hex, 'hex').toString('utf8');
  }

  async read(namespacedKey: string): Promise<string | undefined> {
    await this.ensureRoot();
    try {
      return await readFile(this.fileFor(namespacedKey), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async write(namespacedKey: string, value: string): Promise<void> {
    await this.ensureRoot();
    await writeFile(this.fileFor(namespacedKey), value, 'utf8');
  }

  async delete(namespacedKey: string): Promise<void> {
    await this.ensureRoot();
    await rm(this.fileFor(namespacedKey), { force: true });
  }

  async listKeys(namespacePrefix: string): Promise<readonly string[]> {
    await this.ensureRoot();
    const names = await readdir(this.root);
    const keys: string[] = [];
    for (const name of names) {
      const key = this.keyFor(name);
      if (key !== null && key.startsWith(namespacePrefix)) keys.push(key);
    }
    return keys;
  }
}
