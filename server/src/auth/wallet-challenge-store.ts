import type { RedisClientType } from 'redis';
import type { SolanaSignInInput } from '@solana/wallet-standard-features';
import type { RedisKeys } from '../redis/redis-keys.js';

export interface WalletChallengeRecord {
  challengeId: string;
  walletAddress: string;
  input: SolanaSignInInput;
  origin: string;
  environment: string;
  expectedInputHash: string;
  issuedAt: number;
  expiresAt: number;
  attemptCount: number;
}

export interface WalletChallengeStore {
  create(record: WalletChallengeRecord, ttlMs: number): Promise<void>;
  beginAttempt(challengeId: string, maxAttempts: number, now?: number): Promise<WalletChallengeRecord | undefined>;
  consume(challengeId: string, expectedInputHash: string): Promise<boolean>;
}

export class InMemoryWalletChallengeStore implements WalletChallengeStore {
  private readonly records = new Map<string, WalletChallengeRecord>();

  async create(record: WalletChallengeRecord): Promise<void> { this.records.set(record.challengeId, structuredClone(record)); }

  async beginAttempt(challengeId: string, maxAttempts: number, now = Date.now()): Promise<WalletChallengeRecord | undefined> {
    const record = this.records.get(challengeId);
    if (!record || record.expiresAt <= now || record.attemptCount >= maxAttempts) {
      this.records.delete(challengeId); return undefined;
    }
    record.attemptCount += 1;
    return structuredClone(record);
  }

  async consume(challengeId: string, expectedInputHash: string): Promise<boolean> {
    const record = this.records.get(challengeId);
    if (!record || record.expectedInputHash !== expectedInputHash) return false;
    this.records.delete(challengeId); return true;
  }
}

export class RedisWalletChallengeStore implements WalletChallengeStore {
  constructor(private readonly client: RedisClientType, private readonly keys: RedisKeys) {}

  async create(record: WalletChallengeRecord, ttlMs: number): Promise<void> {
    await this.client.set(this.keys.walletChallenge(record.challengeId), JSON.stringify(record), { PX: ttlMs, NX: true });
  }

  async beginAttempt(challengeId: string, maxAttempts: number, now = Date.now()): Promise<WalletChallengeRecord | undefined> {
    const value = await this.client.eval(
      "local value=redis.call('GET',KEYS[1]); if not value then return nil end; local item=cjson.decode(value); if tonumber(item.expiresAt)<=tonumber(ARGV[1]) or tonumber(item.attemptCount)>=tonumber(ARGV[2]) then redis.call('DEL',KEYS[1]); return nil end; item.attemptCount=tonumber(item.attemptCount)+1; local ttl=redis.call('PTTL',KEYS[1]); redis.call('SET',KEYS[1],cjson.encode(item),'PX',ttl); return cjson.encode(item)",
      { keys: [this.keys.walletChallenge(challengeId)], arguments: [String(now), String(maxAttempts)] }
    );
    return parseRecord(value);
  }

  async consume(challengeId: string, expectedInputHash: string): Promise<boolean> {
    const result = await this.client.eval(
      "local value=redis.call('GET',KEYS[1]); if not value then return 0 end; local item=cjson.decode(value); if item.expectedInputHash~=ARGV[1] then return 0 end; redis.call('DEL',KEYS[1]); return 1",
      { keys: [this.keys.walletChallenge(challengeId)], arguments: [expectedInputHash] }
    );
    return Number(result) === 1;
  }
}

function parseRecord(value: unknown): WalletChallengeRecord | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<WalletChallengeRecord>;
    return typeof parsed.challengeId === 'string' && typeof parsed.walletAddress === 'string'
      && typeof parsed.expectedInputHash === 'string' && typeof parsed.expiresAt === 'number'
      && typeof parsed.attemptCount === 'number' && parsed.input !== null && typeof parsed.input === 'object'
      ? parsed as WalletChallengeRecord : undefined;
  } catch { return undefined; }
}
