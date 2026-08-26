import { randomUUID } from 'node:crypto';
import type { ReplayCapability, SafeJson } from '../../../shared/platform-contracts.js';
import type { ReplayEnvelope, ReplayVerificationStatus } from '../../../shared/replay-contracts.js';
import { validateReplay } from './replay-format.js';

export interface ReplayMetadata {
  id: string; publicReplayId: string; userId?: string; gameId: string; attemptId?: string; capability: ReplayCapability;
  verificationStatus: ReplayVerificationStatus; objectStorageKey: string; byteSize: number; checksum: string; formatVersion: number;
  createdAt: number; expiresAt?: number; visibility: 'private' | 'unlisted' | 'public'; deletionStatus: 'active' | 'pending' | 'deleted';
}
export interface ReplayRepository { create(record: ReplayMetadata): Promise<void>; get(publicReplayId: string): Promise<ReplayMetadata | undefined> }
export interface ReplayObjectStorage { put(key: string, bytes: Uint8Array, metadata: Record<string, string>): Promise<void>; get(key: string): Promise<Uint8Array | undefined>; delete(key: string): Promise<void> }
export interface ReplayJobQueue { enqueue(type: string, payload: Record<string, SafeJson>, idempotencyKey: string): Promise<void> }

export class ReplayService {
  constructor(private readonly repository: ReplayRepository, private readonly storage: ReplayObjectStorage, private readonly jobs: ReplayJobQueue,
    private readonly maximumBytes = 8 * 1024 * 1024) {}

  async record(input: unknown, userId?: string): Promise<ReplayMetadata> {
    const replay = validateReplay(input, this.maximumBytes), bytes = Buffer.from(JSON.stringify(replay));
    const publicReplayId = randomUUID(), key = `replays/v${replay.replayFormatVersion}/${publicReplayId}.json`;
    const metadata: ReplayMetadata = { id: randomUUID(), publicReplayId, userId, gameId: replay.gameId, attemptId: replay.attemptId,
      capability: replay.capability, verificationStatus: replay.capability === 'DETERMINISTIC_REPLAY' ? 'PROCESSING' : 'RECORDED', objectStorageKey: key,
      byteSize: bytes.byteLength, checksum: replay.checksum, formatVersion: replay.replayFormatVersion, createdAt: Date.now(), visibility: 'private', deletionStatus: 'active' };
    await this.storage.put(key, bytes, { checksum: replay.checksum, gameId: replay.gameId });await this.repository.create(metadata);
    if (metadata.verificationStatus === 'PROCESSING') await this.jobs.enqueue('replay.verify', { publicReplayId }, `verify:${publicReplayId}`);
    return { ...metadata };
  }

  async playback(publicReplayId: string): Promise<{ metadata: ReplayMetadata; replay: ReplayEnvelope }> {
    const metadata = await this.repository.get(publicReplayId);if (!metadata || metadata.deletionStatus !== 'active') throw new Error('Replay not found.');
    const bytes = await this.storage.get(metadata.objectStorageKey);if (!bytes) throw new Error('Replay payload is unavailable.');
    const replay = validateReplay(JSON.parse(Buffer.from(bytes).toString('utf8')), this.maximumBytes);
    if (replay.checksum !== metadata.checksum) throw new Error('Replay metadata checksum mismatch.');
    return { metadata: { ...metadata }, replay };
  }
}
