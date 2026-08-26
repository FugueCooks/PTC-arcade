import type { SafeJson } from './platform-contracts.js';

export type PluginPermission = 'register:cabinet-type' | 'register:game' | 'register:emulator-adapter'
  | 'register:world-interaction' | 'register:api-route' | 'register:socket-event'
  | 'register:dashboard-widget' | 'register:scheduled-job' | 'read:player-safe-profile'
  | 'read:room-state' | 'write:plugin-storage' | 'emit:room-event';

export type PluginCapability = 'cabinet-type' | 'game' | 'emulator-adapter' | 'world-interaction'
  | 'api-route' | 'socket-event' | 'dashboard-widget' | 'scheduled-job';

export interface PluginDependency { id: string; version: string }
export interface ArcadePluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: string;
  description?: string;
  entrypoints: { client?: string; server?: string };
  permissions: PluginPermission[];
  dependencies?: PluginDependency[];
  capabilities: PluginCapability[];
  configurationSchema?: Record<string, SafeJson>;
  critical?: boolean;
}

export type PluginLifecycleStatus = 'discovered' | 'validated' | 'initialized' | 'started'
  | 'stopped' | 'disposed' | 'failed' | 'disabled';
