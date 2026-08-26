import type { GameDefinition } from '../../../shared/platform-contracts.js';
import { CABINET_REGISTRY } from '../cabinets/cabinet-registry.js';
import type { GameRegistryService } from './game-registry-service.js';
import { GameSession, type NewGameSession } from './game-session.js';

export interface GameLaunchGrant { session: GameSession; game: GameDefinition }

/** Server-side launch authorization; actual emulator and ROM execution remain in the browser. */
export class GameLauncherService {
  private readonly cabinets = new Map(CABINET_REGISTRY.map((cabinet) => [cabinet.id, cabinet]));
  private readonly sessions = new Map<string, GameSession>();

  constructor(private readonly games: GameRegistryService) {}

  create(input: Omit<NewGameSession, 'gameId' | 'emulatorAdapterId'>): GameLaunchGrant {
    const cabinet = this.cabinets.get(input.cabinetId);
    if (!cabinet || !cabinet.enabled) throw new Error('Cabinet is unavailable.');
    const game = this.games.get(cabinet.gameId) ?? this.games.forLegacyCabinet(cabinet.id);
    if (!game?.enabled || !game.emulatorAdapterId) throw new Error('Game is unavailable.');
    const session = new GameSession({ ...input, gameId: game.id, emulatorAdapterId: game.emulatorAdapterId });
    this.sessions.set(session.record.sessionId, session);
    return { session, game };
  }

  get(sessionId: string): GameSession | undefined { return this.sessions.get(sessionId); }
  remove(sessionId: string): boolean { return this.sessions.delete(sessionId); }
  get activeCount(): number { return [...this.sessions.values()].filter(({ record }) => !['COMPLETED', 'FAILED', 'DISPOSED'].includes(record.status)).length; }
}
