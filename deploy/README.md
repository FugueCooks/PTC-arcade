# Production deployment

The production architecture deliberately separates realtime traffic from large game downloads:

1. Run the included Docker image on a WebSocket-capable Node.js host.
2. Upload every asset you are legally allowed to distribute to one CDN-backed,
   S3-compatible object-storage bucket.
3. Set `GAME_ASSET_BASE_URL` to the public `games` directory and
   `BIOS_ASSET_URL` to the exact BIOS object URL.

For example, if `pokemon-snap.n64` is reachable at
`https://games.example.com/arcade/games/pokemon-snap.n64`, configure:

```text
GAME_ASSET_BASE_URL=https://games.example.com/arcade/games
BIOS_ASSET_URL=https://games.example.com/arcade/bios/SCPH1001.BIN
```

If either variable is blank, the server preserves the corresponding local
`assets/games/` or `assets/bios/` behavior with byte-range support.

## Automated S3/R2 upload

The included uploader works with Cloudflare R2 and other S3-compatible stores.
Copy `.env.example` to a local `.env` or set the variables in your shell. Never
commit the credentials.

```text
STORAGE_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com
STORAGE_REGION=auto
STORAGE_BUCKET=retro-arcade-assets
STORAGE_ACCESS_KEY_ID=...
STORAGE_SECRET_ACCESS_KEY=...
STORAGE_PUBLIC_BASE_URL=https://games.example.com
STORAGE_PREFIX=arcade
```

First validate the local files, then upload and validate the public edge:

```powershell
npm run verify:games
npm run storage:upload
npm run storage:verify
```

The uploader uses multipart uploads, verifies local sizes, stores the manifest
SHA-256 as object metadata, skips matching remote objects, and applies immutable
one-year cache headers. `deploy/public-assets.manifest.json` is the source of
truth for both games and BIOS. The verifier confirms public size and byte-range
behavior plus browser CORS access without downloading every multi-hundred-megabyte
object again. Set `ASSET_CORS_ORIGIN` only when verifying a frontend origin other
than the production Cloudflare Pages URL.

For R2, attach a public custom domain to the bucket and apply the checked-in
read-only browser policy with `npm run storage:cors`. The policy allows public
origins because game and BIOS objects are already public, non-credentialed
downloads; it still permits only `GET` and `HEAD`, including byte ranges. Public
read access must not grant object listing or write access.

## Object-storage requirements

- Preserve the exact filenames and layout in `public-assets.manifest.json`.
- Enable public `GET`, `HEAD`, and byte-range requests.
- Return `Access-Control-Allow-Origin` for the arcade origin (or `*` for non-credentialed public game assets).
- Set `Cache-Control: public, max-age=31536000, immutable`.
- Use `application/octet-stream` when a platform does not recognize a ROM extension.
- Put a CDN/custom domain in front of the bucket for low-latency regional delivery.
- Store PlayStation CD images as CHD (or another emulator-supported compressed
  format) instead of raw BIN/ISO whenever possible. Compression is the only way
  to reduce the bytes every first-time visitor must download; CDN caching reduces
  origin latency but cannot make a multi-hundred-megabyte image small.
- Only upload game and BIOS files that you have the right to make available to
  every visitor. The browser still supports player-selected local files as a
  fallback.

Run `npm run verify:games` before uploading. The public manifest covers the locally mirrored PS1/N64 games and configured PlayStation BIOS. `remote-ps2-assets.json` tracks the much larger PS2 images uploaded directly from approved source locations with `npm run storage:upload-external`; the remote verifier checks both manifests.

## Backend health

The service exposes `GET /healthz`. Configure the host's health check to use that
path. The service listens on `PORT`, supports WebSocket and polling transports,
uses proxy-safe keep-alive values, and never sends ROM or BIOS bytes over
Socket.IO. Deploy exactly one backend instance for now because room state is
in-memory. The CDN handles the large downloads independently.

Required backend environment variables in production:

```text
NODE_ENV=production
TRUST_PROXY=1
GAME_ASSET_BASE_URL=https://games.example.com/arcade/games
BIOS_ASSET_URL=https://games.example.com/arcade/bios/SCPH1001.BIN
```

## Database

No database is required for the current rooms, movement, chat, cabinets, or world state. Add persistent storage only when accounts, cloud saves, durable scores, or profiles are introduced. Redis becomes useful only when multiple realtime server instances must share room state.

## Fly.io West Coast deployment

`fly.toml` runs the current authoritative Socket.IO service as one always-on
machine in Los Angeles (`lax`). Large game and BIOS downloads continue to come
directly from Cloudflare R2, so they never consume realtime-server bandwidth.

Deploy after authenticating the Fly CLI and enabling billing:

```powershell
flyctl apps create retro-arcade-fugue --org personal
flyctl deploy
flyctl status
flyctl checks list
```

Keep exactly one machine until room state is moved out of process. Adding
replicas before regional room ownership or shared coordination exists can split
players and cabinet ownership across independent server memories. The current
configuration keeps the machine awake to avoid reconnects and cold-start delays.

## DigitalOcean low-cost deployment

`.do/app.yaml` is the preferred low-cost deployment. It runs one fixed
512 MiB container in DigitalOcean's San Francisco region and costs $5/month at
current published pricing. Cloudflare R2 continues to serve game and BIOS data.

Create the app from the private GitHub repository and select the existing app
spec, or run the following after authenticating `doctl`:

```powershell
doctl apps create --spec .do/app.yaml
```

The fixed plan intentionally permits only one container, matching the current
in-memory authoritative room architecture. If process memory approaches 400 MiB
or the server becomes CPU-bound under load, change `instance_size_slug` to
`apps-s-1vcpu-1gb-fixed` ($10/month) before considering horizontal scaling.

## Render free testing deployment

`render.yaml` defines a no-cost Render Web Service using the repository's
Dockerfile. It runs one 512 MiB instance in Oregon, keeps room authority in one
process, checks `/healthz`, and sends game and BIOS downloads directly to the
existing Cloudflare R2 public bucket.

Create a Blueprint from the private GitHub repository and accept the settings
from `render.yaml`. No database is required. Render supplies `PORT`
automatically, so do not hardcode it in the Blueprint.

The free service is intended for remote testing. It can spin down after 15
minutes without HTTP or WebSocket activity and may take about a minute to wake.
It is not the production target for hundreds of concurrent players. If the
free service reaches its included usage limits without a payment method, Render
suspends it instead of charging the account.
