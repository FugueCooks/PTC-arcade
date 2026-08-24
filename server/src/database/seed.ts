import { eq } from 'drizzle-orm';
import { createLogger } from '../logging/logger.js';
import { RuntimeMetrics } from '../metrics/metrics.js';
import { PasswordHasher } from '../auth/password-hasher.js';
import { normalizeDisplayName } from '../players/player-identity.js';
import { DatabaseConnection } from './connection.js';
import { userPreferences, users } from './schema.js';

if (process.env.NODE_ENV === 'production') throw new Error('Development seed is disabled in production.');
const databaseUrl = process.env.DATABASE_URL?.trim();
const username = normalizeDisplayName(process.env.SEED_DEVELOPMENT_USERNAME ?? 'TestPlayer');
const password = process.env.SEED_DEVELOPMENT_PASSWORD;
const displayName = normalizeDisplayName(process.env.SEED_DEVELOPMENT_DISPLAY_NAME ?? 'Test Player');
if (!databaseUrl || !username || !password || !displayName) {
  throw new Error('DATABASE_URL and explicit SEED_DEVELOPMENT_* values are required.');
}

const logger = createLogger({ service: 'roms-retro-arcade-seed' });
const metrics = new RuntimeMetrics({ connectedSockets: () => 0, activePlayers: () => 0, activeRooms: () => 0, averageRoomPopulation: () => 0, draining: () => false });
const database = new DatabaseConnection(databaseUrl, 1, logger, metrics);
if (!await database.connect(5_000)) throw new Error('Development database is unavailable.');
try {
  const normalizedUsername = username.toLocaleLowerCase('en-US');
  const existing = await database.db.select({ id: users.id }).from(users).where(eq(users.normalizedUsername, normalizedUsername)).limit(1);
  if (!existing.length) {
    const hasher = new PasswordHasher();
    const [created] = await database.db.insert(users).values({
      username, normalizedUsername, email: `${normalizedUsername}@users.invalid`, normalizedEmail: `${normalizedUsername}@users.invalid`,
      passwordHash: await hasher.hash(password), displayName,
      normalizedDisplayName: displayName.toLocaleLowerCase('en-US'), selectedAvatarId: 'neon-capsule', status: 'active', emailVerifiedAt: new Date()
    }).returning({ id: users.id });
    await database.db.insert(userPreferences).values({ userId: created.id });
    logger.info('development_user_seeded', { userId: created.id });
  } else logger.info('development_user_seed_skipped', { reason: 'already-exists' });
} finally {
  await database.close();
}
