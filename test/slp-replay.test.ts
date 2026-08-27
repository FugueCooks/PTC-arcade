import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  END_METHOD, determineWinner, parseReplay, readPayloadSizes, readRawSection,
  UBJSON_PREFIX, type SlpGame, type SlpPlayer
} from '../server/src/matches/slp-replay.js';

/**
 * The winner rules are tested from constructed games rather than from replay
 * files, deliberately. Building a file and then parsing it back would only
 * prove the parser agrees with itself; these assert the judgement that decides
 * an outcome, which is the part worth being sure about.
 *
 * The parser itself was validated against 40 real replays spanning versions
 * 0.1.0.0 to 3.8.0.0 — see docs. Those files are LGPL and are not vendored
 * here; point SLP_CORPUS at a directory of replays to run against them.
 */
const human = (port: number, stocks: number | null, percent: number | null): SlpPlayer => ({
  port, externalCharacterId: 0, playerType: 0, stockStartCount: 4, stocksRemaining: stocks, percent
});

const game = (over: Partial<SlpGame>): SlpGame => ({
  version: '3.8.0.0', stageId: 31, players: [], lastFrame: 1_000,
  endMethod: END_METHOD.GAME, lrasInitiatorPort: null, ...over
});

void test('the last player with a stock wins', () => {
  const verdict = determineWinner(game({ players: [human(0, 1, 80), human(1, 0, 140)] }));
  assert.deepEqual(verdict, { outcome: 'winner', port: 0, confident: true, reason: 'last-player-standing' });
});

void test('a four-player game resolves to the one player left', () => {
  // The case the arcade is being built for.
  const verdict = determineWinner(game({
    players: [human(0, 0, 90), human(1, 2, 45), human(2, 0, 130), human(3, 0, 70)]
  }));
  assert.equal(verdict.outcome, 'winner');
  assert.equal(verdict.port, 1);
  assert.equal(verdict.confident, true);
});

void test('a quitter loses, and the file names them', () => {
  const verdict = determineWinner(game({
    endMethod: END_METHOD.NO_CONTEST, lrasInitiatorPort: 1,
    players: [human(0, 3, 20), human(1, 3, 25)]
  }));
  assert.deepEqual(verdict, { outcome: 'winner', port: 0, confident: true, reason: 'opponent-quit' });
});

void test('someone quitting a four-player game does not hand anyone the win', () => {
  // Three players remain. Which of them won is not something the quit tells us,
  // and picking one would be inventing a result.
  const verdict = determineWinner(game({
    endMethod: END_METHOD.NO_CONTEST, lrasInitiatorPort: 2,
    players: [human(0, 2, 30), human(1, 2, 30), human(2, 1, 60), human(3, 2, 30)]
  }));
  assert.equal(verdict.outcome, 'undetermined');
  assert.equal(verdict.confident, false);
});

void test('a timeout is decided on stocks, then on damage', () => {
  const onStocks = determineWinner(game({
    endMethod: END_METHOD.TIME, players: [human(0, 3, 120), human(1, 2, 10)]
  }));
  assert.equal(onStocks.port, 0, 'stocks come first, however much damage the leader has taken');

  const onDamage = determineWinner(game({
    endMethod: END_METHOD.TIME, players: [human(0, 2, 88), human(1, 2, 41)]
  }));
  assert.deepEqual(onDamage, { outcome: 'winner', port: 1, confident: true, reason: 'lower-damage-at-time' });
});

void test('level on both is a draw, and that is a confident answer', () => {
  // A draw is a real outcome, not a failure to decide: a wager on it refunds
  // rather than waits for a human.
  const verdict = determineWinner(game({
    endMethod: END_METHOD.TIME, players: [human(0, 2, 60), human(1, 2, 60)]
  }));
  assert.deepEqual(verdict, { outcome: 'draw', port: null, confident: true, reason: 'level-on-stocks-and-damage' });
});

void test('a no-contest with nobody named is never settled', () => {
  // Stocks show who was ahead. Ahead is not the same as won, and this is
  // exactly where a parser that guessed would quietly pay out the wrong player.
  const verdict = determineWinner(game({
    endMethod: END_METHOD.NO_CONTEST_LEGACY, players: [human(0, 3, 10), human(1, 0, 160)]
  }));
  assert.equal(verdict.outcome, 'undetermined');
  assert.equal(verdict.confident, false);
  assert.equal(verdict.reason, 'no-contest');
});

void test('a replay that never recorded an ending is not settled', () => {
  const verdict = determineWinner(game({ endMethod: null, players: [human(0, 2, 10), human(1, 1, 40)] }));
  assert.equal(verdict.confident, false);
  assert.equal(verdict.reason, 'no-game-end-event');
});

void test('an unresolved end method is not read as a win', () => {
  const verdict = determineWinner(game({
    endMethod: END_METHOD.UNRESOLVED, players: [human(0, 4, 0), human(1, 0, 200)]
  }));
  assert.equal(verdict.confident, false);
});

void test('missing stock counts are not treated as zero', () => {
  // A null is an absent reading. Counting it as no stocks would award the game
  // to whoever the parser happened to read successfully.
  const verdict = determineWinner(game({ players: [human(0, null, 10), human(1, 2, 40)] }));
  assert.equal(verdict.outcome, 'undetermined');
  assert.equal(verdict.reason, 'missing-stock-counts');
});

void test('everyone on zero stocks is not a win for anybody', () => {
  const verdict = determineWinner(game({ players: [human(0, 0, 90), human(1, 0, 90)] }));
  assert.equal(verdict.confident, false);
  assert.equal(verdict.reason, 'nobody-had-a-stock-left');
});

void test('a game against the computer is not a versus match', () => {
  const cpu = { ...human(1, 0, 100), playerType: 1 };
  const verdict = determineWinner(game({ players: [human(0, 3, 20), cpu] }));
  assert.equal(verdict.reason, 'not-a-versus-match');
  assert.equal(verdict.confident, false);
});

/* The parser's own robustness. A replay arrives from a player's machine. */

function envelope(raw: Buffer, declaredLength = raw.length): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(declaredLength);
  return Buffer.concat([UBJSON_PREFIX, length, raw]);
}

void test('anything that is not a replay is refused', () => {
  for (const [bytes, reason] of [
    [Buffer.alloc(4), 'too-short'],
    [Buffer.concat([Buffer.from('not a slp!!'), Buffer.alloc(8)]), 'not-a-slp-file'],
    [envelope(Buffer.alloc(0), 0), 'empty-replay']
  ] as Array<[Buffer, string]>) {
    const result = readRawSection(bytes);
    assert.equal(result.ok, false);
    assert.equal((result as { reason: string }).reason, reason);
  }
});

void test('a length the file claims but does not have is clamped, not trusted', () => {
  // Believing it would read past the end of the buffer on a truncated upload.
  const raw = Buffer.from([0x35, 0x04, 0x36, 0x00, 0x08]);
  const result = readRawSection(envelope(raw, 5_000_000));
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.raw.length, raw.length);
});

void test('an absurd declared length is refused outright', () => {
  const result = readRawSection(envelope(Buffer.alloc(16), 0xfffffff0));
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, 'implausible-length');
});

void test('the payload table is validated before it is used', () => {
  assert.equal(readPayloadSizes(Buffer.from([0x99, 0x04])).ok, false, 'must start with the payload event');
  // A length that is not one-plus-a-multiple-of-three cannot be a real table.
  assert.equal(readPayloadSizes(Buffer.from([0x35, 0x03, 0x36, 0x00])).ok, false);
  // Declares more commands than the buffer holds.
  assert.equal(readPayloadSizes(Buffer.from([0x35, 0x10, 0x36, 0x00, 0x08])).ok, false);

  const good = readPayloadSizes(Buffer.from([0x35, 0x07, 0x36, 0x01, 0x40, 0x39, 0x00, 0x02]));
  assert.equal(good.ok, true);
  assert.equal(good.ok && good.sizes.get(0x36), 0x140);
  assert.equal(good.ok && good.sizes.get(0x39), 2);
  assert.equal(good.ok && good.headerBytes, 8);
});

void test('an event the table never declared stops the walk', () => {
  // Past an undeclared command the stream is no longer aligned, and every field
  // read after it would be fabricated.
  const raw = Buffer.concat([
    Buffer.from([0x35, 0x04, 0x39, 0x00, 0x02]),
    Buffer.from([0x4f, 0x01, 0x02, 0x03])
  ]);
  const result = parseReplay(envelope(raw));
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, 'unknown-event');
});

void test('a replay with no game start is refused', () => {
  const raw = Buffer.concat([Buffer.from([0x35, 0x04, 0x39, 0x00, 0x02]), Buffer.from([0x39, 0x02, 0xff])]);
  const result = parseReplay(envelope(raw));
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, 'no-game-start');
});

/**
 * Opt-in run against real replays. Point SLP_CORPUS at a folder of them —
 * a Slippi replay directory works as-is.
 */
void test('every replay in a corpus parses, when one is provided', { skip: !process.env.SLP_CORPUS }, () => {
  const corpus = process.env.SLP_CORPUS!;
  assert.ok(existsSync(corpus), `SLP_CORPUS does not exist: ${corpus}`);
  const files = readdirSync(corpus).filter((name) => name.endsWith('.slp'));
  assert.ok(files.length > 0, 'the corpus contains no replays');

  const failures: string[] = [];
  for (const name of files) {
    const result = parseReplay(readFileSync(path.join(corpus, name)));
    // An empty replay is a legitimate thing to refuse; anything else is a gap.
    if (!result.ok && result.reason !== 'empty-replay') failures.push(`${name}: ${result.reason}`);
  }
  assert.deepEqual(failures, []);
});
