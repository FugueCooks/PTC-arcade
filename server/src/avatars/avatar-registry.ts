import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface AvatarDefinition {
  id: string;
  name: string;
  modelUrl: string | null;
  thumbnailUrl: string;
  scale: number;
  heightOffset: number;
  rotationOffset: number;
  autoGround?: boolean;
  enabled: boolean;
  animations: Partial<Record<'idle' | 'walk' | 'run' | 'interact', string>>;
}

interface AvatarRegistryFile {
  version: number;
  avatars: AvatarDefinition[];
}

const registryPath = path.resolve(process.cwd(), 'assets/avatars/registry.json');
const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as AvatarRegistryFile;

function isValidDefinition(avatar: AvatarDefinition): boolean {
  return typeof avatar.id === 'string' && /^[a-z0-9-]{2,40}$/.test(avatar.id)
    && typeof avatar.name === 'string' && avatar.name.length > 0
    && (typeof avatar.modelUrl === 'string' || avatar.modelUrl === null)
    && typeof avatar.thumbnailUrl === 'string' && Number.isFinite(avatar.scale)
    && Number.isFinite(avatar.heightOffset) && Number.isFinite(avatar.rotationOffset)
    && (avatar.autoGround === undefined || typeof avatar.autoGround === 'boolean')
    && typeof avatar.enabled === 'boolean' && typeof avatar.animations === 'object';
}

if (registry.version !== 1 || !registry.avatars.every(isValidDefinition)) {
  throw new Error('Avatar registry is malformed.');
}

export const avatars = new Map(registry.avatars.filter((avatar) => avatar.enabled).map((avatar) => [avatar.id, avatar]));
export const DEFAULT_AVATAR_ID = 'vled';

if (!avatars.has(DEFAULT_AVATAR_ID)) throw new Error('The fallback avatar must be enabled.');

export function resolveAvatarId(candidate: unknown): string {
  return typeof candidate === 'string' && avatars.has(candidate) ? candidate : DEFAULT_AVATAR_ID;
}

export function isApprovedAvatarId(candidate: unknown): candidate is string {
  return typeof candidate === 'string' && avatars.has(candidate);
}
