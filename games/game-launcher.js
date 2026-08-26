import { FRAME_SIGNALS } from '../emulators/emulator-adapter.js';

/**
 * Milestone 11.3 — the single path from a cabinet interaction to a running game.
 *
 *   CabinetInteractionController -> GameLauncher -> GameDefinition
 *     -> EmulatorAdapterRegistry -> EmulatorAdapter -> GameSession
 *
 * Individual cabinets hold no emulator-start logic: they name a cabinet ID and
 * the launcher does the rest. Every failure path releases what it acquired, so a
 * refused or broken launch cannot strand a cabinet in a reserved state.
 */

export const LAUNCH_FAILURES = Object.freeze({
  UNKNOWN_CABINET: 'unknown-cabinet',
  CABINET_DISABLED: 'cabinet-disabled',
  NO_GAME: 'no-game-assigned',
  UNKNOWN_GAME: 'unknown-game',
  GAME_DISABLED: 'game-disabled',
  UNKNOWN_ADAPTER: 'unknown-adapter',
  PLATFORM_UNSUPPORTED: 'platform-unsupported',
  NOT_ENTITLED: 'not-entitled',
  PREFLIGHT_FAILED: 'preflight-failed',
  START_FAILED: 'start-failed'
});

const MESSAGES = Object.freeze({
  'unknown-cabinet': 'THIS CABINET IS UNAVAILABLE.',
  'cabinet-disabled': 'THIS CABINET IS OUT OF ORDER.',
  'no-game-assigned': 'THIS CABINET IS AWAITING GAME SETUP.',
  'unknown-game': 'THIS GAME IS UNAVAILABLE.',
  'game-disabled': 'THIS GAME IS OUT OF ROTATION.',
  'unknown-adapter': 'NO EMULATOR IS AVAILABLE FOR THIS GAME.',
  'platform-unsupported': 'NO EMULATOR IS AVAILABLE FOR THIS GAME.',
  'not-entitled': 'YOU CANNOT START THIS GAME.',
  'desktop-only': 'THIS CABINET REQUIRES A DESKTOP BROWSER.',
  'missing-assets': 'GAME DATA IS UNAVAILABLE.',
  'preflight-failed': 'GAME DATA IS UNAVAILABLE.',
  'start-failed': 'EMULATOR COULD NOT LOAD.'
});

export function launchFailureMessage(reason) {
  return MESSAGES[reason] ?? 'CABINET COULD NOT OPEN.';
}

export class GameLauncher {
  /**
   * @param cabinets  lookup returning a CabinetDefinition by ID
   * @param games     the GameRegistry
   * @param adapters  the EmulatorAdapterRegistry
   * @param runtime   host mechanism: mount/terminate/release/postToFrame
   * @param entitlements optional gate; Phase 11 ships an allow-all default,
   *        because the competitive layer it would consult does not exist yet.
   */
  constructor({ cabinets, games, adapters, runtime, entitlements, logger } = {}) {
    this.cabinets = cabinets;
    this.games = games;
    this.adapters = adapters;
    this.runtime = runtime;
    this.entitlements = entitlements ?? { check: () => ({ ok: true }) };
    this.logger = logger ?? (() => undefined);
    this.activeSession = null;
  }

  /**
   * Resolution is separated from launching so the interaction layer can decide
   * what to show a player *before* any download starts, and so the whole chain
   * is testable without a browser.
   */
  resolve(cabinetId) {
    const cabinet = this.cabinets?.get(cabinetId);
    if (!cabinet) return { ok: false, reason: LAUNCH_FAILURES.UNKNOWN_CABINET };
    if (!cabinet.enabled) return { ok: false, reason: LAUNCH_FAILURES.CABINET_DISABLED };
    if (!cabinet.gameId) return { ok: false, reason: LAUNCH_FAILURES.NO_GAME };

    const game = this.games?.get(cabinet.gameId);
    if (!game) return { ok: false, reason: LAUNCH_FAILURES.UNKNOWN_GAME, gameId: cabinet.gameId };
    if (game.enabled === false) return { ok: false, reason: LAUNCH_FAILURES.GAME_DISABLED, gameId: game.id };

    const resolution = this.adapters?.resolveForGame(game) ?? { ok: false, reason: 'unknown-adapter' };
    if (!resolution.ok) return { ok: false, reason: resolution.reason, gameId: game.id, adapterId: resolution.adapterId };

    return { ok: true, cabinet, game, adapter: resolution.adapter };
  }

  /**
   * Runs the full flow: resolve, check entitlement, preflight, create, start.
   * On any failure after the session exists, the session is disposed before the
   * error is returned so no frame, blob URL, or timer outlives the attempt.
   */
  async launch(cabinetId, context = {}) {
    const resolved = this.resolve(cabinetId);
    if (!resolved.ok) {
      this.logger('warn', 'game_launch_denied', { cabinetId, reason: resolved.reason });
      return resolved;
    }
    const { cabinet, game, adapter } = resolved;

    const entitlement = await this.entitlements.check({ cabinet, game, player: context.player });
    if (!entitlement.ok) {
      this.logger('warn', 'game_launch_denied', { cabinetId, reason: LAUNCH_FAILURES.NOT_ENTITLED });
      return { ok: false, reason: LAUNCH_FAILURES.NOT_ENTITLED };
    }

    const launchContext = { ...context, cabinet, game, runtime: this.runtime };
    const preflight = await adapter.preflight(launchContext);
    if (!preflight.ok) {
      this.logger('warn', 'game_preflight_failed', { cabinetId, gameId: game.id, reason: preflight.reason });
      return { ok: false, reason: preflight.reason ?? LAUNCH_FAILURES.PREFLIGHT_FAILED, missingAssets: preflight.missingAssets ?? [] };
    }

    let session;
    try {
      session = await adapter.createSession(launchContext);
      session.cabinetId = cabinet.id;
      session.runtime = this.runtime;
      await adapter.start(session);
    } catch (error) {
      // Anything already allocated is torn down before reporting, so a failed
      // launch never leaves the cabinet holding an invisible session.
      if (session) await this.#safeDispose(adapter, session);
      this.logger('warn', 'game_start_failed', { cabinetId, gameId: game.id, error: String(error?.message ?? error) });
      return { ok: false, reason: LAUNCH_FAILURES.START_FAILED };
    }

    this.activeSession = { adapter, session, cabinetId: cabinet.id, gameId: game.id };
    this.logger('info', 'game_session_started', { cabinetId, gameId: game.id, adapterId: adapter.id });
    return { ok: true, session, adapter, game, cabinet };
  }

  /** Routes a frame message to the owning adapter. Unknown frames are ignored. */
  interpret(message) {
    if (!this.activeSession) return { kind: FRAME_SIGNALS.IGNORE };
    return this.activeSession.adapter.interpretMessage(message);
  }

  /** Idempotent: stopping an already-stopped launcher is a no-op, not an error. */
  async stop(reason = 'player-exit') {
    const active = this.activeSession;
    if (!active) return { ok: true, stopped: false };
    this.activeSession = null;
    try {
      await active.adapter.stop(active.session, reason);
    } finally {
      await this.#safeDispose(active.adapter, active.session);
    }
    this.logger('info', 'game_session_stopped', { cabinetId: active.cabinetId, gameId: active.gameId, reason });
    return { ok: true, stopped: true, cabinetId: active.cabinetId };
  }

  async #safeDispose(adapter, session) {
    // Dispose must never mask the original failure it is cleaning up after.
    try {
      await adapter.dispose(session);
    } catch (error) {
      this.logger('warn', 'game_session_dispose_failed', { error: String(error?.message ?? error) });
    }
  }
}
