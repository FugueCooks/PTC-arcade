import { Algorithm, hash, verify, Version } from '@node-rs/argon2';

export interface PasswordHashOptions { memoryCostKib: number; iterations: number; parallelism: number }
const defaults: PasswordHashOptions = { memoryCostKib: 19_456, iterations: 2, parallelism: 1 };

/** Argon2id password hashing only; application validation belongs at the API boundary. */
export class PasswordHasher {
  constructor(private readonly options: PasswordHashOptions = defaults) {}

  hash(password: string): Promise<string> {
    return hash(password, {
      algorithm: Algorithm.Argon2id,
      version: Version.V0x13,
      memoryCost: this.options.memoryCostKib,
      timeCost: this.options.iterations,
      parallelism: this.options.parallelism,
      outputLen: 32
    });
  }

  async verify(encodedHash: string, password: string): Promise<boolean> {
    try { return await verify(encodedHash, password); } catch { return false; }
  }
}
