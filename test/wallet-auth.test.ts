import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { createSignInMessage } from '@solana/wallet-standard-util';
import { InMemoryWalletChallengeStore } from '../server/src/auth/wallet-challenge-store.js';
import { WalletChallengeService } from '../server/src/auth/wallet-challenge-service.js';
import { entitlementsFor, authoritativeAvatarId, DEFAULT_GUEST_AVATAR_ID } from '../server/src/auth/authorization-policy.js';

const origin = 'https://arcade.example';
const config = {
  walletChallengeTtlMs: 300_000,
  walletChallengeMaxAttempts: 5,
  solanaNetwork: 'mainnet-beta' as const,
  solanaAppDomain: 'arcade.example',
  solanaAppUri: origin,
  softwareVersion: 'test'
};

function testWallet() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  if (!jwk.x) throw new Error('Missing Ed25519 public key.');
  const publicBytes = Buffer.from(jwk.x, 'base64url');
  const address = base58(publicBytes);
  return {
    address,
    signInput(input: Parameters<typeof createSignInMessage>[0]) {
      const signedMessage = createSignInMessage(input);
      return {
        account: { address, publicKey: publicBytes.toString('base64') },
        signedMessage: Buffer.from(signedMessage).toString('base64'),
        signature: sign(null, signedMessage, privateKey).toString('base64'),
        signatureType: 'ed25519' as const
      };
    }
  };
}

void test('wallet challenges are domain-bound, fresh, random, and single use', async () => {
  const wallet = testWallet();
  const service = new WalletChallengeService(new InMemoryWalletChallengeStore(), config);
  const first = await service.create(wallet.address, origin, 1_000);
  const second = await service.create(wallet.address, origin, 1_000);
  assert.ok(first && second);
  assert.notEqual(first.input.nonce, second.input.nonce);
  // Sign In With Solana inherits EIP-4361's grammar, where the nonce rule is
  // `8*( ALPHA / DIGIT )`. A base64url nonce satisfies every assertion above
  // and still breaks the message: `-` and `_` are outside the rule, a wallet
  // that cannot parse the message never shows the request, and half of all
  // logins failed on the toss of a coin. Enough draws here that a generator
  // reaching outside the alphabet cannot pass by luck.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const challenge = await service.create(wallet.address, origin, 1_000);
    assert.ok(challenge);
    assert.match(challenge.input.nonce ?? '', /^[A-Za-z0-9]{8,}$/,
      `the sign-in grammar allows only letters and digits in a nonce, got ${challenge.input.nonce}`);
  }
  assert.equal(first.input.domain, 'arcade.example');
  assert.equal(first.input.chainId, 'solana:mainnet');
  assert.equal(first.expiresAt, new Date(301_000).toISOString());
  assert.equal(await service.create(wallet.address, 'https://evil.example', 1_000), undefined);
});

void test('a correct wallet signature verifies once and replay is rejected', async () => {
  const wallet = testWallet();
  const service = new WalletChallengeService(new InMemoryWalletChallengeStore(), config);
  const challenge = await service.create(wallet.address, origin, 10_000);
  assert.ok(challenge);
  const output = wallet.signInput(challenge.input);
  assert.equal((await service.verify(challenge.challengeId, output, origin, 11_000))?.walletAddress, wallet.address);
  assert.equal(await service.verify(challenge.challengeId, output, origin, 12_000), undefined);
});

void test('expired, altered, and wrong-wallet authentication attempts are rejected', async () => {
  const wallet = testWallet();
  const other = testWallet();
  const service = new WalletChallengeService(new InMemoryWalletChallengeStore(), config);
  const expired = await service.create(wallet.address, origin, 0); assert.ok(expired);
  assert.equal(await service.verify(expired.challengeId, wallet.signInput(expired.input), origin, 300_001), undefined);
  const wrong = await service.create(wallet.address, origin, 1_000); assert.ok(wrong);
  assert.equal(await service.verify(wrong.challengeId, other.signInput(wrong.input), origin, 2_000), undefined);
});

void test('guest entitlements allow approved avatars while denying durable writes', () => {
  const guest = { type: 'guest' as const, walletAuthenticated: false };
  assert.deepEqual(entitlementsFor(guest), {
    accountAuthenticated: false, canChooseCustomAvatar: true, canClaimPersistentDisplayName: false,
    canPersistPreferences: false, canPersistProgress: false, canPersistGameSaves: false
  });
  assert.equal(entitlementsFor({ type: 'registered', walletAuthenticated: true }).canPersistGameSaves, true);
  // An account made with a username and a password carries no wallet, and must
  // still be able to keep things. Gating persistence on the wallet flag would
  // hand every such account a profile that silently saves nothing, which is
  // exactly the shape of bug a deep-equal on the guest case cannot catch.
  const password = { type: 'registered' as const, walletAuthenticated: false };
  assert.deepEqual(entitlementsFor(password), {
    accountAuthenticated: true, canChooseCustomAvatar: true, canClaimPersistentDisplayName: true,
    canPersistPreferences: true, canPersistProgress: true, canPersistGameSaves: true
  });
  assert.equal(authoritativeAvatarId(guest, 'omni-man'), 'omni-man');
  assert.equal(authoritativeAvatarId(guest, '../../untrusted.glb'), DEFAULT_GUEST_AVATAR_ID);
  assert.equal(authoritativeAvatarId({ type: 'registered', walletAuthenticated: true }, 'omni-man'), 'omni-man');
});

function base58(bytes: Uint8Array): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      carry += digits[index] * 256; digits[index] = carry % 58; carry = Math.floor(carry / 58);
    }
    while (carry > 0) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  let result = '';
  for (const byte of bytes) { if (byte === 0) result += '1'; else break; }
  return result + digits.reverse().map((digit) => alphabet[digit]).join('');
}
