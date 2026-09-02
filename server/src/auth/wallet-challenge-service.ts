import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { SolanaSignInInput } from '@solana/wallet-standard-features';
import type { ServerConfig } from '../config.js';
import type { WalletChallengeRecord, WalletChallengeStore } from './wallet-challenge-store.js';
import { isSolanaWalletAddress, type SerializedSignInOutput, verifySerializedSignIn } from './wallet-signature-verifier.js';

type RequiredSignInInput = SolanaSignInInput & Required<Pick<SolanaSignInInput, 'address' | 'domain'>>;
export interface WalletChallengeResponse { challengeId: string; input: RequiredSignInInput; expiresAt: string }

export class WalletChallengeService {
  constructor(private readonly store: WalletChallengeStore, private readonly config: Pick<ServerConfig,
    'walletChallengeTtlMs' | 'walletChallengeMaxAttempts' | 'solanaNetwork' | 'solanaAppDomain' | 'solanaAppUri' | 'softwareVersion'>) {}

  async create(walletAddress: unknown, origin: string, now = Date.now()): Promise<WalletChallengeResponse | undefined> {
    if (!isSolanaWalletAddress(walletAddress) || origin !== new URL(this.config.solanaAppUri).origin) return undefined;
    const challengeId = randomUUID();
    const issuedAt = new Date(now);
    const expiresAt = new Date(now + this.config.walletChallengeTtlMs);
    const input: RequiredSignInInput = {
      domain: this.config.solanaAppDomain,
      address: walletAddress,
      statement: 'Sign in to PTC Arcade. This is free, does not send a transaction, and does not spend SOL.',
      uri: this.config.solanaAppUri,
      version: '1',
      chainId: `solana:${this.config.solanaNetwork === 'mainnet-beta' ? 'mainnet' : this.config.solanaNetwork}`,
      nonce: alphanumericNonce(24),
      issuedAt: issuedAt.toISOString(),
      expirationTime: expiresAt.toISOString(),
      requestId: challengeId
    };
    const record: WalletChallengeRecord = {
      challengeId, walletAddress, input, origin,
      environment: `${this.config.solanaNetwork}:${this.config.softwareVersion}`,
      expectedInputHash: inputHash(input), issuedAt: now, expiresAt: expiresAt.getTime(), attemptCount: 0
    };
    await this.store.create(record, this.config.walletChallengeTtlMs);
    return { challengeId, input, expiresAt: expiresAt.toISOString() };
  }

  async verify(challengeId: string, output: SerializedSignInOutput, origin: string, now = Date.now()): Promise<WalletChallengeRecord | undefined> {
    const record = await this.store.beginAttempt(challengeId, this.config.walletChallengeMaxAttempts, now);
    if (!record || record.origin !== origin || record.environment !== `${this.config.solanaNetwork}:${this.config.softwareVersion}`
      || record.expiresAt <= now || record.walletAddress !== output.account?.address
      || record.expectedInputHash !== inputHash(record.input) || !verifySerializedSignIn(record.input, output)) return undefined;
    return await this.store.consume(challengeId, record.expectedInputHash) ? record : undefined;
  }
}

function inputHash(input: SolanaSignInInput): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

const NONCE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/**
 * A nonce the sign-in message grammar will actually accept.
 *
 * Sign In With Solana inherits EIP-4361's ABNF, where the rule is
 * `message-nonce = 8*( ALPHA / DIGIT )` — letters and digits, nothing else.
 * This used to be `randomBytes(18).toString('base64url')`, whose alphabet also
 * holds `-` and `_`; a nonce carrying either made the assembled message
 * ungrammatical, and a wallet that cannot parse the message does not show the
 * request at all — Phantom answers "the app's signature request cannot be
 * shown due to invalid formatting". Around half of every login was refused
 * that way, which reads as a wallet that works intermittently for no reason.
 *
 * Rejection sampling rather than `% 62`, so every character is equally likely:
 * 248 is the largest multiple of 62 under 256, and bytes at or above it are
 * discarded instead of biasing the first four letters of the alphabet. Twenty
 * four characters is about 143 bits, matching the 144 the old nonce carried.
 */
function alphanumericNonce(length: number): string {
  const out: string[] = [];
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte >= 248) continue;
      out.push(NONCE_ALPHABET[byte % 62]);
      if (out.length === length) break;
    }
  }
  return out.join('');
}
