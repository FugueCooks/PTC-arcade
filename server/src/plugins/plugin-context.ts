import type { SafeJsonValue } from '../domain/json-value.js';
import type { ArcadePluginManifest } from './plugin-manifest.js';
import type { PluginPermissionSet } from './plugin-permissions.js';
import type { PluginStorage } from './plugin-storage.js';

/**
 * Milestone 11.10 — the entire surface a plugin can reach.
 *
 * What a plugin receives is exactly this object. It holds no database client,
 * no Redis client, no filesystem handle, no request or socket, no session
 * cookie, no wallet signature, no environment. Every method that does something
 * privileged calls `permissions.require` first, so a grant is checked at the
 * point of use rather than assumed from load time.
 */

export interface SafePlayerProfile {
  readonly publicPlayerId: string;
  readonly displayName: string;
  readonly avatarId: string;
}

export interface SafeRoomState {
  readonly roomId: string;
  readonly population: number;
  readonly activeCabinetIds: readonly string[];
}

export interface PluginRoomEvent {
  readonly type: string;
  readonly payload: Record<string, SafeJsonValue>;
}

export interface PluginRegistrations {
  cabinetTypes: string[];
  worldInteractions: string[];
  dashboardWidgets: string[];
  apiRoutes: string[];
  socketEvents: string[];
  scheduledJobs: string[];
}

export interface PluginHostServices {
  safeProfile(publicPlayerId: string): SafePlayerProfile | undefined;
  roomState(roomId: string): SafeRoomState | undefined;
  emitRoomEvent(pluginId: string, roomId: string, event: PluginRoomEvent): void;
}

export class PluginContext {
  readonly registrations: PluginRegistrations = {
    cabinetTypes: [], worldInteractions: [], dashboardWidgets: [], apiRoutes: [], socketEvents: [], scheduledJobs: []
  };

  constructor(
    readonly manifest: ArcadePluginManifest,
    readonly configuration: Readonly<Record<string, SafeJsonValue>>,
    readonly storage: PluginStorage,
    private readonly permissions: PluginPermissionSet,
    private readonly services: PluginHostServices,
    private readonly logger: (level: 'info' | 'warn' | 'error', event: string, details: Record<string, unknown>) => void
  ) {}

  get pluginId(): string { return this.manifest.id; }

  /** Structured logging, always stamped with the plugin's identity. */
  log(level: 'info' | 'warn' | 'error', event: string, details: Record<string, SafeJsonValue> = {}): void {
    this.logger(level, event, { ...details, pluginId: this.manifest.id });
  }

  registerCabinetType(cabinetType: string): void {
    this.permissions.require('register:cabinet-type');
    this.registrations.cabinetTypes.push(cabinetType);
  }

  registerWorldInteraction(interactionId: string): void {
    this.permissions.require('register:world-interaction');
    this.registrations.worldInteractions.push(interactionId);
  }

  registerDashboardWidget(widgetId: string): void {
    this.permissions.require('register:dashboard-widget');
    this.registrations.dashboardWidgets.push(widgetId);
  }

  /** Routes are namespaced under the plugin so one cannot shadow a core route. */
  registerApiRoute(routePath: string): string {
    this.permissions.require('register:api-route');
    const namespaced = `/api/v1/plugins/${this.manifest.id}/${routePath.replace(/^\/+/, '')}`;
    this.registrations.apiRoutes.push(namespaced);
    return namespaced;
  }

  /** Socket events are namespaced for the same reason as routes. */
  registerSocketEvent(eventName: string): string {
    this.permissions.require('register:socket-event');
    const namespaced = `plugin:${this.manifest.id}:${eventName}`;
    this.registrations.socketEvents.push(namespaced);
    return namespaced;
  }

  registerScheduledJob(jobId: string): void {
    this.permissions.require('register:scheduled-job');
    this.registrations.scheduledJobs.push(jobId);
  }

  /** Public profile fields only: never an email, wallet address, or token. */
  readSafeProfile(publicPlayerId: string): SafePlayerProfile | undefined {
    this.permissions.require('read:player-safe-profile');
    return this.services.safeProfile(publicPlayerId);
  }

  readRoomState(roomId: string): SafeRoomState | undefined {
    this.permissions.require('read:room-state');
    return this.services.roomState(roomId);
  }

  emitRoomEvent(roomId: string, event: PluginRoomEvent): void {
    this.permissions.require('emit:room-event');
    this.services.emitRoomEvent(this.manifest.id, roomId, event);
  }

  requireStorage(): PluginStorage {
    this.permissions.require('write:plugin-storage');
    return this.storage;
  }
}
