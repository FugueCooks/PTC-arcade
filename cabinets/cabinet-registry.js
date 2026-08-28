import { CabinetSpatialIndex } from './cabinet-spatial-index.js';

let registryPromise;

export function loadCabinetRegistry() {
  if (!registryPromise) registryPromise = fetch('./assets/cabinets/registry.json?v=native-line-2', { cache: 'no-cache' })
    .then((response) => {
      if (!response.ok) throw new Error(`Cabinet registry returned ${response.status}`);
      return response.json();
    })
    .then(validateRegistry);
  return registryPromise;
}

function validateRegistry(entries) {
  if (!Array.isArray(entries)) throw new Error('Cabinet registry must be an array.');
  const ids = new Set();
  const definitions = [];
  entries.forEach((entry) => {
    if (!entry || typeof entry.id !== 'string' || ids.has(entry.id) || typeof entry.sceneKey !== 'string') throw new Error('Cabinet registry contains an invalid or duplicate ID.');
    if (!point(entry.interactionPosition) || !point(entry.playerPosition) || !Number.isFinite(entry.playerRotationY)) throw new Error(`Cabinet ${entry.id} has invalid alignment data.`);
    ids.add(entry.id);
    definitions.push(Object.freeze(normalize(entry)));
  });
  return new CabinetSpatialIndex(definitions);
}

function point(value) { return value && [value.x, value.y, value.z].every(Number.isFinite); }

function normalize(entry){return{...entry,displayName:entry.name,cabinetType:entry.cabinetType||(['crash-bandicoot','gex-enter-the-gecko'].includes(entry.id)?'themed-upright':'standard-upright'),
  gameId:entry.defaultGameId||`unassigned:${entry.id}`,zoneId:entry.zoneId||zoneId(entry),interactionPolicy:entry.interactionPolicy||(entry.enabled?'standard':'disabled')}}
function zoneId(entry){if(entry.id.startsWith('megaman-'))return'megaman-room';if(entry.id.startsWith('n64-'))return'n64-room';
  if(entry.id.startsWith('gamecube-'))return'gamecube-room';if(entry.id.startsWith('ps2-'))return'ps2-room';if(entry.id.startsWith('xbox-'))return'xbox-room';
  if(entry.system==='psx'||['crash-bandicoot','gex-enter-the-gecko'].includes(entry.id))return'playstation-room';return'main-social'}
