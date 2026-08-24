# Phase 8 authentication architecture

Phase 8 keeps durable identity separate from live arcade simulation. PostgreSQL stores registered users, guest identities, opaque sessions, profile preferences, one-time recovery/verification token digests, and bounded security audit events. Redis continues to coordinate temporary presence, room routing, reconnects, rate limits, and active-connection locks. Movement, cabinets, room state, world state, and animation remain outside PostgreSQL.

## Milestone 8.1 database foundation

The schema is declared in `server/src/database/schema.ts` and its reviewed SQL migration is committed under `drizzle/`. Generate a new migration with `npm run db:generate`; apply committed migrations with `npm run db:migrate`. Production deployments must run migrations as a separate release step before starting application code that requires the new schema. Never use `drizzle-kit push` against production.

`DATABASE_URL` is optional while the arcade remains guest-only. Setting `DATABASE_REQUIRED=1` makes `/ready` fail safely until PostgreSQL is reachable. Database credentials are never included in readiness responses or structured logs. The connection pool is closed during graceful shutdown.

For local development:

1. Run `docker compose -f docker-compose.phase8.yml up -d`.
2. Set `DATABASE_URL=postgresql://retro_arcade:local-development-only@127.0.0.1:5432/retro_arcade`.
3. Run `npm run db:migrate`.
4. Optionally provide explicit `SEED_DEVELOPMENT_*` values and run `npm run db:seed`. Seeding refuses to run when `NODE_ENV=production`.

## Security primitives

Passwords use Argon2id version 19. Production defaults are 19,456 KiB memory, two iterations, and parallelism one. Each hash receives a library-generated random salt. Parameters are bounded configuration values so deployment tuning cannot silently disable the work factor.

Session, password-reset, and email-verification credentials use 256-bit random opaque tokens. Only SHA-256 token digests are stored. Long-lived credentials must later be delivered through Secure, HttpOnly, same-origin cookies; they must never enter local storage, URLs, logs, Three.js scene state, or multiplayer payloads.

Registered accounts and guests share the `sessions` table. A database constraint requires every session to reference exactly one user or one guest. Guest conversion preserves the live room until the authentication service performs an explicit identity handoff in a later milestone.

## HTTP authentication milestone

When PostgreSQL is configured and healthy, the Node service exposes `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/guest`, `GET /api/auth/session`, and `POST /api/auth/logout`.

Successful registration, login, and guest creation issue an opaque session in an `HttpOnly`, `SameSite=Strict` cookie. Only its SHA-256 hash is stored. Production enables the cookie `Secure` flag. Mutations reject cross-site browser requests, use bounded JSON bodies, and are rate limited per source and endpoint. Authentication errors never return hashes, database errors, or account existence details.

Socket.IO still uses the existing Phase 7 join identity during this milestone. Binding these server-validated sessions to sockets is Milestone 8.8 and must happen only after deployed cookie/database behavior has been verified.

## Deployment boundary still to complete

The production Cloudflare Durable Object realtime path and the Node/Socket.IO fallback currently duplicate player admission. Milestone 8.8 will make both consume the same short-lived, server-validated multiplayer admission ticket. Until that work is complete, the new database does not change existing guest joins or trust semantics.
