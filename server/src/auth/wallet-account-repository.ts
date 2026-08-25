import { and, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../database/schema.js';
import type { SafeIdentity } from './auth-repository.js';
import { DEFAULT_AVATAR_ID } from '../avatars/avatar-registry.js';

export interface WalletAccountStore {
  findOrCreate(network: string, walletAddress: string, now?: Date): Promise<{ identity: SafeIdentity; created: boolean }>;
}

export class DrizzleWalletAccountRepository implements WalletAccountStore {
  constructor(private readonly db: NodePgDatabase<typeof schema>) {}

  async findOrCreate(network: string, walletAddress: string, now = new Date()): Promise<{ identity: SafeIdentity; created: boolean }> {
    const existing = await this.find(network, walletAddress, now);
    if (existing) return { identity: existing, created: false };
    try {
      return await this.db.transaction(async (tx) => {
        const displayName = generatedDisplayName(walletAddress);
        const [user] = await tx.insert(schema.users).values({
          displayName, normalizedDisplayName: displayName.toLocaleLowerCase('en-US'),
          selectedAvatarId: DEFAULT_AVATAR_ID, status: 'active', lastLoginAt: now
        }).returning();
        if (!user) throw new Error('Wallet user creation returned no record.');
        await tx.insert(schema.walletIdentities).values({
          userId: user.id, chain: 'solana', network, walletAddress,
          normalizedWalletAddress: walletAddress, verifiedAt: now, lastUsedAt: now
        });
        await tx.insert(schema.userPreferences).values({ userId: user.id });
        return { identity: walletIdentity(user, walletAddress), created: true };
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const winner = await this.find(network, walletAddress, now);
      if (!winner) throw error;
      return { identity: winner, created: false };
    }
  }

  private async find(network: string, walletAddress: string, now: Date): Promise<SafeIdentity | undefined> {
    const [row] = await this.db.select({ user: schema.users, wallet: schema.walletIdentities })
      .from(schema.walletIdentities).innerJoin(schema.users, eq(schema.walletIdentities.userId, schema.users.id))
      .where(and(eq(schema.walletIdentities.chain, 'solana'), eq(schema.walletIdentities.network, network),
        eq(schema.walletIdentities.normalizedWalletAddress, walletAddress), isNull(schema.users.deletedAt))).limit(1);
    if (!row) return undefined;
    await this.db.update(schema.walletIdentities).set({ lastUsedAt: now }).where(eq(schema.walletIdentities.id, row.wallet.id));
    await this.db.update(schema.users).set({ lastLoginAt: now }).where(eq(schema.users.id, row.user.id));
    return walletIdentity(row.user, row.wallet.walletAddress);
  }
}

function walletIdentity(user: schema.UserRecord, walletAddress: string): SafeIdentity {
  return { id: user.id, type: 'registered', publicPlayerId: user.publicPlayerId, walletAuthenticated: true,
    walletAddress, displayName: user.displayName, avatarId: user.selectedAvatarId, status: user.status };
}

function generatedDisplayName(walletAddress: string): string { return `PLAYER_${walletAddress.slice(0, 6).toUpperCase()}`; }
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === '23505';
}
