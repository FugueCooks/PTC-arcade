import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { WorldActivityLevel, WorldAnnouncement, WorldEvent, WorldState } from '../protocol.js';
import type { PlayerEvent, PlayerManager } from '../players/player-manager.js';

export type WorldManagerEvent =
  | { type: 'WorldStateChanged'; state: WorldState }
  | { type: 'WorldAnnouncement'; announcement: WorldAnnouncement }
  | { type: 'WorldEventTriggered'; event: WorldEvent };

interface WorldConfig { defaultThemeId: string; defaultWeatherId: string; themes: Array<{ id: string }>; weather: Array<{ id: string }> }

/** Owns persistent-in-memory, room-specific environmental state. */
export class WorldManager {
  private readonly states = new Map<string, WorldState>();
  private readonly listeners = new Set<(event: WorldManagerEvent) => void>();
  private readonly config: WorldConfig;

  constructor(private readonly players: PlayerManager) {
    this.config = loadConfig();
  }

  subscribe(listener: (event: WorldManagerEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  snapshot(roomId: string): WorldState { return cloneState(this.ensure(roomId)); }

  handlePlayerEvent(event: PlayerEvent, now = Date.now()): void {
    if (!['PlayerJoined', 'PlayerReconnected', 'PlayerDisconnected', 'PlayerLeft'].includes(event.type)) return;
    const state = this.ensure(event.roomId);
    const population = this.players.connectedPlayersInRoom(event.roomId).length;
    const nextActivity = activityFor(population);
    if (state.population === population && state.activityLevel === nextActivity) return;
    const previousActivity = state.activityLevel;
    state.population = population; state.activityLevel = nextActivity; state.revision += 1;
    this.publish({ type: 'WorldStateChanged', state: cloneState(state) });
    if (nextActivity === 'busy' && previousActivity !== 'busy') this.announce(event.roomId, 'The arcade is getting busy.', 'activity', now);
  }

  setTheme(roomId: string, themeId: string): boolean {
    if (!this.config.themes.some((theme) => theme.id === themeId)) return false;
    const state = this.ensure(roomId); if (state.themeId === themeId) return true;
    state.themeId = themeId; state.revision += 1; this.publish({ type: 'WorldStateChanged', state: cloneState(state) }); return true;
  }

  setWeather(roomId: string, weatherId: string): boolean {
    if (!this.config.weather.some((weather) => weather.id === weatherId)) return false;
    const state = this.ensure(roomId); if (state.weatherId === weatherId) return true;
    state.weatherId = weatherId; state.revision += 1; this.publish({ type: 'WorldStateChanged', state: cloneState(state) }); return true;
  }

  announce(roomId: string, text: string, kind: WorldAnnouncement['kind'] = 'event', now = Date.now()): void {
    this.publish({ type: 'WorldAnnouncement', announcement: { id: randomUUID(), roomId, text, kind, at: now } });
  }

  trigger(roomId: string, type: WorldEvent['type'], durationMs = 2_500, now = Date.now()): void {
    this.publish({ type: 'WorldEventTriggered', event: { id: randomUUID(), roomId, type, at: now, durationMs } });
  }

  private ensure(roomId: string): WorldState {
    let state = this.states.get(roomId);
    if (!state) {
      state = { roomId, themeId: this.config.defaultThemeId, weatherId: this.config.defaultWeatherId, activityLevel: 'quiet', population: 0, revision: 1 };
      this.states.set(roomId, state);
    }
    return state;
  }

  private publish(event: WorldManagerEvent): void { this.listeners.forEach((listener) => listener(event)); }
}

function activityFor(population: number): WorldActivityLevel { return population >= 4 ? 'busy' : population >= 2 ? 'active' : 'quiet'; }
function cloneState(state: WorldState): WorldState { return { ...state }; }
function loadConfig(): WorldConfig {
  const parsed = JSON.parse(readFileSync(path.resolve(process.cwd(), 'assets', 'world', 'config.json'), 'utf8')) as Partial<WorldConfig>;
  if (typeof parsed.defaultThemeId !== 'string' || typeof parsed.defaultWeatherId !== 'string' || !Array.isArray(parsed.themes) || !Array.isArray(parsed.weather)) throw new Error('World configuration is invalid.');
  return parsed as WorldConfig;
}
