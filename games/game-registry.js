export async function loadGameRegistry() {
  const response = await fetch('assets/games/registry.json?v=megaman-cabinet-order-1', { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Game registry failed to load (${response.status}).`);
  const payload = await response.json();
  if (payload?.version !== 1 || !Array.isArray(payload.games)) throw new Error('Unsupported game registry.');
  const byCabinetId = new Map();
  for (const game of payload.games) {
    if (!isValidGame(game) || byCabinetId.has(game.cabinetId)) throw new Error(`Invalid or duplicate game entry: ${game?.id ?? 'unknown'}`);
    if (game.enabled) byCabinetId.set(game.cabinetId, Object.freeze({
      ...game,
      discs: game.discs?.map((disc) => Object.freeze({ ...disc }))
    }));
  }
  return Object.freeze({ version: payload.version, byCabinetId });
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
    && typeof game.enabled === 'boolean';
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
