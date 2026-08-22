# Production deployment

The production architecture deliberately separates realtime traffic from large game downloads:

1. Run the included Docker image on a WebSocket-capable Node.js host.
2. Upload every locally licensed game in `assets/games/` to one public CDN-backed object-storage directory.
3. Set `GAME_ASSET_BASE_URL` to that directory, without a trailing slash.

For example, if `pokemon-snap.n64` is reachable at
`https://games.example.com/arcade/pokemon-snap.n64`, configure:

```text
GAME_ASSET_BASE_URL=https://games.example.com/arcade
```

If the variable is blank, the server preserves the existing local behavior and serves files from `assets/games/` with byte-range support.

## Object-storage requirements

- Preserve the exact filenames in `game-assets.manifest.json`.
- Enable public `GET`, `HEAD`, and byte-range requests.
- Return `Access-Control-Allow-Origin` for the arcade origin (or `*` for non-credentialed public game assets).
- Set `Cache-Control: public, max-age=31536000, immutable`.
- Use `application/octet-stream` when a platform does not recognize a ROM extension.
- Put a CDN/custom domain in front of the bucket for low-latency regional delivery.
- Do not upload BIOS files. Players continue supplying their own PlayStation BIOS locally.

Run `node tools/verify-game-assets.mjs` before and after an upload workflow to compare file sizes and SHA-256 values. The manifest covers all ten currently hosted games.

## Backend health

The service exposes `GET /healthz`. Configure the host's health check to use that path. The service listens on `PORT`, supports WebSocket and polling transports, uses proxy-safe keep-alive values, and never sends ROM bytes over Socket.IO.

## Database

No database is required for the current rooms, movement, chat, cabinets, or world state. Add persistent storage only when accounts, cloud saves, durable scores, or profiles are introduced. Redis becomes useful only when multiple realtime server instances must share room state.
