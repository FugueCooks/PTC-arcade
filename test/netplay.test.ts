import assert from 'node:assert/strict';
import test from 'node:test';
import { createMatch, joinMatch, leaveMatch } from '../server/src/domain/match.js';
import {
  NetplayTransportRegistry, PortAllocator, planNetplay, seatPlanFor, type NetplayTransport
} from '../server/src/matches/netplay.js';
import {
  DOLPHIN_TRANSPORT, canConnectPlayers, createDefaultTransportRegistry
} from '../server/src/matches/netplay-transports.js';

const ADDRESSES: Record<string, string> = { p1: '203.0.113.7', p2: '198.51.100.4', p3: '198.51.100.9', p4: '198.51.100.11' };

function melee(seatCount: number) {
  const match = createMatch('mt-1', 'gamecube-cabinet-04', 'super-smash-bros-melee', { maxPlayers: 4, minPlayers: 2 }, 1_000);
  for (let index = 1; index <= seatCount; index += 1) {
    joinMatch(match, { playerId: `p${index}`, displayName: `PLAYER_${index}` }, 1_000 + index);
  }
  return match;
}

const plan = (match: ReturnType<typeof melee>, over: Partial<Parameters<typeof planNetplay>[0]> = {}) => planNetplay({
  match, platformId: 'gamecube', transports: createDefaultTransportRegistry(),
  addressOf: (id) => ADDRESSES[id], allocatePort: () => 2626, ...over
});

void test('seat zero hosts and everyone else is pointed at them', () => {
  const result = plan(melee(4));
  assert.ok(result.ok);
  assert.equal(result.plan.seats.length, 4);

  const [host, ...guests] = result.plan.seats;
  assert.equal(host.role, 'host');
  assert.equal(host.hostAddress, null, 'a host connects to nobody');
  for (const guest of guests) {
    assert.equal(guest.role, 'guest');
    assert.equal(guest.hostAddress, '203.0.113.7');
    assert.equal(guest.port, 2626);
  }
});

void test('the host is whoever the match says, not renegotiated here', () => {
  // If the seat order and the netplay roles could disagree, two clients would
  // each sit waiting for the other to host.
  const match = melee(3);
  leaveMatch(match, 'p1', 2_000);   // p2 is promoted to seat zero
  const result = plan(match);
  assert.ok(result.ok);
  assert.equal(result.plan.seats.find((seat) => seat.role === 'host')?.playerId, 'p2');
  assert.equal(result.plan.seats.find((seat) => seat.playerId === 'p3')?.hostAddress, ADDRESSES.p2);
});

void test("a seat's plan is only what that seat needs", () => {
  // The plan carries another player's address. Sent whole to the room, it would
  // hand that to everyone present rather than the people connecting.
  const result = plan(melee(3));
  assert.ok(result.ok);

  const mine = seatPlanFor(result.plan, 'p2');
  assert.equal(mine?.hostAddress, ADDRESSES.p1);
  assert.equal(JSON.stringify(mine).includes(ADDRESSES.p3), false, "no seat learns another guest's address");
  assert.equal(seatPlanFor(result.plan, 'nobody'), null);
});

void test('a platform with no netplay says so instead of pretending', () => {
  // Four people sitting down and discovering ten minutes later that they were
  // playing alone is the worst outcome available here.
  const psx = createMatch('mt-2', 'megaman-cabinet-04', 'mega-man-x4', { maxPlayers: 2, minPlayers: 2 }, 1_000);
  joinMatch(psx, { playerId: 'p1', displayName: 'ONE' }, 1_001);
  joinMatch(psx, { playerId: 'p2', displayName: 'TWO' }, 1_002);

  const result = plan(psx, { platformId: 'psx' });
  assert.equal(result.ok, false);
  // Distinct from an unknown platform: this one is known, and known not to work.
  assert.equal((result as { reason: string }).reason, 'transport-cannot-connect');

  const unknown = plan(psx, { platformId: 'dreamcast' });
  assert.equal((unknown as { reason: string }).reason, 'no-transport');
});

void test('every shipped platform states what it can do', () => {
  const registry = createDefaultTransportRegistry();
  for (const platform of ['gamecube', 'psx', 'n64', 'snes', 'ps2']) {
    assert.ok(registry.forPlatform(platform), `${platform} must state a transport, even a null one`);
  }
  assert.equal(canConnectPlayers(registry, 'gamecube'), true);
  for (const platform of ['psx', 'n64', 'snes', 'ps2']) {
    assert.equal(canConnectPlayers(registry, platform), false, `${platform} cannot connect players today`);
  }
});

void test('Dolphin is assisted, and says what the player must do', () => {
  // Dolphin has no netplay command line, so calling this `full` would have the
  // arcade reporting a match as connecting while it waits for a click nobody
  // has been told about.
  assert.equal(DOLPHIN_TRANSPORT.automation, 'assisted');
  assert.match(DOLPHIN_TRANSPORT.playerInstruction ?? '', /Netplay/);
  assert.match(DOLPHIN_TRANSPORT.playerInstruction ?? '', /Host|Connect/);
});

void test('an assisted transport that explains nothing is refused at registration', () => {
  const registry = new NetplayTransportRegistry();
  const silent: NetplayTransport = {
    id: 'silent', supportedPlatforms: ['dreamcast'], automation: 'assisted', playerInstruction: null
  };
  assert.throws(() => registry.register(silent), /tells the player nothing/);
});

void test('a duplicate transport id is refused', () => {
  const registry = createDefaultTransportRegistry();
  assert.throws(() => registry.register(DOLPHIN_TRANSPORT), /Duplicate/);
});

void test('a match of one is not a netplay session', () => {
  const result = plan(melee(1));
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, 'not-enough-players');
});

void test('an unknown host address stops the plan rather than guessing one', () => {
  const result = plan(melee(2), { addressOf: () => undefined });
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, 'host-address-unknown');
});

void test('concurrent matches never share a port', () => {
  const ports = new PortAllocator({ from: 2626, to: 2628 });
  const claimed = [ports.claim(), ports.claim(), ports.claim()];
  assert.deepEqual(claimed, [2626, 2627, 2628]);
  assert.equal(ports.claim(), null, 'a full range refuses rather than reusing');

  ports.release(2627);
  assert.equal(ports.claim(), 2627, 'a finished match gives its port back');
});

void test('a full port range fails the plan rather than doubling up', () => {
  const exhausted = new PortAllocator({ from: 2626, to: 2626 });
  exhausted.claim();
  const result = plan(melee(2), { allocatePort: () => exhausted.claim() });
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, 'no-port');
});

void test('nicknames come from the match, so both sides show the same names', () => {
  const result = plan(melee(2));
  assert.ok(result.ok);
  assert.deepEqual(result.plan.seats.map((seat) => seat.nickname), ['PLAYER_1', 'PLAYER_2']);
});

void test('no shipped game seats more players than its platform can connect', async () => {
  // The check that makes this system honest end to end. A four-seat cabinet on
  // a platform with no transport is four people who will each play alone, and
  // this is where that gets caught rather than at the cabinet.
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const registry = createDefaultTransportRegistry();
  const parsed = JSON.parse(await readFile(path.resolve(process.cwd(), 'assets/games/registry.json'), 'utf8'));

  const impossible = parsed.games
    .filter((game: any) => game.enabled && (game.maxPlayers ?? 1) > 1 && !canConnectPlayers(registry, game.system))
    .map((game: any) => `${game.id} seats ${game.maxPlayers} on ${game.system}, which cannot connect players`);

  assert.deepEqual(impossible, []);
});
