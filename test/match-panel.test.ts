import assert from 'node:assert/strict';
import test from 'node:test';
import { importBrowserModule } from './helpers/browser-module.js';

const { MatchPanel } = await importBrowserModule<any>('matches/match-panel.js');

/**
 * The panel is tested against a small DOM stand-in rather than a real browser,
 * because what matters is what it sends and what it renders — neither needs a
 * layout engine, and the arcade page cannot boot without WebGL.
 */
function fakeDocument() {
  const make = (tag: string): any => ({
    tagName: tag.toUpperCase(), children: [] as any[], className: '', id: '', type: '',
    textContent: '', hidden: false, disabled: false, dataset: {} as Record<string, string>,
    classList: {
      names: new Set<string>(),
      add(...n: string[]) { n.forEach((x) => this.names.add(x)); },
      toggle(n: string, on: boolean) { if (on) this.names.add(n); else this.names.delete(n); },
      contains(n: string) { return this.names.has(n); }
    },
    listeners: {} as Record<string, () => void>,
    addEventListener(event: string, handler: () => void) { this.listeners[event] = handler; },
    append(...kids: any[]) { this.children.push(...kids); },
    replaceChildren(...kids: any[]) { this.children = kids; },
    querySelector(selector: string) { return findAll(this).find((n) => matches(n, selector)) ?? null; }
  });
  (globalThis as any).document = { createElement: make };
  return make('div');
}

function findAll(node: any): any[] {
  return [node, ...node.children.flatMap((child: any) => findAll(child))];
}
function matches(node: any, selector: string): boolean {
  if (selector.startsWith('.')) return node.className?.split(' ').includes(selector.slice(1));
  if (selector.startsWith('#')) return node.id === selector.slice(1);
  return false;
}

/** Records what the panel emits and lets a test answer it. */
function fakeSocket(answer: (event: string, payload: unknown) => unknown = () => ({ ok: true })) {
  const sent: Array<{ event: string; payload: any }> = [];
  const handlers = new Map<string, (payload: any) => void>();
  return {
    sent, handlers,
    on(event: string, handler: (payload: any) => void) { handlers.set(event, handler); },
    emit(event: string, payload: any, acknowledge?: (r: unknown) => void) {
      sent.push({ event, payload });
      acknowledge?.(answer(event, payload));
    },
    receive(event: string, payload: unknown) { handlers.get(event)?.(payload); }
  };
}

const MATCH = {
  matchId: 'mt-1', cabinetId: 'gamecube-cabinet-04', gameId: 'super-smash-bros-melee',
  state: 'forming', maxPlayers: 4, minPlayers: 2, hostPlayerId: 'host',
  seats: [{ seatIndex: 0, playerId: 'host', displayName: 'HOST', ready: false }],
  result: null
};

function panelFor(playerId: string, answer?: (event: string, payload: unknown) => unknown) {
  const root = fakeDocument();
  const socket = fakeSocket(answer);
  const panel = new MatchPanel({ root, socket, playerId });
  return { root, socket, panel };
}

const texts = (root: any) => findAll(root).map((n) => n.textContent).filter(Boolean);

void test('a cabinet nobody has started shows that, rather than nothing', () => {
  const { root, panel } = panelFor('p2');
  panel.show('gamecube-cabinet-04', { maxPlayers: 4 });
  assert.match(texts(root).join(' | '), /NOBODY HAS STARTED/);
});

void test('a single-player cabinet shows no panel at all', () => {
  // Seats, ready and host mean nothing where one person plays.
  const { root, panel } = panelFor('p1');
  panel.show('megaman-cabinet-01', { maxPlayers: 1 });
  assert.equal(root.hidden, true);
});

void test('every seat is drawn, including the empty ones', () => {
  // A player needs to see that there is room before deciding to walk over.
  const { root, socket, panel } = panelFor('p2');
  panel.show('gamecube-cabinet-04', { maxPlayers: 4 });
  socket.receive('match:opened', MATCH);

  const rendered = texts(root).join(' | ');
  assert.match(rendered, /P1 · HOST \(HOST\) · NOT READY/);
  assert.match(rendered, /P2 · OPEN/);
  assert.match(rendered, /P4 · OPEN/);
  assert.match(rendered, /WAITING FOR PLAYERS · 1\/4/);
});

void test('an unseated player is offered a seat, and taking it asks the server', () => {
  const { root, socket, panel } = panelFor('p2');
  panel.show('gamecube-cabinet-04', { maxPlayers: 4 });
  socket.receive('match:opened', MATCH);

  const join = root.querySelector('#match-join');
  assert.ok(join, 'an unseated player must be offered a seat');
  join.listeners.click();
  assert.deepEqual(socket.sent.at(-1), { event: 'match:join', payload: { cabinetId: 'gamecube-cabinet-04' } });
});

void test('a seated player readies up, and the panel never decides the seat', () => {
  const seated = { ...MATCH, seats: [...MATCH.seats, { seatIndex: 1, playerId: 'p2', displayName: 'TWO', ready: false }] };
  const { root, socket, panel } = panelFor('p2');
  panel.show('gamecube-cabinet-04', { maxPlayers: 4 });
  socket.receive('match:opened', seated);

  assert.equal(root.querySelector('#match-join'), null, 'a seated player is not offered another seat');
  root.querySelector('#match-ready').listeners.click();
  assert.deepEqual(socket.sent.at(-1), { event: 'match:ready', payload: { ready: true } });

  // Nothing the panel sends names a seat: that is the server's to choose.
  for (const { payload } of socket.sent) assert.ok(!('seatIndex' in (payload ?? {})));
});

void test('only the host sees start, and it waits until everyone is ready', () => {
  const seats = [
    { seatIndex: 0, playerId: 'host', displayName: 'HOST', ready: true },
    { seatIndex: 1, playerId: 'p2', displayName: 'TWO', ready: false }
  ];
  const asHost = panelFor('host');
  asHost.panel.show('gamecube-cabinet-04', { maxPlayers: 4 });
  asHost.socket.receive('match:opened', { ...MATCH, seats });

  const start = asHost.root.querySelector('#match-start');
  assert.ok(start, 'the host must see the control');
  assert.equal(start.disabled, true, 'and see why it cannot be pressed yet');

  const asGuest = panelFor('p2');
  asGuest.panel.show('gamecube-cabinet-04', { maxPlayers: 4 });
  asGuest.socket.receive('match:opened', { ...MATCH, seats });
  assert.equal(asGuest.root.querySelector('#match-start'), null, 'nobody else is offered it');
});

void test('start becomes pressable once the server says the match is ready', () => {
  const seats = [
    { seatIndex: 0, playerId: 'host', displayName: 'HOST', ready: true },
    { seatIndex: 1, playerId: 'p2', displayName: 'TWO', ready: true }
  ];
  const { root, socket, panel } = panelFor('host');
  panel.show('gamecube-cabinet-04', { maxPlayers: 4 });
  socket.receive('match:changed', { ...MATCH, state: 'ready', seats });

  const start = root.querySelector('#match-start');
  assert.equal(start.disabled, false);
  start.listeners.click();
  assert.equal(socket.sent.at(-1)?.event, 'match:start');
});

void test('a running match offers no controls', () => {
  const { root, socket, panel } = panelFor('host');
  panel.show('gamecube-cabinet-04', { maxPlayers: 4 });
  socket.receive('match:changed', { ...MATCH, state: 'running' });

  assert.match(texts(root).join(' '), /IN PROGRESS/);
  for (const id of ['#match-join', '#match-ready', '#match-start', '#match-leave']) {
    assert.equal(root.querySelector(id), null, `${id} must not be offered mid-game`);
  }
});

void test('a refusal is shown in words, not as a code', () => {
  const { root, panel } = panelFor('p2', () => ({ ok: false, reason: 'too-far' }));
  panel.show('gamecube-cabinet-04', { maxPlayers: 4 });
  return panel.join().then(() => {
    assert.match(texts(root).join(' '), /Step up to the cabinet/);
  });
});

void test('an unknown refusal still says something', () => {
  const { root, panel } = panelFor('p2', () => ({ ok: false, reason: 'something-new' }));
  panel.show('gamecube-cabinet-04', { maxPlayers: 4 });
  return panel.join().then(() => assert.match(texts(root).join(' '), /did not work/));
});

void test('a closed match clears the cabinet', () => {
  const { root, socket, panel } = panelFor('p2');
  panel.show('gamecube-cabinet-04', { maxPlayers: 4 });
  socket.receive('match:opened', MATCH);
  socket.receive('match:closed', { matchId: 'mt-1', cabinetId: 'gamecube-cabinet-04' });
  assert.match(texts(root).join(' '), /NOBODY HAS STARTED/);
  assert.equal(panel.matchAt('gamecube-cabinet-04'), null);
});

void test('a match at another cabinet does not redraw this one', () => {
  const { root, socket, panel } = panelFor('p2');
  panel.show('gamecube-cabinet-04', { maxPlayers: 4 });
  socket.receive('match:opened', { ...MATCH, cabinetId: 'gamecube-cabinet-01', seats: [] });
  assert.match(texts(root).join(' '), /NOBODY HAS STARTED/);
  assert.ok(panel.matchAt('gamecube-cabinet-01'), 'but it is still remembered for when they walk over');
});

void test('a display name is never treated as markup', () => {
  // Names are player-supplied and reach the panel over a socket.
  const hostile = { ...MATCH, seats: [{ seatIndex: 0, playerId: 'host', displayName: '<img src=x onerror=alert(1)>', ready: false }] };
  const { root, socket, panel } = panelFor('p2');
  panel.show('gamecube-cabinet-04', { maxPlayers: 4 });
  socket.receive('match:opened', hostile);

  const seat = findAll(root).find((n) => n.className === 'match-seat');
  assert.ok(seat.textContent.includes('<img'), 'the name is shown as text');
  assert.equal(seat.innerHTML, undefined, 'and never assigned as markup');
});

void test('a socket that never answers does not hang the panel', () => {
  const root = fakeDocument();
  const silent = { on() {}, emit() { /* no acknowledgement, ever */ } };
  const panel = new MatchPanel({ root, socket: silent, playerId: 'p2' });
  panel.show('gamecube-cabinet-04', { maxPlayers: 4 });
  // Resolves through the timeout rather than waiting forever.
  return panel.join();
});
