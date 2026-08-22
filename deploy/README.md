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
behavior without downloading every multi-hundred-megabyte object again.

For R2, attach a public custom domain to the bucket and apply a CORS policy based
on `deploy/r2-cors.json`. Replace the placeholder arcade origin before applying
it. Public read access must not grant object listing or write access.

## Object-storage requirements

- Preserve the exact filenames and layout in `public-assets.manifest.json`.
- Enable public `GET`, `HEAD`, and byte-range requests.
- Return `Access-Control-Allow-Origin` for the arcade origin (or `*` for non-credentialed public game assets).
- Set `Cache-Control: public, max-age=31536000, immutable`.
- Use `application/octet-stream` when a platform does not recognize a ROM extension.
- Put a CDN/custom domain in front of the bucket for low-latency regional delivery.
- Only upload game and BIOS files that you have the right to make available to
  every visitor. The browser still supports player-selected local files as a
  fallback.

Run `npm run verify:games` before uploading. The public manifest covers all ten
current games and the configured PlayStation BIOS.

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
