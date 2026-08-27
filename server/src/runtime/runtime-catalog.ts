/**
 * The catalogue the PTC Arcade Runtime fetches.
 *
 * This is the list of things the runtime is willing to download and hand to a
 * native emulator, which makes it the other half of the launch security model:
 * the page names an id, and only what appears here can be resolved from it.
 *
 * Every entry carries a SHA-256, and an entry that cannot be given one is
 * omitted rather than published without it. A published entry with no digest
 * would be an unverifiable download, and the runtime would have nothing to
 * check the bytes against before opening them.
 *
 * The digests are not invented here — they come from the deploy manifest that
 * was used to upload the images, so the catalogue and the objects in storage
 * agree by construction rather than by a second measurement.
 */

export interface RuntimeCatalogEntry {
  gameId: string;
  platformId: string;
  displayName: string;
  fileName: string;
  downloadUrl: string;
  sizeBytes: number;
  sha256: string;
}

export interface RuntimeCatalogSource {
  /** Enabled games, as parsed from assets/games/registry.json. */
  games: ReadonlyArray<{ id: string; name: string; system: string; file: string; sizeBytes: number; enabled: boolean }>;
  /** Upload manifest entries, keyed by file name, carrying the digest. */
  manifest: ReadonlyArray<{ kind: string; system?: string; file: string; bytes: number; sha256?: string }>;
  /** Base URL the images are served from, e.g. the R2 public bucket. */
  assetBaseUrl: string;
  /** Platforms the runtime handles. GameCube today. */
  platforms: readonly string[];
}

export interface RuntimeCatalogResult {
  entries: RuntimeCatalogEntry[];
  /** Why a game was left out, so a missing cabinet is diagnosable from a log. */
  omitted: Array<{ gameId: string; reason: string }>;
}

export function buildRuntimeCatalog(source: RuntimeCatalogSource): RuntimeCatalogResult {
  const digests = new Map<string, { bytes: number; sha256?: string }>();
  for (const item of source.manifest) {
    if (item.kind !== 'game') continue;
    digests.set(item.file, { bytes: item.bytes, sha256: item.sha256 });
  }

  const entries: RuntimeCatalogEntry[] = [];
  const omitted: Array<{ gameId: string; reason: string }> = [];

  for (const game of source.games) {
    if (!game.enabled) continue;
    if (!source.platforms.includes(game.system)) continue;

    const digest = digests.get(game.file);
    if (!digest) {
      omitted.push({ gameId: game.id, reason: 'no-manifest-entry' });
      continue;
    }
    if (!digest.sha256 || !/^[0-9a-f]{64}$/.test(digest.sha256)) {
      omitted.push({ gameId: game.id, reason: 'no-digest' });
      continue;
    }
    // A size disagreement means the manifest and the registry describe
    // different files, and there is no safe way to guess which is current.
    if (digest.bytes !== game.sizeBytes) {
      omitted.push({ gameId: game.id, reason: 'size-disagreement' });
      continue;
    }

    const downloadUrl = joinAssetUrl(source.assetBaseUrl, game.file);
    if (!downloadUrl) {
      omitted.push({ gameId: game.id, reason: 'no-asset-base-url' });
      continue;
    }

    entries.push({
      gameId: game.id,
      platformId: game.system,
      displayName: game.name,
      fileName: game.file,
      downloadUrl,
      sizeBytes: game.sizeBytes,
      sha256: digest.sha256
    });
  }

  return { entries, omitted };
}

/**
 * Composes the public URL for an image.
 *
 * https only: the runtime refuses a plaintext download URL, and publishing one
 * would produce an entry the runtime silently drops — a cabinet that works in
 * the browser and not natively, for no visible reason.
 */
function joinAssetUrl(baseUrl: string, fileName: string): string | null {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  try {
    const url = new URL(`${trimmed}/${fileName}`);
    if (url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}
