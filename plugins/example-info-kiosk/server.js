/**
 * Milestone 11.12 — first-party example plugin.
 *
 * Deliberately boring: it reads room population and keeps a view counter. The
 * point is to exercise the whole architecture end to end — manifest,
 * configuration, permissions, namespaced storage, lifecycle, logging, cleanup —
 * without introducing gameplay. It is the reference for what a plugin may do
 * and, just as usefully, a demonstration of how little it needs.
 *
 * Note what this file never touches: no database, no Redis, no filesystem, no
 * socket, no environment. Everything reaches the platform through `context`.
 */
import manifest from './manifest.json' with { type: 'json' };

const VIEW_COUNT_KEY = 'view-count';

export function createInfoKioskPlugin() {
  let context = null;
  let refreshTimer = null;

  return {
    manifest,

    async initialize(pluginContext) {
      context = pluginContext;
      // Touch storage during initialize so a quota or permission problem
      // surfaces at startup rather than the first time a player walks up.
      const storage = context.requireStorage();
      const existing = await storage.get(VIEW_COUNT_KEY);
      if (typeof existing !== 'number') await storage.set(VIEW_COUNT_KEY, 0);
      context.log('info', 'info_kiosk_initialized', { greeting: context.configuration.greeting ?? null });
    },

    async start() {
      context.registerWorldInteraction('info-kiosk');
      context.registerDashboardWidget('info-kiosk-views');

      const seconds = Number(context.configuration.refreshSeconds ?? 30);
      // unref so a plugin timer can never hold the process open during drain.
      refreshTimer = setInterval(() => undefined, seconds * 1_000);
      refreshTimer.unref?.();
      context.log('info', 'info_kiosk_started', { refreshSeconds: seconds });
    },

    async stop(reason) {
      if (refreshTimer !== null) { clearInterval(refreshTimer); refreshTimer = null; }
      context?.log('info', 'info_kiosk_stopped', { reason });
    },

    async dispose() {
      // Cleanup is stop's job here; storage is deliberately left in place so a
      // restart keeps its counter. Uninstall is what erases the namespace.
      if (refreshTimer !== null) { clearInterval(refreshTimer); refreshTimer = null; }
      context = null;
    },

    /** The kiosk's only behaviour, exposed for tests and the dashboard widget. */
    async view(roomId) {
      const storage = context.requireStorage();
      const current = await storage.get(VIEW_COUNT_KEY);
      const views = (typeof current === 'number' ? current : 0) + 1;
      await storage.set(VIEW_COUNT_KEY, views);

      const room = context.configuration.showPopulation === false ? undefined : context.readRoomState(roomId);
      return {
        greeting: String(context.configuration.greeting ?? 'WELCOME'),
        population: room?.population ?? null,
        views
      };
    }
  };
}
