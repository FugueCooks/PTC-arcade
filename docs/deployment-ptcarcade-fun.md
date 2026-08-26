# Deploying ptcarcade.fun

Canonical host: **Fly.io**, app `retro-arcade-fugue`, region `lax`.

## Why Fly and not the others

| Target | Serves | Idles? | Role |
|---|---|---|---|
| **Fly** | static + Socket.IO + auth + matchmaking + Phase 11 APIs | **No** — `min_machines_running = 1`, `auto_stop_machines = "off"` | canonical |
| DigitalOcean | same image | No, but paid | spare, no domain, deploy-on-push off |
| Cloudflare Pages + Worker | static + WebSocket realtime only | No | **cannot serve the whole app** |

Render has been removed. `render.yaml` is deleted, so a merge to `main` no
longer triggers a Render build, and the free plan's idle spin-down — the reason
the site took a minute to wake — is gone with it. If a Render service still
exists in the dashboard from an earlier deploy, delete or suspend it there;
removing the blueprint from the repository stops future deploys but does not
tear down a service that is already running.

The Cloudflare split is not a substitute. `cloudflare/src/index.ts` handles
WebSocket upgrades into Durable Objects and nothing else — it serves no
`/api/auth`, `/api/account`, `/api/rooms`, or Phase 11 `/api/v1` route. Pointing
the domain there would give you a lobby that cannot log anyone in.

Deploy-on-push is disabled on DigitalOcean, and it holds no custom domain, so a
merge to `main` cannot quietly start a second build serving `ptcarcade.fun`
from different code.

## Deploying

`.github/workflows/deploy-fly.yml` deploys `main` to Fly on every push, after
`npm run lint` and `npm test` pass — a red build never reaches the domain. It
needs one repository secret, set once:

```sh
fly tokens create deploy -x 8760h     # prints the token
```

Add it at **Settings → Secrets and variables → Actions → New repository
secret**, named `FLY_API_TOKEN`. Until that secret exists the workflow's verify
job passes and the deploy job fails on authentication.

To deploy the current `main` without pushing a commit — a rollback, or after
changing a secret — run the workflow from **Actions → Deploy to Fly → Run
workflow**.

By hand, from a machine with the Fly CLI authenticated:

```sh
fly deploy
fly status                       # confirm one machine, started
curl -s https://retro-arcade-fugue.fly.dev/health
```

## The scripted cutover

`.github/workflows/link-domain.yml` does the whole of "One-time setup" below in
one run: deploy, allocate dedicated addresses, repoint Cloudflare DNS, issue the
certificates, verify the live domain. Manual trigger only — it changes live DNS,
so it never fires from a push.

It needs two repository secrets:

| Secret | How to get it |
|---|---|
| `FLY_API_TOKEN` | `fly tokens create deploy -x 8760h` |
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → Create Token → **Edit zone DNS**, scoped to this zone |

Then **Actions → Link ptcarcade.fun to Fly → Run workflow**. Leave *dry run*
checked the first time: it prints exactly which records it would add, change,
and remove, and touches nothing. Run it again with *dry run* unchecked to apply.

The DNS step is deliberately narrow. It replaces the address records for the
apex and `www` and nothing else — MX, TXT, and any other subdomain are left
alone, because deleting a mail record while repointing a website is not a
recoverable mistake. `test/link-domain.test.ts` covers that, along with
re-running against an already-settled zone, which plans no changes.

The steps below are the same work done by hand.

## One-time setup

### 1. Set secrets (never in fly.toml)

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

`DATABASE_URL` is optional but shapes what players can do. Without it every
`/api/auth/*` route answers `503 auth-unavailable`; `avatar-selection.js`
tolerates that and drops the player into a local `GUEST_xxxxxx` identity, so the
arcade is playable but **wallet sign-in and saved profiles are not**. Set it
when accounts should persist.

### 2. Get the app's IP addresses

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

### 3. Point DNS at Fly

**The zone is on Cloudflare, not Spaceship.** Measured 2026-08-26:

```
NS     stan.ns.cloudflare.com, donna.ns.cloudflare.com
A      104.21.20.102, 172.67.192.84      <- Cloudflare anycast, not an origin
AAAA   2606:4700:3032::6815:1466, 2606:4700:3035::ac43:c054
www    no record at all
```

Spaceship is the registrar, but the nameservers were delegated to Cloudflare, so
Spaceship's DNS panel does not control this domain — edits there change nothing.
Records live in the Cloudflare dashboard.

Those A records are Cloudflare's own addresses, which means the record is
**proxied** (orange cloud) and the real origin sits behind it. Re-check before
editing, since this can change:

```sh
dig +short NS ptcarcade.fun
dig +short A ptcarcade.fun
```

In the Cloudflare dashboard, **ptcarcade.fun → DNS → Records**:

| Type | Name | Value | Proxy status |
|---|---|---|---|
| A | `@` | the IPv4 from `fly ips list` | **DNS only** (grey cloud) |
| AAAA | `@` | the IPv6 from `fly ips list` | **DNS only** (grey cloud) |
| CNAME | `www` | `ptcarcade.fun` | **DNS only** (grey cloud) |

Delete the existing A and AAAA records first — they point at the previous host.

Grey cloud, not orange, and the reason matters. Proxied, Cloudflare terminates
TLS with its own certificate and answers the ACME HTTP challenge itself, so
`fly certs add` cannot validate and Fly never gets a certificate. With
Cloudflare's SSL mode on "Flexible" that combination also produces a redirect
loop, and on "Full (strict)" a 526, both of which look like an application
fault and are not. DNS-only puts Fly directly in front of the browser with its
own certificate, which is the configuration the rest of this document assumes.

Nothing here needs Cloudflare's proxy: game and BIOS binaries already come from
R2 rather than the origin, and Socket.IO is a long-lived connection that gains
nothing from a CDN in front of it. If you want the proxy on later, turn it on
after the domain works end to end, and set SSL mode to Full (strict).

One more thing to check while in the dashboard: if a **Cloudflare Pages**
project claims `ptcarcade.fun` as a custom domain, it will keep intercepting the
hostname no matter what the DNS records say. Remove the custom domain from
**Workers & Pages → the project → Custom domains**. The Pages deployment at
`retro-arcade-om7.pages.dev` stays reachable on its own hostname.

### 4. Issue the certificate

```sh
fly certs add ptcarcade.fun
fly certs add www.ptcarcade.fun
fly certs show ptcarcade.fun
```

Fly validates ownership through the records from step 3, so add DNS first, and
leave them DNS-only until `fly certs show` reports the certificate issued. If it
stays pending, the record is almost certainly still proxied.

### 5. Verify

```sh
dig +short A ptcarcade.fun          # must be the Fly IPv4, not 104.21.x / 172.67.x
curl -s https://ptcarcade.fun/health
curl -s https://ptcarcade.fun/api/v1/platform
curl -sI https://ptcarcade.fun | grep -i strict-transport
```

A Cloudflare address still in the `dig` answer means the record is proxied or a
Pages project still claims the hostname — go back to step 3.

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

Or revert the commit and push: the workflow deploys `main` as it stands.

No data migration reverses, because Phase 11 added no tables. The one
forward-incompatible change is `assets/games/registry.json` at version 2; the
current loader accepts both versions 1 and 2, so rolling forward is always safe,
and only a rollback to a pre-Phase-11 image would need that file reverted too.
