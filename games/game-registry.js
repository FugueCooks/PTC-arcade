export async function loadGameRegistry() {
  const response = await fetch('assets/games/registry.json?v=n64-ps2-rooms-1', { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Game registry failed to load (${response.status}).`);
  const payload = await response.json();
  if (payload?.version !== 1 || !Array.isArray(payload.games)) throw new Error('Unsupported game registry.');
  const byCabinetId = new Map();
  for (const game of payload.games) {
    if (!isValidGame(game) || byCabinetId.has(game.cabinetId)) throw new Error(`Invalid or duplicate game entry: ${game?.id ?? 'unknown'}`);
    if (game.enabled) byCabinetId.set(game.cabinetId, Object.freeze({ ...game }));
  }
  return Object.freeze({ version: payload.version, byCabinetId });
}

function isValidGame(game) {
  return game && typeof game.id === 'string' && /^[a-z0-9-]{2,64}$/.test(game.id)
    && typeof game.cabinetId === 'string' && /^[a-z0-9-]{2,64}$/.test(game.cabinetId)
    && typeof game.name === 'string' && game.name.length <= 80
    && (game.system === 'psx' || game.system === 'n64')
    && typeof game.file === 'string' && /^[A-Za-z0-9._-]+$/.test(game.file)
    && Number.isSafeInteger(game.emulatorId) && game.emulatorId > 0
    && Number.isSafeInteger(game.sizeBytes) && game.sizeBytes > 0
    && typeof game.enabled === 'boolean';
}
