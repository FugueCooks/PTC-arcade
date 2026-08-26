import assert from 'node:assert/strict';
import test from 'node:test';
import { loadGameRegistry } from '../server/src/games/game-registry-service.js';
import { GameLauncherService } from '../server/src/games/game-launcher-service.js';
import { GameSession } from '../server/src/games/game-session.js';

const input = { subjectId: 'subject', playerId: 'player', roomId: 'room', cabinetId: 'crash-bandicoot',
  gameId: 'crash-bandicoot', emulatorAdapterId: 'legacy-browser-emulator' };

void test('game session validates lifecycle transitions and repeated stop/dispose is harmless', () => {
  const session = new GameSession(input, 10, 'session');
  session.transition('PREFLIGHT', 11); session.transition('READY', 12); session.transition('STARTING', 13); session.transition('ACTIVE', 14);
  assert.equal(session.stop('exit', 15).status, 'COMPLETED');
  assert.equal(session.stop('again', 16).status, 'COMPLETED');
  assert.equal(session.dispose(17).status, 'DISPOSED');
  assert.equal(session.dispose(18).status, 'DISPOSED');
});

void test('invalid game session transition is rejected', () => {
  const session = new GameSession(input);
  assert.throws(() => session.transition('ACTIVE'), /Invalid game session transition/);
});

void test('launcher resolves cabinet to game to compatibility adapter without ROM data', () => {
  const launcher = new GameLauncherService(loadGameRegistry().registry);
  const grant = launcher.create({ subjectId: 'subject', playerId: 'player', roomId: 'main', cabinetId: 'crash-bandicoot' });
  assert.equal(grant.game.id, 'crash-bandicoot');
  // This branch resolves the real adapter per platform rather than a single
  // catch-all: Crash Bandicoot is PlayStation, so it runs on EmulatorJS.
  assert.equal(grant.session.record.emulatorAdapterId, 'emulatorjs');
  // The session record must never carry ROM data or a disc file name.
  assert.equal(JSON.stringify(grant.session.record).includes('.pbp'), false);
});
