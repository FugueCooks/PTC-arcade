let registryPromise;

export function loadCabinetRegistry() {
  if (!registryPromise) registryPromise = fetch('./assets/cabinets/registry.json')
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
  const definitions = new Map();
  entries.forEach((entry) => {
    if (!entry || typeof entry.id !== 'string' || ids.has(entry.id) || typeof entry.sceneKey !== 'string') throw new Error('Cabinet registry contains an invalid or duplicate ID.');
    if (!point(entry.interactionPosition) || !point(entry.playerPosition) || !Number.isFinite(entry.playerRotationY)) throw new Error(`Cabinet ${entry.id} has invalid alignment data.`);
    ids.add(entry.id);
    definitions.set(entry.id, Object.freeze(entry));
  });
  return definitions;
}

function point(value) { return value && [value.x, value.y, value.z].every(Number.isFinite); }

