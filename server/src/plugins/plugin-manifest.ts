import { z } from 'zod';
import type { ArcadePluginManifest, PluginCapability, PluginPermission } from '../../../shared/plugin-contracts.js';
import { PLATFORM_API_VERSION } from '../../../shared/platform-contracts.js';

const permissions = ['register:cabinet-type','register:game','register:emulator-adapter','register:world-interaction','register:api-route',
  'register:socket-event','register:dashboard-widget','register:scheduled-job','read:player-safe-profile','read:room-state','write:plugin-storage','emit:room-event'] as const;
const capabilities = ['cabinet-type','game','emulator-adapter','world-interaction','api-route','socket-event','dashboard-widget','scheduled-job'] as const;
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const schema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/), name: z.string().min(1).max(80), version: z.string().regex(semver),
  apiVersion: z.string(), description: z.string().max(500).optional(),
  entrypoints: z.object({ client: z.string().regex(/^[A-Za-z0-9_./-]+$/).optional(), server: z.string().regex(/^[A-Za-z0-9_./-]+$/).optional() }).strict(),
  permissions: z.array(z.enum(permissions)).max(permissions.length), dependencies: z.array(z.object({ id: z.string(), version: z.string().regex(semver) }).strict()).optional(),
  capabilities: z.array(z.enum(capabilities)).max(capabilities.length), configurationSchema: z.record(z.string(), z.unknown()).optional(), critical: z.boolean().optional()
}).strict();

export function validatePluginManifest(input: unknown): ArcadePluginManifest {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error('Plugin manifest is invalid.');
  if (result.data.apiVersion !== PLATFORM_API_VERSION) throw new Error(`Unsupported plugin API version: ${result.data.apiVersion}`);
  return result.data as ArcadePluginManifest;
}

export function requiresPermission(capability: PluginCapability): PluginPermission {
  return `register:${capability}` as PluginPermission;
}
