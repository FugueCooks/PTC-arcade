const REGISTRY_URL = 'assets/avatars/registry.json?v=trading-1';
const REGISTRY_TIMEOUT_MS = 5_000;
const validId = /^[a-z0-9-]{2,40}$/;
let registryPromise;

export async function loadAvatarRegistry() {
  if (!registryPromise) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS);
    registryPromise = fetch(REGISTRY_URL, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error('Avatar choices could not be loaded.');
        return response.json();
      })
      .then((registry) => {
        if (registry?.version !== 1 || !Array.isArray(registry.avatars)) throw new Error('Avatar choices are invalid.');
        const avatars = registry.avatars.filter((avatar) => avatar && avatar.enabled && validId.test(avatar.id));
        if (!avatars.some((avatar) => avatar.id === 'neon-capsule')) throw new Error('The fallback avatar is unavailable.');
        return new Map(avatars.map((avatar) => [avatar.id, avatar]));
      })
      .catch((error) => {
        registryPromise = undefined;
        if (error?.name === 'AbortError') throw new Error('Avatar loading timed out. Start or restart the arcade server, then retry.');
        throw error;
      })
      .finally(() => clearTimeout(timeout));
  }
  return registryPromise;
}

export const getAvatar = async (avatarId) => (await loadAvatarRegistry()).get(avatarId) ?? (await loadAvatarRegistry()).get('neon-capsule');
