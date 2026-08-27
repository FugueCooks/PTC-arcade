import assert from 'node:assert/strict';
import test from 'node:test';
import { MatchManager } from '../server/src/matches/match-manager.js';
import { bridgeMatchEvents, installMatchHandlers } from '../server/src/matches/match-sockets.js';

const CABINET = 'gamecube-cabinet-04';
const MELEE = { maxPlayers: 4, minPlayers: 2 };

/** A socket stand-in that records handlers and lets a test fire them. */
function harness() {
  const handlers = new Map<string, (payload: any, ack?: (r: unknown) => void) => void>();
  const matches = new MatchManager({ now: () => 1_000 });
  const positions = new Map<string, { playerId: string; displayName: string; roomId: string; position: [number, number, number] }>();
  const broadcasts: Array<{ roomId: string; event: string; payload: any }> = [];

  bridgeMatchEvents(matches, (roomId, event, payload) => broadcasts.push({ roomId, event, payload }));

  installMatchHandlers(
    { id: 's1', on: (event, handler) => handlers.set(event, handler) },
    {
      matches,
      playerFor: (socketId) => positions.get(socketId),
      cabinetPosition: (cabinetId) => (cabinetId === CABINET ? { x: 0, z: 0 } : undefined)
    }
  );

  const fire = (event: string, payload: unknown = {}) => new Promise<any>((resolve) => {
    const handler = handlers.get(event);
    if (!handler) throw new Error(`no handler for ${event}`);
    handler(payload, resolve);
  });

  const seat = (socketId: string, playerId: string, position: [number, number, number]) =>
    positions.set(socketId, { playerId, displayName: playerId.toUpperCase(), roomId: 'main', position });

  return { matches, fire, seat, broadcasts, handlers };
}

void test('a player standing at the cabinet takes a seat', async () => {
  const h = harness();
  h.matches.open('main', CABINET, 'melee', { playerId: 'host', displayName: 'HOST' }, MELEE);
  h.seat('s1', 'p2', [1, 1.65, 1]);

  const response = await h.fire('match:join', { cabinetId: CABINET });
  assert.equal(response.ok, true);
  assert.equal(response.seatIndex, 1);
  assert.equal(response.match.seats.length, 2);
});

void test('distance is measured on the server, never taken from the client', async () => {
  // A client that could send its own distance could seat itself from anywhere.
  const h = harness();
  h.matches.open('main', CABINET, 'melee', { playerId: 'host', displayName: 'HOST' }, MELEE);
  h.seat('s1', 'p2', [40, 1.65, 40]);

  const response = await h.fire('match:join', { cabinetId: CABINET, distance: 0 });
  assert.deepEqual(response, { ok: false, reason: 'too-far' });
});

void test('a malformed or unknown cabinet is refused without touching state', async () => {
  const h = harness();
  h.seat('s1', 'p2', [0, 1.65, 0]);
  for (const cabinetId of [undefined, '', 42, '../../etc', 'NOT-LOWER', 'x'.repeat(200)]) {
    const response = await h.fire('match:join', { cabinetId });
    assert.equal(response.ok, false, String(cabinetId));
  }
  assert.deepEqual(await h.fire('match:join', { cabinetId: 'no-such-cabinet' }), { ok: false, reason: 'unknown-cabinet' });
  assert.equal(h.matches.size, 0);
});

void test('a disconnected socket cannot act', async () => {
  const h = harness();
  h.matches.open('main', CABINET, 'melee', { playerId: 'host', displayName: 'HOST' }, MELEE);
  // No player registered for s1: the socket is gone.
  for (const event of ['match:join', 'match:ready', 'match:start', 'match:leave']) {
    const response = await h.fire(event, { cabinetId: CABINET, ready: true });
    assert.equal(response.ok, false, event);
  }
});

void test('only the host can start, and the client is not asked who that is', async () => {
  const h = harness();
  h.matches.open('main', CABINET, 'melee', { playerId: 'host', displayName: 'HOST' }, MELEE);
  h.seat('s1', 'p2', [1, 1.65, 1]);
  await h.fire('match:join', { cabinetId: CABINET });
  h.matches.ready('main', 'host', true);
  await h.fire('match:ready', { ready: true });

  // p2 is seated and ready, but seat one. Claiming otherwise changes nothing.
  const denied = await h.fire('match:start', { host: true, playerId: 'host' });
  assert.deepEqual(denied, { ok: false, reason: 'not-host' });
  assert.equal(h.matches.view('main', CABINET)?.state, 'ready');
});

void test('ready must be a boolean, not a truthy string', async () => {
  const h = harness();
  h.matches.open('main', CABINET, 'melee', { playerId: 'p2', displayName: 'P2' }, MELEE);
  h.seat('s1', 'p2', [0, 1.65, 0]);
  assert.deepEqual(await h.fire('match:ready', { ready: 'yes' }), { ok: false, reason: 'invalid-request' });
  assert.equal(h.matches.view('main', CABINET)?.seats[0].ready, false);
});

void test('leaving reports whether the match closed with it', async () => {
  const h = harness();
  h.matches.open('main', CABINET, 'melee', { playerId: 'p2', displayName: 'P2' }, MELEE);
  h.seat('s1', 'p2', [0, 1.65, 0]);
  assert.deepEqual(await h.fire('match:leave'), { ok: true, closed: true });
  assert.equal(h.matches.view('main', CABINET), null);
});

void test('the room hears about every change, once', async () => {
  const h = harness();
  h.matches.open('main', CABINET, 'melee', { playerId: 'host', displayName: 'HOST' }, MELEE);
  h.seat('s1', 'p2', [1, 1.65, 1]);
  await h.fire('match:join', { cabinetId: CABINET });
  await h.fire('match:leave');

  assert.deepEqual(h.broadcasts.map((b) => b.event), ['match:opened', 'match:changed', 'match:changed']);
  assert.ok(h.broadcasts.every((b) => b.roomId === 'main'));
});

void test('a closed match is announced with its cabinet, so clients can clear it', async () => {
  const h = harness();
  h.matches.open('main', CABINET, 'melee', { playerId: 'p2', displayName: 'P2' }, MELEE);
  h.seat('s1', 'p2', [0, 1.65, 0]);
  await h.fire('match:leave');

  const closed = h.broadcasts.at(-1)!;
  assert.equal(closed.event, 'match:closed');
  assert.equal(closed.payload.cabinetId, CABINET);
});

void test('a refusal never carries an exception', async () => {
  const h = harness();
  h.seat('s1', 'p2', [0, 1.65, 0]);
  const response = await h.fire('match:join', { cabinetId: 'no-such-cabinet' });
  const serialized = JSON.stringify(response);
  for (const leak of ['stack', 'Error', 'at ', 'server/src']) {
    assert.ok(!serialized.includes(leak), `a refusal must not carry ${leak}`);
  }
});
