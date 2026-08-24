import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error('DATABASE_URL is required to run database migrations.');

const pool = new Pool({ connectionString, max: 1, application_name: 'retro-arcade-migrations' });
try {
  await migrate(drizzle(pool), { migrationsFolder: path.resolve(process.env.MIGRATIONS_DIR ?? 'drizzle') });
  console.log(JSON.stringify({ level: 'info', event: 'database_migrations_applied', at: new Date().toISOString() }));
} finally {
  await pool.end();
}
