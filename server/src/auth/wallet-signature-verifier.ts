import { isAddress } from '@solana/addresses';
import { verifySignIn } from '@solana/wallet-standard-util';
import type { SolanaSignInInput, SolanaSignInOutput } from '@solana/wallet-standard-features';

export interface SerializedSignInOutput {
  account: { address: string; publicKey: string };
  signedMessage: string;
  signature: string;
  signatureType?: 'ed25519';
}

export function isSolanaWalletAddress(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && isAddress(value);
}

export function verifySerializedSignIn(input: SolanaSignInInput, serialized: SerializedSignInOutput): boolean {
  try {
    if (!isSolanaWalletAddress(serialized.account?.address)) return false;
    const publicKey = decodeBase64(serialized.account.publicKey, 32);
    const signedMessage = decodeBase64(serialized.signedMessage, 2_048);
    const signature = decodeBase64(serialized.signature, 64);
    if (!publicKey || publicKey.length !== 32 || !signedMessage || !signature || signature.length !== 64) return false;
    const output: SolanaSignInOutput = {
      account: { address: serialized.account.address, publicKey, chains: [], features: [] },
      signedMessage, signature, signatureType: serialized.signatureType
    };
    return verifySignIn(input, output);
  } catch { return false; }
}

function decodeBase64(value: unknown, maximumBytes: number): Uint8Array | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(maximumBytes * 4 / 3) + 8) return undefined;
  try { const bytes = Buffer.from(value, 'base64'); return bytes.length <= maximumBytes ? new Uint8Array(bytes) : undefined; } catch { return undefined; }
}
