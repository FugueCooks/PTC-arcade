import assert from 'node:assert/strict';
import test from 'node:test';
import { GameRegistryService } from '../server/src/games/game-registry-service.js';
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
  const launcher = new GameLauncherService(new GameRegistryService());
  const grant = launcher.create({ subjectId: 'subject', playerId: 'player', roomId: 'main', cabinetId: 'crash-bandicoot' });
  assert.equal(grant.game.id, 'crash-bandicoot');
  assert.equal(grant.session.record.emulatorAdapterId, 'legacy-browser-emulator');
  assert.equal(JSON.stringify(grant.session.record).includes('.pbp'), false);
});
