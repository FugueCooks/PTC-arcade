# Phase 8 authentication architecture (legacy foundation)

> Phase 9 disables public username/password registration and login by default. The database, opaque-session, preference, guest, and audit foundations remain in use; persistent player access now requires verified Solana wallet control. See `phase-9-wallet-authentication.md`.

Phase 8 keeps durable identity separate from live arcade simulation. PostgreSQL stores username/password accounts, guest identities, opaque sessions, profile preferences, and bounded security audit events. Redis continues to coordinate temporary presence, room routing, reconnects, rate limits, and active-connection locks. Movement, cabinets, room state, world state, and animation remain outside PostgreSQL.

## Milestone 8.1 database foundation

The schema is declared in `server/src/database/schema.ts` and its reviewed SQL migration is committed under `drizzle/`. Generate a new migration with `npm run db:generate`; apply committed migrations with `npm run db:migrate`. The production Docker image applies pending committed migrations before it starts the web server whenever `DATABASE_URL` is configured, and aborts startup if migration fails. Never use `drizzle-kit push` against production.

`DATABASE_URL` is optional while the arcade remains guest-only. Setting `DATABASE_REQUIRED=1` makes `/ready` fail safely until PostgreSQL is reachable. Database credentials are never included in readiness responses or structured logs. The connection pool is closed during graceful shutdown.

For local development:

1. Run `docker compose -f docker-compose.phase8.yml up -d`.
2. Set `DATABASE_URL=postgresql://retro_arcade:local-development-only@127.0.0.1:5432/retro_arcade`.
3. Run `npm run db:migrate`.
4. Optionally provide explicit `SEED_DEVELOPMENT_*` values and run `npm run db:seed`. Seeding refuses to run when `NODE_ENV=production`.

## Security primitives

Passwords use Argon2id version 19. Production defaults are 19,456 KiB memory, two iterations, and parallelism one. Each hash receives a library-generated random salt. Parameters are bounded configuration values so deployment tuning cannot silently disable the work factor.

Sessions use 256-bit random opaque tokens. Only SHA-256 token digests are stored. Long-lived credentials are delivered through Secure, HttpOnly, same-origin cookies; they never enter local storage, URLs, logs, Three.js scene state, or multiplayer payloads.

Registered accounts and guests share the `sessions` table. A database constraint requires every session to reference exactly one user or one guest. Guest conversion preserves the live room until the authentication service performs an explicit identity handoff in a later milestone.

## HTTP authentication milestone

When PostgreSQL is configured and healthy, the Node service exposes `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/guest`, `GET /api/auth/session`, and `POST /api/auth/logout`.

Registration and login require only a unique 2–18 character username and a password. No email address or verification step is exposed or required. Successful registration, login, and guest creation issue an opaque session in an `HttpOnly`, `SameSite=Strict` cookie. Only its SHA-256 hash is stored. Production enables the cookie `Secure` flag. Mutations reject cross-site browser requests, use bounded JSON bodies, and are rate limited per source and endpoint. Authentication errors never return hashes, database errors, or account existence details.

The Node Socket.IO path now resolves the cookie during the handshake and ignores client-supplied identity whenever PostgreSQL authentication is enabled. A stable non-database public player ID is derived from the validated subject. Redis owns a short-lived active-connection and presence mapping, and a newer connection replaces the older gameplay socket instead of creating a duplicate avatar.

The production Cloudflare realtime transport uses a short-lived HMAC-SHA256 admission ticket from `POST /api/auth/realtime-ticket`. The ticket contains only the stable public player ID, validated display name, approved avatar ID, expiry, and nonce. It contains no username, database ID, session cookie, or database credential. The edge verifies the signature before accepting the WebSocket, ignores client-supplied identity, and replaces an older socket for the same identity within a room. Tickets expire after 30 seconds by default and are refreshed automatically for reconnects.

## Account and profile APIs

Registered users can read and update their approved display name/avatar and bounded preferences under `/api/account`. Profile changes update the active room without disconnecting the player. Session endpoints list privacy-safe device type and timestamps, revoke an individual session, or revoke every other session. Account deletion requires the current password, revokes sessions, clears live presence, and pseudonymizes unique username/display-name fields while retaining a soft-deleted row for referential integrity. Legacy email columns and token tables remain only for additive migration compatibility and are not part of the active account flow.

Security audit events cover account creation, login outcome, session revocation, profile identity changes, and deletion requests. Audit rows expire after 90 days and exclude passwords, tokens, IP addresses, and chat content.

## Client behavior

The player-select screen supports one-field usernames for guest entry, username/password registration, username/password sign-in, session restoration, sign-out, and profile updates. The primary button clearly reflects the selected action. No long-lived credential enters local storage. Deployments without PostgreSQL retain the established guest path, preventing an account-service outage from taking down the arcade preview.

## API overview

- `POST /api/auth/register`, `/login`, `/guest`, `/logout`
- `GET /api/auth/session`
- `POST /api/auth/realtime-ticket`
- `GET|PUT /api/account/profile`
- `GET|PUT /api/account/preferences`
- `GET /api/account/sessions`
- `DELETE /api/account/sessions/:sessionId`
- `POST /api/account/sessions/revoke-others`
- `DELETE /api/account`

All responses use bounded, generic error envelopes. Cross-site mutations are rejected, production cookies are always Secure/HttpOnly/SameSite=Strict, bodies are limited to 16 KiB, and account/auth mutations are rate limited.

## Deployment boundary

The account page and account API must remain same-origin so `SameSite=Strict` cookies stay protected. The Cloudflare Durable Object never receives that cookie. It receives only the short-lived admission ticket described above. The Render application URL is therefore the canonical Phase 8 entry point; any separate static mirror must redirect there rather than attempt cross-site account cookies.

The selected Render free PostgreSQL tier is suitable for development validation, not a high-availability public launch. It expires or may be suspended under Render's current free-tier policy and must be upgraded or replaced before relying on durable accounts.

## Environment reference

`DATABASE_URL`, `DATABASE_REQUIRED`, `DATABASE_POOL_MAX`, `SESSION_TTL_DAYS`, `GUEST_SESSION_TTL_DAYS`, `PASSWORD_ARGON2_MEMORY_KIB`, `PASSWORD_ARGON2_ITERATIONS`, `PASSWORD_ARGON2_PARALLELISM`, `AUTH_COOKIE_NAME`, `AUTH_COOKIE_SECURE`, `AUTH_REQUEST_LIMIT_PER_10_MINUTES`, `PUBLIC_APP_ORIGIN`, `MULTIPLAYER_TICKET_SECRET`, and `MULTIPLAYER_TICKET_TTL_SECONDS` are documented in `.env.example`.

`MULTIPLAYER_TICKET_SECRET` must be the same cryptographically random secret in Render and the Cloudflare realtime Worker. Store it only in provider-managed secret configuration. Never commit it, expose it in runtime configuration, or reuse a session/database credential.

## Rollback

Leave `DATABASE_REQUIRED=0` and remove `DATABASE_URL` to return to legacy guest-only admission without reverting scene, cabinet, ROM, or multiplayer code. Database migrations are additive; never reset production data. Roll back application code before manually reverting a migration, and take a database backup first.
