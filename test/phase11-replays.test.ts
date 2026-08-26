import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryBackgroundJobQueue } from '../server/src/jobs/job-queue.js';
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
  const repository=new MemoryRepository(),storage=new MemoryStorage(),jobs=new InMemoryBackgroundJobQueue();
  const service=new ReplayService(repository,storage,jobs);const metadata=await service.record(serializeReplay(replayInput),'user');
  const playback=await service.playback(metadata.publicReplayId);assert.equal(playback.replay.gameId,'crash-bandicoot');assert.equal(await jobs.depth(),0);
});

void test('background queue is idempotent, bounded, and retryable', async () => {
  const queue=new InMemoryBackgroundJobQueue();await queue.enqueue('replay.verify',{id:'one'},'same');await queue.enqueue('replay.verify',{id:'one'},'same');
  assert.equal(await queue.depth(),1);const job=await queue.claim();assert.ok(job);await queue.fail(job.id,0);assert.ok(await queue.claim());await queue.complete(job.id);assert.equal(await queue.depth(),0);
});
