# Deploying ptcarcade.fun

Canonical host: **Fly.io**, app `retro-arcade-fugue`, region `lax`.

## Why Fly and not the others

| Target | Serves | Idles? | Role |
|---|---|---|---|
| **Fly** | static + Socket.IO + auth + matchmaking + Phase 11 APIs | **No** — `min_machines_running = 1`, `auto_stop_machines = "off"` | canonical |
| Render | same image | **Yes** — `plan: free` spins down when idle | spare, auto-deploy off |
| DigitalOcean | same image | No, but paid | spare, auto-deploy off |
| Cloudflare Pages + Worker | static + WebSocket realtime only | No | **cannot serve the whole app** |

The Cloudflare split is not a substitute. `cloudflare/src/index.ts` handles
WebSocket upgrades into Durable Objects and nothing else — it serves no
`/api/auth`, `/api/account`, `/api/rooms`, or Phase 11 `/api/v1` route. Pointing
the domain there would give you a lobby that cannot log anyone in.

Auto-deploy is disabled on Render and DigitalOcean so a merge to `main` cannot
quietly start a second build serving the same domain from different code.

## One-time setup

### 1. Deploy the current build to Fly

```sh
fly deploy
fly status                       # confirm one machine, started
curl -s https://retro-arcade-fugue.fly.dev/health
```

### 2. Set secrets (never in fly.toml)

`fly.toml` is committed, so it holds only public configuration. Anything
secret goes through `fly secrets`, which is encrypted and injected at runtime:

```sh
fly secrets set \
  MULTIPLAYER_TICKET_SECRET="$(openssl rand -base64 48)" \
  DATABASE_URL="postgres://..." \
  REDIS_URL="redis://..."
```

To enable the Phase 11 operations console — optional, and off until you do:

```sh
fly secrets set OPERATIONS_OPERATORS="yourname:admin:$(openssl rand -base64 32)"
```

Keep that token somewhere safe; it is the only way into `/ops`, and only its
hash is stored. Without this variable the console is not served at all.

### 3. Get the app's IP addresses

An apex domain cannot use a CNAME, so `ptcarcade.fun` needs A and AAAA records
pointing at Fly's addresses for this app:

```sh
fly ips list
```

If no dedicated IPv4 is listed, allocate one — a shared IPv4 will not work for a
custom apex domain:

```sh
fly ips allocate-v4
fly ips allocate-v6
```

Note both addresses.

### 4. Add DNS at Spaceship

In the Spaceship dashboard: **Domains → ptcarcade.fun → Advanced DNS** (or
"Manage DNS"). Delete any parking / placeholder records first, then add:

| Type | Host | Value | TTL |
|---|---|---|---|
| A | `@` | the IPv4 from `fly ips list` | Automatic |
| AAAA | `@` | the IPv6 from `fly ips list` | Automatic |
| CNAME | `www` | `ptcarcade.fun` | Automatic |

Leave Spaceship's nameservers as they are — you are editing records, not
delegating the zone elsewhere.

### 5. Issue the certificate

```sh
fly certs add ptcarcade.fun
fly certs add www.ptcarcade.fun
fly certs show ptcarcade.fun
```

Fly validates ownership through the records from step 4, so add DNS first.
`fly certs show` reports both DNS and certificate status; it usually completes
within a few minutes, but allow up to an hour for propagation.

### 6. Verify

```sh
curl -s https://ptcarcade.fun/health
curl -s https://ptcarcade.fun/api/v1/platform
curl -sI https://ptcarcade.fun | grep -i strict-transport
```

Then in a browser: load the site, enter as a guest, walk to a cabinet, and
**launch one game end to end**. See "Before you announce it" below.

## Why the domain variables matter

`fly.toml` now sets three domain-dependent values. They are public config, not
secrets, which is why they belong in the committed file:

- `PUBLIC_APP_ORIGIN=https://ptcarcade.fun` — the exact browser origin allowed
  to mutate account state. `server/src/http/auth-routes.ts` and
  `account-routes.ts` reject cross-site mutations against it. Wrong value:
  login and profile writes fail.
- `SOLANA_APP_DOMAIN=ptcarcade.fun` — **the domain a wallet shows the player
  when asking them to sign in.** Host only, no scheme, no trailing slash. If it
  does not match the address bar exactly, wallets warn on or refuse the
  signature. This is the setting most likely to break quietly.
- `SOLANA_APP_URI=https://ptcarcade.fun` — the URI recorded in the signed
  message.

`NODE_ENV=production` is already set, which makes session cookies `Secure`
automatically. `TRUST_PROXY=1` is already set, which is required for correct
client IPs behind Fly's proxy.

## Changing the domain later

Update those three values in `fly.toml`, redeploy, add the new DNS records, and
`fly certs add` the new hostname. Nothing else in the codebase hardcodes a
domain.

## Before you announce it

Two things are worth doing by hand, because neither has been verified end to
end:

1. **Launch a real game.** Phase 11 rewrote the emulator launch path. The
   handoff — adapter selection, iframe URL, BIOS parameter, the postMessage
   handshake — is verified against a stubbed core, but no full session has run
   against the real EmulatorJS CDN and a real disc image from R2. Open a
   PlayStation cabinet, press play, and confirm it boots and accepts input.
   Then try a PS2 and a GameCube cabinet, since those use different cores.
2. **Confirm R2 allows the new origin.** Game images are fetched cross-origin
   with range requests. If R2's CORS policy lists specific origins rather than
   `*`, add `https://ptcarcade.fun`, or large games will fail to stream with an
   opaque error. `npm run storage:cors` applies `deploy/r2-cors.json`.

## Rollback

```sh
fly releases                     # find the previous version
fly deploy --image <previous>    # or: fly releases rollback
```

No data migration reverses, because Phase 11 added no tables. The one
forward-incompatible change is `assets/games/registry.json` at version 2; the
current loader accepts both versions 1 and 2, so rolling forward is always safe,
and only a rollback to a pre-Phase-11 image would need that file reverted too.
