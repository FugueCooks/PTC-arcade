/**
 * The seats at a cabinet, as a player sees them.
 *
 * A match is entirely the server's: this renders what it reports and sends what
 * the player asks for, and never decides anything itself. It does not pick a
 * seat, does not know who hosts until told, and cannot start a game — every one
 * of those is refused server-side anyway, and duplicating the rule here would
 * only create somewhere for the two to disagree.
 *
 * Kept out of arcade.js so it can be tested without a WebGL context.
 */

const READY = 'READY';
const NOT_READY = 'NOT READY';

/** Text for a state, in the arcade's voice. */
const STATE_TEXT = Object.freeze({
  forming: 'WAITING FOR PLAYERS',
  ready: 'ALL PLAYERS READY',
  running: 'IN PROGRESS',
  finished: 'MATCH OVER',
  abandoned: 'MATCH ENDED'
});

/** Why a request was refused, in words a player can act on. */
const REFUSAL_TEXT = Object.freeze({
  'match-full': 'This cabinet is full.',
  'too-far': 'Step up to the cabinet to join.',
  'player-elsewhere': 'Leave your current game first.',
  'match-started': 'This match has already started.',
  'unknown-match': 'Nobody has started a game here yet.',
  'unknown-cabinet': 'That cabinet is not here.',
  'not-host': 'Only the player who started the cabinet can begin the match.',
  'not-ready': 'Everyone has to be ready first.',
  'not-enough-players': 'This game needs another player.',
  'not-seated': 'Take a seat first.',
  'invalid-request': 'That request could not be sent.'
});

export class MatchPanel {
  #root;
  #socket;
  #playerId;
  #matches = new Map();
  #cabinetId = null;
  #onChange;

  /**
   * @param root         element the panel renders into
   * @param socket       the arcade socket, or anything with emit/on
   * @param playerId     this player, so "you" can be marked without asking
   * @param onChange     told when the shown match changes, for the launcher
   */
  constructor({ root, socket, playerId = null, onChange = () => {} }) {
    this.#root = root;
    this.#socket = socket;
    this.#playerId = playerId;
    this.#onChange = onChange;

    socket.on('match:opened', (match) => this.#store(match));
    socket.on('match:changed', (match) => this.#store(match));
    socket.on('match:closed', ({ cabinetId }) => {
      this.#matches.delete(cabinetId);
      if (cabinetId === this.#cabinetId) this.render();
    });
  }

  /**
   * Who "you" are, settable after construction. The socket is wired before the
   * server has said which player this is, and a panel that captured undefined
   * would mark nobody's seat as theirs and offer the host no controls.
   */
  set playerId(value) {
    if (value === this.#playerId) return;
    this.#playerId = value;
    this.render();
  }

  get playerId() { return this.#playerId; }

  #store(match) {
    if (!match?.cabinetId) return;
    this.#matches.set(match.cabinetId, match);
    if (match.cabinetId === this.#cabinetId) {
      this.render();
      this.#onChange(match);
    }
  }

  /** The match at a cabinet, if the server has told us about one. */
  matchAt(cabinetId) {
    return this.#matches.get(cabinetId) ?? null;
  }

  seatOf(cabinetId) {
    return this.matchAt(cabinetId)?.seats.find((seat) => seat.playerId === this.#playerId) ?? null;
  }

  /** Shows the panel for a cabinet, or hides it where a match cannot happen. */
  show(cabinetId, { maxPlayers = 1 } = {}) {
    this.#cabinetId = cabinetId;
    // A one-player cabinet has nothing to show: seats, ready and host only mean
    // something where more than one person can sit down.
    this.#root.hidden = maxPlayers <= 1;
    this.render();
  }

  hide() {
    this.#cabinetId = null;
    this.#root.hidden = true;
  }

  render() {
    if (this.#root.hidden || !this.#cabinetId) return;
    const match = this.matchAt(this.#cabinetId);
    this.#root.replaceChildren();

    if (!match) {
      this.#root.append(line('status', 'NOBODY HAS STARTED A GAME HERE YET'));
      return;
    }

    const mySeat = this.seatOf(this.#cabinetId);
    const isHost = match.hostPlayerId === this.#playerId;

    this.#root.append(line('status',
      `${STATE_TEXT[match.state] ?? match.state.toUpperCase()} · ${match.seats.length}/${match.maxPlayers}`));

    const seats = document.createElement('ul');
    seats.className = 'match-seats';
    for (let index = 0; index < match.maxPlayers; index += 1) {
      const seat = match.seats.find((entry) => entry.seatIndex === index);
      const item = document.createElement('li');
      item.className = 'match-seat';
      if (!seat) {
        item.classList.add('empty');
        item.textContent = `P${index + 1} · OPEN`;
      } else {
        item.classList.toggle('is-you', seat.playerId === this.#playerId);
        item.dataset.ready = String(seat.ready);
        // textContent throughout: a display name is player-supplied.
        item.textContent = `P${index + 1} · ${seat.displayName}${seat.seatIndex === 0 ? ' (HOST)' : ''}`
          + ` · ${seat.ready ? READY : NOT_READY}`;
      }
      seats.append(item);
    }
    this.#root.append(seats);

    if (match.state === 'running' || match.state === 'finished') return;

    const actions = document.createElement('div');
    actions.className = 'match-actions';

    if (!mySeat) {
      actions.append(button('match-join', 'TAKE A SEAT', () => this.join()));
    } else {
      actions.append(button('match-ready', mySeat.ready ? 'NOT READY' : 'READY UP',
        () => this.setReady(!mySeat.ready)));
      // Shown to the host always, so the reason it is disabled is visible
      // rather than the button simply being absent.
      if (isHost) {
        const start = button('match-start', 'START MATCH', () => this.start());
        start.disabled = match.state !== 'ready';
        actions.append(start);
      }
      actions.append(button('match-leave', 'LEAVE SEAT', () => this.leave()));
    }
    this.#root.append(actions);
  }

  async join() {
    const response = await this.#ask('match:join', { cabinetId: this.#cabinetId });
    if (!response?.ok) this.#say(response?.reason);
  }

  async setReady(ready) {
    const response = await this.#ask('match:ready', { ready });
    if (!response?.ok) this.#say(response?.reason);
  }

  async start() {
    const response = await this.#ask('match:start', {});
    if (!response?.ok) this.#say(response?.reason);
  }

  async leave() {
    await this.#ask('match:leave', {});
  }

  #ask(event, payload) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (response) => { if (!settled) { settled = true; resolve(response); } };
      // A socket that never acknowledges must not leave the panel waiting on a
      // promise that never settles.
      const timer = setTimeout(() => done({ ok: false, reason: 'invalid-request' }), 5_000);
      this.#socket.emit(event, payload, (response) => { clearTimeout(timer); done(response); });
    });
  }

  #say(reason) {
    const existing = this.#root.querySelector('.match-message');
    const text = REFUSAL_TEXT[reason] ?? 'That did not work.';
    if (existing) { existing.textContent = text; return; }
    this.#root.append(line('match-message', text));
  }
}

function line(className, text) {
  const element = document.createElement('p');
  element.className = className;
  element.textContent = text;
  return element;
}

function button(id, label, onClick) {
  const element = document.createElement('button');
  element.type = 'button';
  element.id = id;
  element.textContent = label;
  element.addEventListener('click', onClick);
  return element;
}

export { REFUSAL_TEXT, STATE_TEXT };
