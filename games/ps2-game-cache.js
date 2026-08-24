const CACHE_DIRECTORY = 'retro-arcade-ps2-v1';
const STORAGE_HEADROOM_BYTES = 64 * 1024 * 1024;

export class Ps2GameCache {
  get supported() {
    return typeof navigator.storage?.getDirectory === 'function';
  }

  async get(game) {
    if (!this.supported || !validGame(game)) return null;
    try {
      const directory = await this.directory();
      const handle = await directory.getFileHandle(cacheFileName(game));
      const file = await handle.getFile();
      if (file.size === game.sizeBytes) return file;
      await directory.removeEntry(cacheFileName(game));
    } catch (error) {
      if (error?.name !== 'NotFoundError') console.warn('Could not inspect the local PS2 cache.', error);
    }
    return null;
  }

  async download(game, url, { signal, onProgress } = {}) {
    if (!this.supported) throw new Error('Local game caching is not supported by this browser.');
    if (!validGame(game) || typeof url !== 'string' || !url.startsWith('https://')) throw new Error('Invalid PS2 cache request.');
    const existing = await this.get(game);
    if (existing) return existing;
    await navigator.storage.persist?.();
    const estimate = await navigator.storage.estimate?.();
    if (Number.isFinite(estimate?.quota) && Number.isFinite(estimate?.usage)
      && estimate.quota - estimate.usage < game.sizeBytes + STORAGE_HEADROOM_BYTES) {
      throw new Error(`Not enough browser storage. Free at least ${formatBytes(game.sizeBytes + STORAGE_HEADROOM_BYTES)}.`);
    }

    const directory = await this.directory();
    const name = cacheFileName(game);
    const handle = await directory.getFileHandle(name, { create: true });
    let writable;
    try {
      const response = await fetch(url, { credentials: 'omit', signal });
      if (!response.ok || !response.body) throw new Error(`Game download failed (${response.status}).`);
      writable = await handle.createWritable({ keepExistingData: false });
      const reader = response.body.getReader();
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(value);
        received += value.byteLength;
        onProgress?.(Math.min(1, received / game.sizeBytes), received, game.sizeBytes);
      }
      await writable.close();
      writable = null;
      const file = await handle.getFile();
      if (file.size !== game.sizeBytes) throw new Error('The downloaded game file was incomplete.');
      onProgress?.(1, file.size, game.sizeBytes);
      return file;
    } catch (error) {
      try { await writable?.abort(); } catch { /* Already closed. */ }
      try { await directory.removeEntry(name); } catch { /* No partial file. */ }
      throw error;
    }
  }

  async directory() {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(CACHE_DIRECTORY, { create: true });
  }
}

function validGame(game) {
  return game && typeof game.id === 'string' && /^[a-z0-9-]{2,64}$/.test(game.id)
    && typeof game.file === 'string' && /^[A-Za-z0-9._-]+$/.test(game.file)
    && Number.isSafeInteger(game.sizeBytes) && game.sizeBytes > 0;
}

function cacheFileName(game) {
  const extension = /\.[A-Za-z0-9]+$/.exec(game.file)?.[0]?.toLowerCase() ?? '.iso';
  return `${game.id}-${game.sizeBytes}${extension}`;
}

function formatBytes(bytes) {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
