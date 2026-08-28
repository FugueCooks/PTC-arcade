export async function loadGameRegistry() {
  const response = await fetch('assets/games/registry.json?v=ff-1', { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Game registry failed to load (${response.status}).`);
  const payload = await response.json();
  if (![1, 2].includes(payload?.version) || !Array.isArray(payload.games)) throw new Error('Unsupported game registry.');
  const byCabinetId = new Map();
  const byId = new Map();
  for (const game of payload.games) {
    if (!isValidGame(game) || byCabinetId.has(game.cabinetId) || byId.has(game.id)) throw new Error(`Invalid or duplicate game entry: ${game?.id ?? 'unknown'}`);
    if (!game.enabled) continue;
    const frozen = Object.freeze({
      ...game,
      // `system` is this file's name for the platform; `platformId` is the
      // server's, and what every adapter reads. Publishing both keeps one
      // registry entry usable on either side of the adapter boundary instead
      // of leaving each consumer to guess which field exists.
      platformId: game.system,
      discs: game.discs?.map((disc) => Object.freeze({ ...disc })),
      assetRequirements: game.assetRequirements?.map((asset) => Object.freeze({ ...asset }))
    });
    // byId is the Phase 11 direction (cabinet references a game); byCabinetId
    // stays as the compatibility view until every caller has migrated.
    byId.set(game.id, frozen);
    byCabinetId.set(game.cabinetId, frozen);
  }
  return Object.freeze({ version: payload.version, byId, byCabinetId });
}

function isValidGame(game) {
  return game && typeof game.id === 'string' && /^[a-z0-9-]{2,64}$/.test(game.id)
    && typeof game.cabinetId === 'string' && /^[a-z0-9-]{2,64}$/.test(game.cabinetId)
    && typeof game.name === 'string' && game.name.length <= 80
    && (game.system === 'psx' || game.system === 'n64' || game.system === 'snes' || game.system === 'ps2' || game.system === 'gamecube')
    && typeof game.file === 'string' && /^[A-Za-z0-9._-]+$/.test(game.file)
    && Number.isSafeInteger(game.emulatorId) && game.emulatorId > 0
    && Number.isSafeInteger(game.sizeBytes) && game.sizeBytes > 0
    && validDiscs(game)
    && validBootChunks(game)
    && validPerformanceNote(game)
    && typeof game.enabled === 'boolean';
}

/**
 * Optional. What a player should know about this title's performance before
 * they start it, measured rather than guessed. Mega Man X7 holds a median of
 * 40 f/s in the browser PS2 core with dips into the twenties; saying so is
 * better than letting someone conclude the arcade is broken.
 */
function validPerformanceNote(game) {
  return game.performanceNote === undefined
    || (typeof game.performanceNote === 'string' && game.performanceNote.length > 0 && game.performanceNote.length <= 96);
}

/**
 * Optional. The 4 MB chunk indexes a core was observed reading while this title
 * booted, in the order it read them, recorded once with the PS2 frame's boot
 * recorder. The arcade warms exactly these on approach instead of guessing at
 * the opening megabytes. Absent means guess; present means measured.
 */
function validBootChunks(game) {
  if (game.bootChunks === undefined) return true;
  if (!Array.isArray(game.bootChunks) || game.bootChunks.length === 0 || game.bootChunks.length > 64) return false;
  const chunkCount = Math.ceil(game.sizeBytes / (4 * 1024 * 1024));
  return game.bootChunks.every(index => Number.isSafeInteger(index) && index >= 0 && index < chunkCount);
}

function validDiscs(game) {
  if (game.discs === undefined) return true;
  if (!Array.isArray(game.discs) || game.discs.length < 2 || game.discs.length > 8) return false;
  const files = new Set();
  for (const disc of game.discs) {
    if (!disc || typeof disc.label !== 'string' || disc.label.length < 1 || disc.label.length > 24
      || typeof disc.file !== 'string' || !/^[A-Za-z0-9._-]+$/.test(disc.file)
      || !Number.isSafeInteger(disc.sizeBytes) || disc.sizeBytes <= 0 || files.has(disc.file)) return false;
    files.add(disc.file);
  }
  return game.discs[0].file === game.file && game.discs[0].sizeBytes === game.sizeBytes;
}
