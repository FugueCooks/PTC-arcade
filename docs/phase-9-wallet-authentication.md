# Phase 9 wallet authentication

## Architecture

PTC Arcade has two identity modes:

- **Guest:** a server-generated name, approved capsule avatar, short opaque session, and no durable profile writes.
- **Wallet account:** a verified Solana wallet maps to one persistent PostgreSQL user and may save an approved name, avatar, and preferences.

Wallet connection is not authentication. The browser discovers Wallet Standard providers and requests a server challenge. The wallet signs the exact Sign-In With Solana message. The server verifies the Ed25519 signature, domain, origin, network, expiry, address, message bytes, and one-time challenge before issuing the existing opaque HttpOnly session.

```text
Wallet Standard provider
  -> POST /api/auth/wallet/challenge (public address)
  <- SIWS input + one-time challenge ID
  -> wallet signs locally (no transaction / no SOL)
  -> POST /api/auth/wallet/verify (signature output)
  -> Redis atomic challenge consumption
  -> PostgreSQL WalletIdentity find-or-create
  <- Secure HttpOnly application session
  -> signed realtime ticket (guest|wallet)
  -> Node Socket.IO or Cloudflare Durable Object
```

The wallet does not sign ordinary API or multiplayer events. The opaque application session handles subsequent requests and can be revoked independently.

## Data model

`users.public_player_id` is the durable public gameplay identity. Legacy username, email, and password columns are nullable so migrated records remain intact without permitting new public password accounts.

`wallet_identities` stores `user_id`, chain, explicit network, verified address, and verification/creation/last-use timestamps. Its unique `(chain, network, normalized_wallet_address)` index prevents duplicate accounts. Signatures, messages, nonces, private keys, and seed phrases are not persisted.

## Challenge lifecycle and Redis

Challenges use `arcade:...:wallet-challenges:{challengeId}` with a configurable TTL (default five minutes). Records contain the expected input hash, address, origin, environment, issue/expiry time, and attempt count. Redis Lua scripts atomically increment attempts and consume a successful challenge. Authentication rate-limit keys contain only a SHA-256 identifier digest and expire with their window.

## Guest and entitlement policy

The server decides entitlements. Guests cannot choose custom avatars, persistent names, preferences, or progress. Realtime tickets label identity mode, and both Node and Cloudflare force guests to the default capsule even when a client is modified. No durable progress model exists yet, so Phase 9 does not invent one.

## Wallet and session behavior

- Disconnecting a wallet leaves the valid application session active.
- Explicit **Sign out** revokes the application session and returns to guest entry.
- Changing provider accounts does not change authenticated identity; a new challenge is required.
- A newer gameplay connection for the same stable player replaces the older one, avoiding duplicate avatars.
- One wallet initially maps to one account. Multi-wallet linking and wallet recovery are absent.
- Losing wallet control can mean losing account access. PTC Arcade cannot recover seed phrases or sign for a user.

## Provider support

Desktop uses Wallet Standard discovery and providers offering `solana:signIn` or `solana:signMessage`. Android also registers the maintained Mobile Wallet Adapter Standard Wallet. Mobile compatibility depends on the installed wallet and message-signing support; proprietary deep links are not used.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `WALLET_AUTH_ENABLED` | `1` | Enable wallet endpoints |
| `LEGACY_PASSWORD_AUTH_ENABLED` | `0` | Emergency legacy player-login switch |
| `WALLET_CHALLENGE_TTL_SECONDS` | `300` | Challenge lifetime |
| `WALLET_CHALLENGE_MAX_ATTEMPTS` | `5` | Verification attempt ceiling |
| `SOLANA_NETWORK` | `mainnet-beta` | Environment binding |
| `SOLANA_APP_DOMAIN` | `localhost:8080` | Exact message domain |
| `SOLANA_APP_URI` | `http://localhost:8080` | Exact app URI/origin |
| `SOLANA_RPC_URL` | empty | Reserved for future reads; login does not use RPC |
| `GUEST_SESSION_TTL_SECONDS` | `3600` | Temporary guest lifetime |

Production also requires PostgreSQL, Redis, HTTPS cookies, an exact `PUBLIC_APP_ORIGIN`, and a strong `MULTIPLAYER_TICKET_SECRET`.

## Local development

1. Start PostgreSQL and set `DATABASE_URL`.
2. Optionally start Redis and set `REDIS_URL`; production should require Redis.
3. Set `AUTH_COOKIE_SECURE=0`, `PUBLIC_APP_ORIGIN=http://localhost:8080`, `SOLANA_APP_DOMAIN=localhost:8080`, and `SOLANA_APP_URI=http://localhost:8080`.
4. Run `npm run db:migrate`, `npm run wallet:build`, and `npm run dev`.
5. Open `http://localhost:8080`. Guest play needs no wallet.

## Migration, deployment, and rollback

Apply `0002_cute_black_queen.sql` before wallet requests. Docker applies pending migrations before serving. Deploy the backward-compatible Cloudflare worker first, then Node: the transitional edge accepts legacy v1 tickets as guest-only and Phase 9 v2 tickets with explicit identity mode. Remove v1 support only after the old Node deployment is fully retired.

For rollback, first disable `WALLET_AUTH_ENABLED`. The additive migration preserves legacy users; do not drop wallet data during an emergency application rollback. Public password registration/login stays disabled unless its explicit legacy flag is enabled.

## Limitations and future work

- No wallet recovery, secondary wallet, token/NFT gating, balances, transactions, payments, or on-chain progress.
- iOS support depends on a compatible Wallet Standard provider.
- Production wallet auth becomes unready if required Redis is unavailable, preserving replay protection.
- Account deletion requires an authenticated wallet session plus explicit `DELETE` confirmation; a fresh wallet re-sign is sensible later hardening.
- Progress awaits a separately designed, server-verifiable model.

The safest Phase 10 scope is profile/presence polish and optional secondary-wallet recovery design—not payments, token gating, or emulator score claims.
