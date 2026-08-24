import { sql } from 'drizzle-orm';
import {
  boolean, check, index, jsonb, pgEnum, pgTable, real, text, timestamp, uniqueIndex, uuid, varchar
} from 'drizzle-orm/pg-core';

export const accountStatus = pgEnum('account_status', [
  'active', 'unverified', 'suspended', 'disabled', 'deletion-pending', 'deleted'
]);
export const graphicsPreset = pgEnum('graphics_preset', ['low', 'medium', 'high', 'auto']);
export const chatVisibility = pgEnum('chat_visibility', ['visible', 'hidden']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  username: varchar('username', { length: 18 }).notNull(),
  normalizedUsername: varchar('normalized_username', { length: 18 }).notNull(),
  email: varchar('email', { length: 320 }).notNull(),
  normalizedEmail: varchar('normalized_email', { length: 320 }).notNull(),
  passwordHash: text('password_hash').notNull(),
  displayName: varchar('display_name', { length: 18 }).notNull(),
  normalizedDisplayName: varchar('normalized_display_name', { length: 18 }).notNull(),
  selectedAvatarId: varchar('selected_avatar_id', { length: 64 }).notNull().default('neon-capsule'),
  status: accountStatus('status').notNull().default('unverified'),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true })
}, (table) => [
  uniqueIndex('users_normalized_username_unique').on(table.normalizedUsername),
  uniqueIndex('users_normalized_email_unique').on(table.normalizedEmail),
  index('users_status_idx').on(table.status)
]);

export const guestIdentities = pgTable('guest_identities', {
  id: uuid('id').primaryKey().defaultRandom(),
  displayName: varchar('display_name', { length: 18 }).notNull(),
  normalizedDisplayName: varchar('normalized_display_name', { length: 18 }).notNull(),
  selectedAvatarId: varchar('selected_avatar_id', { length: 64 }).notNull().default('neon-capsule'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  convertedToUserId: uuid('converted_to_user_id').references(() => users.id, { onDelete: 'set null' })
}, (table) => [index('guest_identities_expires_at_idx').on(table.expiresAt)]);

export const userPreferences = pgTable('user_preferences', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  masterVolume: real('master_volume').notNull().default(1),
  musicVolume: real('music_volume').notNull().default(0),
  effectsVolume: real('effects_volume').notNull().default(1),
  voiceVolume: real('voice_volume').notNull().default(1),
  mouseSensitivity: real('mouse_sensitivity').notNull().default(1),
  reducedMotion: boolean('reduced_motion').notNull().default(false),
  graphicsPreset: graphicsPreset('graphics_preset').notNull().default('auto'),
  showNameplates: boolean('show_nameplates').notNull().default(true),
  chatVisibility: chatVisibility('chat_visibility').notNull().default('visible'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  check('user_preferences_master_volume_range', sql`${table.masterVolume} between 0 and 1`),
  check('user_preferences_music_volume_range', sql`${table.musicVolume} between 0 and 1`),
  check('user_preferences_effects_volume_range', sql`${table.effectsVolume} between 0 and 1`),
  check('user_preferences_voice_volume_range', sql`${table.voiceVolume} between 0 and 1`),
  check('user_preferences_mouse_sensitivity_range', sql`${table.mouseSensitivity} between 0.1 and 4`)
]);

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  guestId: uuid('guest_id').references(() => guestIdentities.id, { onDelete: 'cascade' }),
  tokenHash: varchar('token_hash', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  deviceType: varchar('device_type', { length: 32 })
}, (table) => [
  uniqueIndex('sessions_token_hash_unique').on(table.tokenHash),
  index('sessions_user_id_idx').on(table.userId),
  index('sessions_guest_id_idx').on(table.guestId),
  index('sessions_expires_at_idx').on(table.expiresAt),
  check('sessions_exactly_one_subject', sql`num_nonnulls(${table.userId}, ${table.guestId}) = 1`)
]);

function oneTimeTokenTable(name: 'password_reset_tokens' | 'email_verification_tokens') {
  return pgTable(name, {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true })
  }, (table) => [
    uniqueIndex(`${name}_token_hash_unique`).on(table.tokenHash),
    index(`${name}_user_id_idx`).on(table.userId),
    index(`${name}_expires_at_idx`).on(table.expiresAt)
  ]);
}

export const passwordResetTokens = oneTimeTokenTable('password_reset_tokens');
export const emailVerificationTokens = oneTimeTokenTable('email_verification_tokens');

export const securityAuditEvents = pgTable('security_audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  eventType: varchar('event_type', { length: 64 }).notNull(),
  metadata: jsonb('metadata').$type<Record<string, string | number | boolean | null>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull()
}, (table) => [
  index('security_audit_events_user_id_idx').on(table.userId),
  index('security_audit_events_expires_at_idx').on(table.expiresAt)
]);

export type UserRecord = typeof users.$inferSelect;
export type SessionRecord = typeof sessions.$inferSelect;
export type GuestIdentityRecord = typeof guestIdentities.$inferSelect;
export type UserPreferenceRecord = typeof userPreferences.$inferSelect;
