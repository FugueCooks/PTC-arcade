export async function loadRoomRegistry() {
  const response = await fetch('assets/rooms/registry.json', { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Room registry failed to load (${response.status}).`);
  const payload = await response.json();
  if (payload?.version !== 1 || !Array.isArray(payload.rooms)) throw new Error('Unsupported room registry.');
  const rooms = new Map();
  for (const room of payload.rooms) {
    if (!isRoom(room) || rooms.has(room.id)) throw new Error(`Invalid or duplicate room: ${room?.id ?? 'unknown'}`);
    if (room.enabled) rooms.set(room.id, Object.freeze({ ...room }));
  }
  if (!rooms.has('main')) throw new Error('The Main Arcade room is unavailable.');
  return Object.freeze({ version: payload.version, rooms });
}

function isRoom(room) {
  return room && typeof room.id === 'string' && /^(main|main-[2-9])$/.test(room.id)
    && typeof room.name === 'string' && room.name.length >= 2 && room.name.length <= 32
    && Number.isInteger(room.capacity) && room.capacity >= 2 && room.capacity <= 48
    && typeof room.enabled === 'boolean';
}
