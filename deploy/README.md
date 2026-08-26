# Production deployment

The production architecture deliberately separates realtime traffic from large game downloads:

1. Run the included Docker image on a WebSocket-capable Node.js host.
2. Upload every asset you are legally allowed to distribute to one CDN-backed,
   S3-compatible object-storage bucket.
3. Set `GAME_ASSET_BASE_URL` to the public `games` directory,
   `BIOS_ASSET_URL` to the exact PlayStation BIOS object URL, and
   `GAMECUBE_DSP_ASSET_URL` to the exact GameCube DSP IROM object URL.

For example, if `pokemon-snap.n64` is reachable at
`https://games.example.com/arcade/games/pokemon-snap.n64`, configure:

```text
GAME_ASSET_BASE_URL=https://games.example.com/arcade/games
BIOS_ASSET_URL=https://games.example.com/arcade/bios/SCPH1001.BIN
GAMECUBE_DSP_ASSET_URL=https://games.example.com/arcade/bios/dsp_rom.bin
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

Production uses `assets.ptcarcade.fun`. The Cloudflare Worker route declared in
`cloudflare/wrangler.jsonc` fronts the same bucket through the `ARCADE_ASSETS`
binding. Finite byte ranges up to 8 MiB are stored as independent Cache API
objects, allowing multi-gigabyte PS2 images to benefit from edge caching even
though they exceed the CDN's whole-object cache-size limit. Responses expose
`X-Arcade-Edge-Cache: MISS` or `HIT` for read-only verification.

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

Run `npm run verify:games` before uploading. The public manifest covers the locally mirrored PS1/N64 games and configured PlayStation BIOS. `remote-ps2-assets.json` and `remote-gamecube-assets.json` track larger images uploaded directly from approved source locations with `npm run storage:upload-external`; the remote verifier checks every manifest. Pass `--system=ps2` or `--system=gamecube` so object metadata remains accurate. GameCube RVZ files are consumed by the pinned experimental Gecko WebGPU runtime and currently require enough browser memory to retain the complete compressed image.

## Backend health

The service exposes `GET /health` and the backwards-compatible `GET /healthz` for liveness, `GET /ready` for capacity-aware readiness, and `GET /metrics` in Prometheus text format. Configure the host's health check to use `/ready`; it returns 503 while initializing, draining, or beyond a configured safety threshold. Use `SERVER_ID`, `SERVER_REGION`, `SOFTWARE_VERSION`, `MAX_PLAYERS_PER_ROOM`, `MAX_ROOMS_PER_SERVER`, `MAX_PLAYERS_PER_SERVER`, `MAX_PENDING_CONNECTIONS`, `RECONNECT_GRACE_SECONDS`, `MAX_SERVER_MEMORY_MB`, `MAX_EVENT_LOOP_DELAY_MS`, `SERVER_DRAIN_TIMEOUT_SECONDS`, and `SERVER_SHUTDOWN_WARNING_SECONDS` to configure the operational envelope. Current defaults are 25 players per room, 10 rooms per server, and 250 active players per server.

The legacy endpoint remains available for simple liveness probes. The service listens on `PORT`, supports WebSocket and polling transports,
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

For Phase 7 development, run `docker compose -f docker-compose.phase7.yml up redis`, set `REDIS_URL=redis://127.0.0.1:6379`, and set a non-production `REDIS_KEY_PREFIX`. Scaled deployments must set `REDIS_REQUIRED=1` and use sticky sessions while Socket.IO polling remains enabled. See `docs/phase-7-architecture.md` and `docs/redis-keys.md` for ownership, TTL, and security details.

## Fly.io West Coast deployment (canonical)

`fly.toml` is the deployment target for `ptcarcade.fun`. It runs the current
authoritative Socket.IO service as one always-on machine in Los Angeles
(`lax`). Domain, DNS, certificate, and secret setup are in
`docs/deployment-ptcarcade-fun.md`. Large game and BIOS downloads continue to come
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

## DigitalOcean low-cost deployment (spare)

`.do/app.yaml` is kept as a spare target only; it does not serve
`ptcarcade.fun` and does not deploy on push. It runs one fixed
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
