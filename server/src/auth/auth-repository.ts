import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../database/schema.js';

export interface SafeIdentity {
  id: string;
  type: 'registered' | 'guest';
  displayName: string;
  avatarId: string;
  status: string;
}

export interface LoginRecord extends SafeIdentity { passwordHash: string }
export interface AuthSessionRecord { identity: SafeIdentity; expiresAt: Date }
export interface NewRegisteredIdentity {
  email: string; normalizedEmail: string; passwordHash: string;
  displayName: string; normalizedDisplayName: string; avatarId: string;
}
export interface NewGuestIdentity { displayName: string; normalizedDisplayName: string; avatarId: string; expiresAt: Date }

export interface AuthRepository {
  createRegistered(input: NewRegisteredIdentity): Promise<SafeIdentity | undefined>;
  findLogin(normalizedEmail: string): Promise<LoginRecord | undefined>;
  createGuest(input: NewGuestIdentity): Promise<SafeIdentity>;
  createSession(identity: SafeIdentity, tokenHash: string, expiresAt: Date, deviceType?: string): Promise<void>;
  findSession(tokenHash: string, now?: Date): Promise<AuthSessionRecord | undefined>;
  revokeSession(tokenHash: string, now?: Date): Promise<boolean>;
  recordAudit(eventType: string, userId?: string): Promise<void>;
}

export class DrizzleAuthRepository implements AuthRepository {
  constructor(private readonly db: NodePgDatabase<typeof schema>) {}

  async createRegistered(input: NewRegisteredIdentity): Promise<SafeIdentity | undefined> {
    try {
      return await this.db.transaction(async (tx) => {
        const [user] = await tx.insert(schema.users).values({
          email: input.email, normalizedEmail: input.normalizedEmail, passwordHash: input.passwordHash,
          displayName: input.displayName, normalizedDisplayName: input.normalizedDisplayName,
          selectedAvatarId: input.avatarId, status: 'unverified'
        }).returning();
        if (!user) throw new Error('User creation returned no record.');
        await tx.insert(schema.userPreferences).values({ userId: user.id });
        return registeredIdentity(user);
      });
    } catch (error) {
      if (isUniqueViolation(error)) return undefined;
      throw error;
    }
  }

  async findLogin(normalizedEmail: string): Promise<LoginRecord | undefined> {
    const [user] = await this.db.select().from(schema.users).where(and(
      eq(schema.users.normalizedEmail, normalizedEmail), isNull(schema.users.deletedAt)
    )).limit(1);
    if (!user) return undefined;
    return { ...registeredIdentity(user), passwordHash: user.passwordHash };
  }

  async createGuest(input: NewGuestIdentity): Promise<SafeIdentity> {
    const [guest] = await this.db.insert(schema.guestIdentities).values({
      displayName: input.displayName, normalizedDisplayName: input.normalizedDisplayName,
      selectedAvatarId: input.avatarId, expiresAt: input.expiresAt
    }).returning();
    if (!guest) throw new Error('Guest creation returned no record.');
    return guestIdentity(guest);
  }

  async createSession(identity: SafeIdentity, tokenHash: string, expiresAt: Date, deviceType?: string): Promise<void> {
    await this.db.insert(schema.sessions).values({
      userId: identity.type === 'registered' ? identity.id : null,
      guestId: identity.type === 'guest' ? identity.id : null,
      tokenHash, expiresAt, deviceType
    });
    if (identity.type === 'registered') {
      await this.db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, identity.id));
    } else {
      await this.db.update(schema.guestIdentities).set({ lastUsedAt: new Date() }).where(eq(schema.guestIdentities.id, identity.id));
    }
  }

  async findSession(tokenHash: string, now = new Date()): Promise<AuthSessionRecord | undefined> {
    const [row] = await this.db.select({ session: schema.sessions, user: schema.users, guest: schema.guestIdentities })
      .from(schema.sessions)
      .leftJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
      .leftJoin(schema.guestIdentities, eq(schema.sessions.guestId, schema.guestIdentities.id))
      .where(and(eq(schema.sessions.tokenHash, tokenHash), isNull(schema.sessions.revokedAt), gt(schema.sessions.expiresAt, now),
        or(isNull(schema.users.deletedAt), isNull(schema.sessions.userId)),
        or(isNull(schema.sessions.guestId), gt(schema.guestIdentities.expiresAt, now))))
      .limit(1);
    if (!row) return undefined;
    const identity = row.user ? registeredIdentity(row.user) : row.guest ? guestIdentity(row.guest) : undefined;
    return identity ? { identity, expiresAt: row.session.expiresAt } : undefined;
  }

  async revokeSession(tokenHash: string, now = new Date()): Promise<boolean> {
    const rows = await this.db.update(schema.sessions).set({ revokedAt: now })
      .where(and(eq(schema.sessions.tokenHash, tokenHash), isNull(schema.sessions.revokedAt))).returning({ id: schema.sessions.id });
    return rows.length > 0;
  }

  async recordAudit(eventType: string, userId?: string): Promise<void> {
    await this.db.insert(schema.securityAuditEvents).values({
      userId: userId ?? null, eventType, expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1_000)
    });
  }
}

function registeredIdentity(user: schema.UserRecord): SafeIdentity {
  return { id: user.id, type: 'registered', displayName: user.displayName, avatarId: user.selectedAvatarId, status: user.status };
}
function guestIdentity(guest: schema.GuestIdentityRecord): SafeIdentity {
  return { id: guest.id, type: 'guest', displayName: guest.displayName, avatarId: guest.selectedAvatarId, status: 'active' };
}
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === '23505';
}
