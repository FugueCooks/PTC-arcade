import assert from 'node:assert/strict';
import test from 'node:test';

/** A queue with the replay verification processor registered. */
function replayQueue(): JobQueue {
  const queue = new JobQueue();
  queue.register({ name: 'replay.verify', process: () => undefined });
  return queue;
}
import { JobQueue, asReplayJobQueue } from '../server/src/jobs/job-queue.js';
import { replayChecksum, serializeReplay, validateReplay } from '../server/src/replays/replay-format.js';
import { ReplayService, type ReplayMetadata, type ReplayObjectStorage, type ReplayRepository } from '../server/src/replays/replay-service.js';

const replayInput = {
  replayFormatVersion: 1 as const, gameId: 'crash-bandicoot', emulatorAdapterId: 'legacy-browser-emulator', emulatorAdapterVersion: '1.0.0',
  playerPublicId: 'player-public', startedAt: 10, endedAt: 20, durationMs: 10, inputTickRate: 60, capability: 'INPUT_LOG' as const,
  inputEvents: [{ control: 'ACTION_1' as const, pressed: true, tick: 1, playerIndex: 0 }], verificationPolicy: 'UNVERIFIED' as const, compression: 'none' as const
};

class MemoryRepository implements ReplayRepository {
  records = new Map<string, ReplayMetadata>();async create(record: ReplayMetadata): Promise<void> { this.records.set(record.publicReplayId, structuredClone(record)); }
  async get(id: string): Promise<ReplayMetadata|undefined> { const value=this.records.get(id);return value&&structuredClone(value); }
}
class MemoryStorage implements ReplayObjectStorage {
  values=new Map<string,Uint8Array>();async put(key:string,bytes:Uint8Array):Promise<void>{this.values.set(key,bytes.slice())}
  async get(key:string):Promise<Uint8Array|undefined>{return this.values.get(key)?.slice()}async delete(key:string):Promise<void>{this.values.delete(key)}
}

void test('versioned replay input serializes, validates, and excludes ROM contents', () => {
  const replay=serializeReplay(replayInput);assert.equal(validateReplay(replay).checksum,replay.checksum);
  assert.equal(JSON.stringify(replay).includes('ROM contents'),false);assert.equal(replayChecksum(replay),replay.checksum);
});

void test('checksum corruption and local paths are rejected', () => {
  const replay=serializeReplay(replayInput);assert.throws(()=>validateReplay({...replay,gameId:'altered'}),/checksum/);
  assert.throws(()=>serializeReplay({...replayInput,romFingerprint:'C:\\private\\game.iso'}),/forbidden/);
});

void test('replay storage round trip preserves metadata and payload', async () => {
  const repository=new MemoryRepository(),storage=new MemoryStorage(),queue=replayQueue();
  const service=new ReplayService(repository,storage,asReplayJobQueue(queue));
  const metadata=await service.record(serializeReplay(replayInput),'user');
  const playback=await service.playback(metadata.publicReplayId);
  assert.equal(playback.replay.gameId,'crash-bandicoot');
  // Playback is a read: it must not schedule verification work.
  assert.equal(queue.stats().depth,0);
});

void test('replay work enqueues idempotently onto the shared job queue', async () => {
  // The replay service arrived with its own simpler queue; it now runs on the
  // one queue, so it inherits retries, backoff, and dead-lettering. Those are
  // covered in api-platform.test.ts; this asserts the adapter's own contract.
  let processed = 0;
  const queue = new JobQueue();
  queue.register({ name: 'replay.verify', process: () => { processed += 1; } });
  const adapter = asReplayJobQueue(queue);

  await adapter.enqueue('replay.verify', { id: 'one' }, 'same');
  await adapter.enqueue('replay.verify', { id: 'one' }, 'same');
  assert.equal(queue.stats().depth, 1, 'a repeated idempotency key must not queue twice');

  await queue.runDue();
  assert.equal(processed, 1);
  assert.equal(queue.stats().depth, 0);
});
