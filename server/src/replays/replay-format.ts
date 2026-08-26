import { createHash } from 'node:crypto';
import type { ReplayEnvelope, ReplayInputEvent } from '../../../shared/replay-contracts.js';

const controls = new Set(['UP','DOWN','LEFT','RIGHT','ACTION_1','ACTION_2','START','SELECT']);
export const REPLAY_FORMAT_VERSION = 1;

export function serializeReplay(input: Omit<ReplayEnvelope, 'checksum'>): ReplayEnvelope {
  const normalized = normalize({ ...input, checksum: '' });
  normalized.checksum = replayChecksum(normalized);
  return normalized;
}

export function validateReplay(value: unknown, maximumBytes = 8 * 1024 * 1024): ReplayEnvelope {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > maximumBytes) throw new Error('Replay exceeds the configured size limit.');
  const replay = normalize(value);
  if (replay.checksum !== replayChecksum(replay)) throw new Error('Replay checksum is invalid.');
  return replay;
}

export function replayChecksum(replay: ReplayEnvelope): string {
  const { checksum: _checksum, ...content } = replay;
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

function normalize(value: unknown): ReplayEnvelope {
  if (!value || typeof value !== 'object') throw new Error('Replay payload is invalid.');
  const replay = value as Partial<ReplayEnvelope>;
  if (replay.replayFormatVersion !== REPLAY_FORMAT_VERSION || typeof replay.gameId !== 'string' || typeof replay.emulatorAdapterId !== 'string'
    || typeof replay.emulatorAdapterVersion !== 'string' || typeof replay.playerPublicId !== 'string' || !Number.isFinite(replay.startedAt)
    || !Number.isFinite(replay.endedAt) || !Number.isFinite(replay.durationMs) || !Number.isFinite(replay.inputTickRate)
    || !Array.isArray(replay.inputEvents) || typeof replay.checksum !== 'string') throw new Error('Replay payload is invalid.');
  if (replay.capability === 'DETERMINISTIC_REPLAY' && replay.verificationPolicy !== 'DETERMINISTIC') throw new Error('Deterministic replay policy is required.');
  if (containsForbiddenPath(replay)) throw new Error('Replay metadata contains a forbidden local path.');
  const events = replay.inputEvents.map(normalizeEvent);
  for (let index = 1; index < events.length; index += 1) if (events[index].tick < events[index - 1].tick) throw new Error('Replay input ticks must be ordered.');
  return { ...replay, inputEvents: events } as ReplayEnvelope;
}

function normalizeEvent(event: ReplayInputEvent): ReplayInputEvent {
  if (!event || !controls.has(event.control) || typeof event.pressed !== 'boolean' || !Number.isSafeInteger(event.tick) || event.tick < 0
    || !Number.isSafeInteger(event.playerIndex) || event.playerIndex < 0 || event.playerIndex > 3) throw new Error('Replay input event is invalid.');
  return { control: event.control, pressed: event.pressed, tick: event.tick, playerIndex: event.playerIndex };
}

function containsForbiddenPath(value: unknown): boolean {
  const text = JSON.stringify(value);
  return /(?:[A-Za-z]:\\|file:\/\/|\.{2}[\\/])/.test(text);
}
