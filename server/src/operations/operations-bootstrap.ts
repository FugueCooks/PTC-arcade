import type { ServerConfig } from '../config.js';
import type { CabinetManager } from '../cabinets/cabinet-manager.js';
import type { GameRegistry } from '../games/game-registry-service.js';
import type { PluginHost } from '../plugins/plugin-host.js';
import { OperationsAuditLog } from './audit-log.js';
import { OperationsActionExecutor, OperationsActionRegistry, requireBoolean, type ActionResult } from './operations-actions.js';
import { OperationsService, type OperationsSources } from './operations-service.js';
import { OperatorAuthService, parseOperatorCredentials } from './operator-auth.js';

/**
 * Milestone 11.28 — registers the concrete operational actions.
 *
 * Each handler validates the current state before changing anything, reports a
 * no-op rather than pretending to act, and honours dry-run by computing the
 * outcome without applying it. There is deliberately no generic "run" handler.
 */
export interface OperationsRuntime {
  auth: OperatorAuthService;
  audit: OperationsAuditLog;
  actions: OperationsActionRegistry;
  executor: OperationsActionExecutor;
  operations: OperationsService;
  /** Flags an operator has toggled at runtime. */
  featureFlags: Map<string, boolean>;
  /** Rooms an operator has placed in maintenance. */
  maintenanceRooms: Set<string>;
  /** Cabinets an operator has disabled at runtime. */
  disabledCabinets: Set<string>;
  disabledGames: Set<string>;
  roomAssignmentStopped: () => boolean;
}

export interface OperationsWiring {
  config: ServerConfig;
  sources: OperationsSources;
  cabinets: CabinetManager;
  games: GameRegistry;
  plugins: PluginHost;
  beginDraining: () => void;
  isDraining: () => boolean;
  closeEmptyRoom: (roomId: string) => boolean;
  roomPopulation: (roomId: string) => number | undefined;
  refreshRegistry: () => { cabinetDefinitions: number; gameDefinitions: number };
  auditSink?: (record: unknown) => void;
}

export function createOperationsRuntime(wiring: OperationsWiring): OperationsRuntime {
  const { config } = wiring;
  const auth = new OperatorAuthService(parseOperatorCredentials(config.operationsOperators), config.operationsSessionTtlMs);
  const audit = new OperationsAuditLog(config.softwareVersion, 2_000, (record) => wiring.auditSink?.(record));
  const actions = new OperationsActionRegistry();

  const featureFlags = new Map<string, boolean>();
  const maintenanceRooms = new Set<string>();
  const disabledCabinets = new Set<string>();
  const disabledGames = new Set<string>();
  let assignmentStopped = false;

  actions.register('server.drain', {
    capability: 'operations:admin', requiresReason: true, targetType: 'server',
    execute: ({ dryRun }) => {
      const wasDraining = wiring.isDraining();
      // Idempotent: draining an already-draining server is a no-op, not an error.
      if (wasDraining) return { ok: true, dryRun, noop: true, previousState: { draining: true }, resultingState: { draining: true } };
      if (!dryRun) wiring.beginDraining();
      return { ok: true, dryRun, previousState: { draining: false }, resultingState: { draining: true } };
    }
  });

  actions.register('server.stop-room-assignment', {
    capability: 'operations:act', requiresReason: true, targetType: 'server',
    execute: ({ value, dryRun }) => {
      const next = requireBoolean(value);
      if (next === undefined) return { ok: false, reason: 'invalid-value', dryRun };
      const previous = assignmentStopped;
      if (previous === next) return { ok: true, dryRun, noop: true, previousState: { stopped: previous }, resultingState: { stopped: next } };
      if (!dryRun) assignmentStopped = next;
      return { ok: true, dryRun, previousState: { stopped: previous }, resultingState: { stopped: next } };
    }
  });

  actions.register('room.close-empty', {
    capability: 'operations:act', requiresReason: false, targetType: 'room',
    execute: ({ targetId, dryRun }) => {
      if (targetId === null) return { ok: false, reason: 'invalid-target', dryRun };
      const population = wiring.roomPopulation(targetId);
      // State validation: a populated room is never closed out from under players.
      if (population !== undefined && population > 0) {
        return { ok: false, reason: 'invalid-state', dryRun, message: `room has ${population} player(s)` };
      }
      const closed = dryRun ? true : wiring.closeEmptyRoom(targetId);
      return { ok: true, dryRun, noop: !closed, previousState: { roomId: targetId, population: population ?? 0 }, resultingState: { closed } };
    }
  });

  actions.register('room.set-maintenance', {
    capability: 'operations:act', requiresReason: true, targetType: 'room',
    execute: ({ targetId, value, dryRun }) => {
      if (targetId === null) return { ok: false, reason: 'invalid-target', dryRun };
      const next = requireBoolean(value);
      if (next === undefined) return { ok: false, reason: 'invalid-value', dryRun };
      const previous = maintenanceRooms.has(targetId);
      if (previous === next) return { ok: true, dryRun, noop: true, previousState: { maintenance: previous }, resultingState: { maintenance: next } };
      if (!dryRun) { if (next) maintenanceRooms.add(targetId); else maintenanceRooms.delete(targetId); }
      return { ok: true, dryRun, previousState: { maintenance: previous }, resultingState: { maintenance: next } };
    }
  });

  actions.register('cabinet.set-enabled', {
    capability: 'operations:act', requiresReason: false, targetType: 'cabinet',
    execute: ({ targetId, value, dryRun }) => {
      if (targetId === null || !wiring.cabinets.index.has(targetId)) return { ok: false, reason: 'not-found', dryRun };
      const next = requireBoolean(value);
      if (next === undefined) return { ok: false, reason: 'invalid-value', dryRun };
      const previous = !disabledCabinets.has(targetId);
      if (previous === next) return { ok: true, dryRun, noop: true, previousState: { enabled: previous }, resultingState: { enabled: next } };
      if (!dryRun) { if (next) disabledCabinets.delete(targetId); else disabledCabinets.add(targetId); }
      return { ok: true, dryRun, previousState: { enabled: previous }, resultingState: { enabled: next } };
    }
  });

  actions.register('game.set-enabled', {
    capability: 'operations:act', requiresReason: false, targetType: 'game',
    execute: ({ targetId, value, dryRun }) => {
      if (targetId === null || !wiring.games.has(targetId)) return { ok: false, reason: 'not-found', dryRun };
      const next = requireBoolean(value);
      if (next === undefined) return { ok: false, reason: 'invalid-value', dryRun };
      const previous = !disabledGames.has(targetId);
      if (previous === next) return { ok: true, dryRun, noop: true, previousState: { enabled: previous }, resultingState: { enabled: next } };
      if (!dryRun) { if (next) disabledGames.delete(targetId); else disabledGames.add(targetId); }
      return { ok: true, dryRun, previousState: { enabled: previous }, resultingState: { enabled: next } };
    }
  });

  actions.register('plugin.set-enabled', {
    capability: 'operations:admin', requiresReason: true, targetType: 'plugin',
    execute: async ({ targetId, value, dryRun }) => {
      if (targetId === null || !wiring.plugins.get(targetId)) return { ok: false, reason: 'not-found', dryRun };
      const next = requireBoolean(value);
      if (next === undefined) return { ok: false, reason: 'invalid-value', dryRun };
      const previous = wiring.plugins.statusOf(targetId) ?? 'disabled';
      if (dryRun) return { ok: true, dryRun, previousState: { status: previous }, resultingState: { status: next ? 'started' : 'disabled' } };
      const changed = next ? await wiring.plugins.restart(targetId) : await wiring.plugins.disable(targetId);
      return {
        ok: true, dryRun, noop: !changed,
        previousState: { status: previous },
        resultingState: { status: wiring.plugins.statusOf(targetId) ?? 'disabled' }
      };
    }
  });

  actions.register('plugin.restart', {
    capability: 'operations:admin', requiresReason: true, targetType: 'plugin',
    execute: async ({ targetId, dryRun }) => {
      if (targetId === null || !wiring.plugins.get(targetId)) return { ok: false, reason: 'not-found', dryRun };
      const previous = wiring.plugins.statusOf(targetId) ?? 'disabled';
      if (dryRun) return { ok: true, dryRun, previousState: { status: previous }, resultingState: { status: 'started' } };
      const restarted = await wiring.plugins.restart(targetId);
      return {
        ok: restarted, dryRun,
        ...(restarted ? {} : { reason: 'invalid-state' as const, message: 'plugin failed to restart' }),
        previousState: { status: previous },
        resultingState: { status: wiring.plugins.statusOf(targetId) ?? 'failed' }
      };
    }
  });

  actions.register('registry.refresh', {
    capability: 'operations:admin', requiresReason: false, targetType: 'registry',
    execute: ({ dryRun }): ActionResult => {
      if (dryRun) return { ok: true, dryRun, resultingState: { refreshed: false } };
      const { cabinetDefinitions, gameDefinitions } = wiring.refreshRegistry();
      return { ok: true, dryRun, resultingState: { refreshed: true, cabinetDefinitions, gameDefinitions } };
    }
  });

  actions.register('feature-flag.set', {
    capability: 'operations:admin', requiresReason: true, targetType: 'feature-flag',
    execute: ({ targetId, value, dryRun }) => {
      if (targetId === null || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(targetId)) return { ok: false, reason: 'invalid-target', dryRun };
      const next = requireBoolean(value);
      if (next === undefined) return { ok: false, reason: 'invalid-value', dryRun };
      const previous = featureFlags.get(targetId) ?? false;
      if (previous === next) return { ok: true, dryRun, noop: true, previousState: { [targetId]: previous }, resultingState: { [targetId]: next } };
      if (!dryRun) featureFlags.set(targetId, next);
      return { ok: true, dryRun, previousState: { [targetId]: previous }, resultingState: { [targetId]: next } };
    }
  });

  return {
    auth,
    audit,
    actions,
    executor: new OperationsActionExecutor(actions, audit, (error) => {
      // An audit write that fails is a serious operational signal, so it is
      // reported rather than swallowed.
      wiring.auditSink?.({ event: 'operations_audit_write_failed', error: error instanceof Error ? error.message : String(error) });
    }),
    operations: new OperationsService(wiring.sources, config.softwareVersion),
    featureFlags,
    maintenanceRooms,
    disabledCabinets,
    disabledGames,
    roomAssignmentStopped: () => assignmentStopped
  };
}
