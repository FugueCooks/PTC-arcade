import { defineConfig } from 'drizzle-kit';

const databaseUrl = process.env.DATABASE_URL?.trim();

export default defineConfig({
  dialect: 'postgresql',
  schema: './server/src/database/schema.ts',
  out: './drizzle',
  ...(databaseUrl ? { dbCredentials: { url: databaseUrl } } : {}),
  strict: true,
  verbose: true
});
