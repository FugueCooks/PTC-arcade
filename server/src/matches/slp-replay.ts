/**
 * Reading a Slippi replay well enough to say who won.
 *
 * A match played on players' own machines reports its own outcome, which is
 * worth what it sounds like. A replay is different: it is a record of the
 * inputs and the resulting state, written by the emulator as the game ran, so a
 * result derived from it is derived from evidence rather than from a claim.
 * That is the whole reason this exists — it is what turns a `client-reported`
 * result into a `verified` one.
 *
 * The file is a UBJSON envelope wrapping a stream of binary events. Crucially
 * the stream begins with a table declaring how long every other event is, so
 * this parser reads those lengths from the file rather than hardcoding them,
 * and can walk a replay written by a newer Slippi than it has ever seen.
 *
 * Treated as hostile input throughout. A replay arrives from a player's machine
 * and is the evidence for who won; a parser that trusts its lengths is a parser
 * that can be handed a file which reads past the end of the buffer.
 */

export const EVENT_PAYLOADS = 0x35;
export const GAME_START = 0x36;
export const PRE_FRAME_UPDATE = 0x37;
export const POST_FRAME_UPDATE = 0x38;
export const GAME_END = 0x39;

/** How a game ended, as Melee reports it. */
export const END_METHOD = Object.freeze({
  UNRESOLVED: 0,
  TIME: 1,
  GAME: 2,
  NO_CONTEST_LEGACY: 3,
  NO_CONTEST: 7
});

export interface SlpPlayer {
  port: number;
  externalCharacterId: number;
  /** 0 human, 1 CPU, 2 demo, 3 empty. Only human ports are real players. */
  playerType: number;
  stockStartCount: number;
  stocksRemaining: number | null;
  percent: number | null;
}

export interface SlpGame {
  version: string;
  stageId: number | null;
  players: SlpPlayer[];
  lastFrame: number | null;
  endMethod: number | null;
  /** Port that quit out, when the file records one. */
  lrasInitiatorPort: number | null;
}

export interface SlpParseFailure { ok: false; reason: string }
export type SlpParseResult = { ok: true; game: SlpGame } | SlpParseFailure;

/**
 * The UBJSON envelope's opening bytes: `{`, `U`, a length-3 key, `raw`, then
 * the array header. Written as bytes rather than a string literal because one
 * of them is an unprintable 0x03 — invisible in source, and a test that retyped
 * the literal by hand silently built a header one byte short.
 */
export const UBJSON_PREFIX = Buffer.from([0x7b, 0x55, 0x03, 0x72, 0x61, 0x77, 0x5b, 0x24, 0x55, 0x23, 0x6c]);
/** A replay of a full Melee set is a few megabytes; far past that is not one. */
const MAX_RAW_BYTES = 200 * 1024 * 1024;

/**
 * Locates the raw event stream inside the envelope.
 *
 * Length-prefixed, and the prefix is the file's own claim about itself — so it
 * is clamped to what is actually present rather than believed.
 */
export function readRawSection(file: Buffer): { ok: true; raw: Buffer } | SlpParseFailure {
  if (file.length < UBJSON_PREFIX.length + 4) return { ok: false, reason: 'too-short' };
  if (!file.subarray(0, UBJSON_PREFIX.length).equals(UBJSON_PREFIX)) return { ok: false, reason: 'not-a-slp-file' };

  const declared = file.readUInt32BE(UBJSON_PREFIX.length);
  if (declared === 0) return { ok: false, reason: 'empty-replay' };
  if (declared > MAX_RAW_BYTES) return { ok: false, reason: 'implausible-length' };

  const start = UBJSON_PREFIX.length + 4;
  // A truncated upload should yield what is there rather than a throw: a game
  // that ended in a crash still has a winner in the frames that survived.
  const end = Math.min(start + declared, file.length);
  return { ok: true, raw: file.subarray(start, end) };
}

/**
 * The command-size table.
 *
 * Every event's length is declared here, which is what lets a replay from a
 * newer Slippi be walked by an older parser: unknown commands are skipped by
 * their stated length instead of derailing the stream.
 */
export function readPayloadSizes(raw: Buffer): { ok: true; sizes: Map<number, number>; headerBytes: number } | SlpParseFailure {
  if (raw.length < 2 || raw[0] !== EVENT_PAYLOADS) return { ok: false, reason: 'missing-payload-table' };
  const tableLength = raw[1];
  // The table's own length byte counts itself, then three bytes per command.
  if (tableLength < 1 || (tableLength - 1) % 3 !== 0) return { ok: false, reason: 'malformed-payload-table' };
  const commandCount = (tableLength - 1) / 3;
  if (raw.length < 2 + commandCount * 3) return { ok: false, reason: 'truncated-payload-table' };

  const sizes = new Map<number, number>();
  for (let index = 0; index < commandCount; index += 1) {
    const at = 2 + index * 3;
    sizes.set(raw[at], raw.readUInt16BE(at + 1));
  }
  return { ok: true, sizes, headerBytes: 1 + tableLength };
}

export function parseReplay(file: Buffer): SlpParseResult {
  const section = readRawSection(file);
  if (!section.ok) return section;
  const table = readPayloadSizes(section.raw);
  if (!table.ok) return table;

  const { raw } = section;
  const { sizes } = table;
  let cursor = table.headerBytes;

  const players = new Map<number, SlpPlayer>();
  const game: SlpGame = {
    version: '0.0.0', stageId: null, players: [], lastFrame: null, endMethod: null, lrasInitiatorPort: null
  };
  let sawGameStart = false;

  while (cursor < raw.length) {
    const command = raw[cursor];
    const size = sizes.get(command);
    // An event the table never declared means the stream is no longer aligned,
    // and guessing a length from here would read fabricated fields.
    if (size === undefined) return { ok: false, reason: 'unknown-event' };
    const body = raw.subarray(cursor + 1, cursor + 1 + size);
    if (body.length < size) break; // Truncated tail: keep what was read.
    cursor += 1 + size;

    if (command === GAME_START) {
      sawGameStart = true;
      readGameStart(body, game, players);
    } else if (command === POST_FRAME_UPDATE) {
      readPostFrame(body, game, players);
    } else if (command === GAME_END) {
      if (body.length >= 1) game.endMethod = body.readInt8(0);
      // Present from replay version 2.0.0; -1 means nobody quit.
      if (body.length >= 2) {
        const initiator = body.readInt8(1);
        game.lrasInitiatorPort = initiator >= 0 && initiator <= 3 ? initiator : null;
      }
    }
  }

  if (!sawGameStart) return { ok: false, reason: 'no-game-start' };
  game.players = [...players.values()].sort((a, b) => a.port - b.port);
  return { ok: true, game };
}

/**
 * Game start carries the version, the stage, and a fixed block per port.
 *
 * Offsets are read defensively: an older replay simply has a shorter body, and
 * a field that is not there is left null rather than read from whatever follows.
 */
function readGameStart(body: Buffer, game: SlpGame, players: Map<number, SlpPlayer>): void {
  if (body.length >= 4) game.version = `${body[0]}.${body[1]}.${body[2]}.${body[3]}`;

  // The Melee game-info block begins after the four version bytes; the stage
  // sits at a fixed offset inside it.
  const gameInfoAt = 4;
  const stageAt = gameInfoAt + 0x0e;
  if (body.length >= stageAt + 2) game.stageId = body.readUInt16BE(stageAt);

  // Four ports, 0x24 bytes each, starting after the game-info header.
  const playersAt = gameInfoAt + 0x60;
  for (let port = 0; port < 4; port += 1) {
    const at = playersAt + port * 0x24;
    if (body.length < at + 4) break;
    players.set(port, {
      port,
      externalCharacterId: body[at],
      playerType: body[at + 1],
      stockStartCount: body[at + 2],
      stocksRemaining: null,
      percent: null
    });
  }
}

/**
 * Post-frame state, kept only as "the most recent value seen".
 *
 * A replay of a five-minute game holds tens of thousands of these, and the only
 * thing the result depends on is where each port finished, so nothing is
 * retained per frame.
 */
function readPostFrame(body: Buffer, game: SlpGame, players: Map<number, SlpPlayer>): void {
  if (body.length < 6) return;
  const frame = body.readInt32BE(0);
  const port = body[4];
  const isFollower = body[5] !== 0;
  // Ice Climbers' partner shares a port and dies separately; counting it would
  // report the wrong stock count for that port.
  if (isFollower || port > 3) return;

  game.lastFrame = game.lastFrame === null ? frame : Math.max(game.lastFrame, frame);
  const player = players.get(port);
  if (!player) return;

  if (body.length >= 0x15 + 4) player.percent = body.readFloatBE(0x15);
  if (body.length >= 0x21) player.stocksRemaining = body[0x20];
}

export interface WinnerVerdict {
  outcome: 'winner' | 'draw' | 'undetermined';
  /** Port that won, when there is one. */
  port: number | null;
  /**
   * Whether this is safe to settle on.
   *
   * A stock count tells you who was ahead. It does not always tell you who won:
   * a game that ended in a disconnect with no quitter recorded had a leader,
   * not a winner. Everything a wager would settle on must read `true` here, and
   * the cases that do not are the cases a human should look at.
   */
  confident: boolean;
  reason: string;
}

/**
 * Who won, from the replay alone.
 *
 * Deliberately conservative. Where the file does not actually establish a
 * winner this says so instead of picking whoever was ahead — the whole point of
 * reading a replay is to stop guessing, and a guess dressed as evidence is
 * worse than an honest gap.
 */
export function determineWinner(game: SlpGame): WinnerVerdict {
  const contenders = game.players.filter((player) => player.playerType === 0);
  if (contenders.length < 2) {
    return { outcome: 'undetermined', port: null, confident: false, reason: 'not-a-versus-match' };
  }
  if (game.endMethod === null) {
    // No end event: the recording stopped before the game did.
    return { outcome: 'undetermined', port: null, confident: false, reason: 'no-game-end-event' };
  }

  // Somebody quit. The file names them, and they lost; with more than two
  // players it does not follow that any particular survivor won.
  if (game.lrasInitiatorPort !== null) {
    const remaining = contenders.filter((player) => player.port !== game.lrasInitiatorPort);
    if (remaining.length === 1) {
      return { outcome: 'winner', port: remaining[0].port, confident: true, reason: 'opponent-quit' };
    }
    return { outcome: 'undetermined', port: null, confident: false, reason: 'quit-in-multiplayer-match' };
  }

  if (game.endMethod === END_METHOD.NO_CONTEST || game.endMethod === END_METHOD.NO_CONTEST_LEGACY) {
    // Ended without a result and without naming who left. Stocks show who was
    // ahead; that is not the same as who won, so it is not settled here.
    return { outcome: 'undetermined', port: null, confident: false, reason: 'no-contest' };
  }

  if (game.endMethod !== END_METHOD.GAME && game.endMethod !== END_METHOD.TIME) {
    return { outcome: 'undetermined', port: null, confident: false, reason: `unresolved-end-method-${game.endMethod}` };
  }

  const withStocks = contenders.filter((player) => player.stocksRemaining !== null);
  if (withStocks.length !== contenders.length) {
    return { outcome: 'undetermined', port: null, confident: false, reason: 'missing-stock-counts' };
  }

  const best = Math.max(...withStocks.map((player) => player.stocksRemaining ?? 0));
  const leaders = withStocks.filter((player) => (player.stocksRemaining ?? 0) === best);
  if (best === 0) {
    return { outcome: 'undetermined', port: null, confident: false, reason: 'nobody-had-a-stock-left' };
  }
  if (leaders.length === 1) {
    return { outcome: 'winner', port: leaders[0].port, confident: true, reason: game.endMethod === END_METHOD.TIME ? 'ahead-on-stocks-at-time' : 'last-player-standing' };
  }

  // Level on stocks: Melee breaks a timeout on damage, lowest wins.
  if (game.endMethod === END_METHOD.TIME) {
    const percents = leaders.map((player) => player.percent);
    if (percents.some((percent) => percent === null)) {
      return { outcome: 'undetermined', port: null, confident: false, reason: 'missing-damage-for-tiebreak' };
    }
    const lowest = Math.min(...(percents as number[]));
    const cleanest = leaders.filter((player) => player.percent === lowest);
    if (cleanest.length === 1) {
      return { outcome: 'winner', port: cleanest[0].port, confident: true, reason: 'lower-damage-at-time' };
    }
    return { outcome: 'draw', port: null, confident: true, reason: 'level-on-stocks-and-damage' };
  }

  return { outcome: 'undetermined', port: null, confident: false, reason: 'tied-on-stocks' };
}
