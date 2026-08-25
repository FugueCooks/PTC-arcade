import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../database/schema.js';
import type { LoginRecord, SafeIdentity } from './auth-repository.js';

export type PreferenceUpdate = Partial<Pick<schema.UserPreferenceRecord,
  'masterVolume' | 'musicVolume' | 'effectsVolume' | 'mouseSensitivity' | 'reducedMotion' | 'graphicsPreset' | 'showNameplates' | 'chatVisibility'>>;

export interface SafeSessionSummary { id: string; deviceType: string; createdAt: Date; lastUsedAt: Date; expiresAt: Date }

export class AccountRepository {
  constructor(private readonly db: NodePgDatabase<typeof schema>) {}

  async updateProfile(userId: string, input: { displayName: string; normalizedDisplayName: string; avatarId: string }): Promise<SafeIdentity | undefined> {
    const [user] = await this.db.update(schema.users).set({ displayName: input.displayName,
      normalizedDisplayName: input.normalizedDisplayName, selectedAvatarId: input.avatarId, updatedAt: new Date() })
      .where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt))).returning();
    return user ? identity(user) : undefined;
  }

  async preferences(userId: string): Promise<schema.UserPreferenceRecord | undefined> {
    const [value] = await this.db.select().from(schema.userPreferences).where(eq(schema.userPreferences.userId, userId)).limit(1);
    return value;
  }

  async updatePreferences(userId: string, input: PreferenceUpdate): Promise<schema.UserPreferenceRecord | undefined> {
    const [value] = await this.db.update(schema.userPreferences).set({ ...input, updatedAt: new Date() })
      .where(eq(schema.userPreferences.userId, userId)).returning();
    return value;
  }

  async loginById(userId: string): Promise<LoginRecord | undefined> {
    const [user] = await this.db.select().from(schema.users).where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt))).limit(1);
    return user ? { ...identity(user), passwordHash: user.passwordHash } : undefined;
  }

  async sessions(userId: string): Promise<SafeSessionSummary[]> {
    return this.db.select({ id: schema.sessions.id, deviceType: schema.sessions.deviceType,
      createdAt: schema.sessions.createdAt, lastUsedAt: schema.sessions.lastUsedAt, expiresAt: schema.sessions.expiresAt })
      .from(schema.sessions).where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt), gt(schema.sessions.expiresAt, new Date())))
      .then((rows) => rows.map((row) => ({ ...row, deviceType: row.deviceType ?? 'browser' })));
  }

  async revokeSession(userId: string, sessionId: string): Promise<boolean> {
    const rows = await this.db.update(schema.sessions).set({ revokedAt: new Date() })
      .where(and(eq(schema.sessions.userId, userId), eq(schema.sessions.id, sessionId), isNull(schema.sessions.revokedAt)))
      .returning({ id: schema.sessions.id });
    return rows.length > 0;
  }

  async revokeOthers(userId: string, currentTokenHash: string): Promise<number> {
    const rows = await this.db.update(schema.sessions).set({ revokedAt: new Date() })
      .where(and(eq(schema.sessions.userId, userId), ne(schema.sessions.tokenHash, currentTokenHash), isNull(schema.sessions.revokedAt)))
      .returning({ id: schema.sessions.id });
    return rows.length;
  }

  async deleteAccount(userId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const now = new Date();
      await tx.update(schema.users).set({ status: 'deleted', deletedAt: now, updatedAt: now,
        username: `deleted_${userId.slice(0, 8)}`, normalizedUsername: `deleted_${userId.slice(0, 8)}`,
        email: `deleted-${userId}@invalid.local`, normalizedEmail: `deleted-${userId}@invalid.local`,
        displayName: 'DELETED PLAYER', normalizedDisplayName: `deleted-${userId}`, passwordHash: 'deleted' })
        .where(eq(schema.users.id, userId));
      await tx.update(schema.sessions).set({ revokedAt: now }).where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt)));
    });
  }

  async recordAudit(eventType: string, userId?: string): Promise<void> {
    await this.db.insert(schema.securityAuditEvents).values({
      userId: userId ?? null, eventType, expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1_000)
    });
  }
}

function identity(user: schema.UserRecord): SafeIdentity {
  return { id: user.id, type: 'registered', publicPlayerId: user.publicPlayerId, walletAuthenticated: false,
    displayName: user.displayName, avatarId: user.selectedAvatarId, status: user.status };
}
