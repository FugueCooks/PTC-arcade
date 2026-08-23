# NEON//ARCADE

A Three.js/WebGL arcade floor with a lightweight Socket.IO multiplayer foundation. An internet connection is needed the first time to load Three.js, fonts, and EmulatorJS.

## Production hosting

The production frontend is deployed on Cloudflare Pages at `https://retro-arcade-om7.pages.dev/`. Run `npm run pages:build` to create the strict `.pages-dist` bundle and `npm run pages:deploy` to publish it. The bundle excludes ROMs, BIOS files, unused model experiments, and every file over Cloudflare Pages' safe per-file limit. Hosted game and BIOS URLs continue to resolve through the R2 values written into `runtime-config.js`. Render remains a rollback Node host.

The Node.js service now serves only approved browser assets, exposes `/healthz`, uses proxy-safe HTTP keep-alive settings, and keeps movement traffic on compact Socket.IO messages with WebSocket support. Large game downloads are separated from realtime traffic through `GAME_ASSET_BASE_URL`; the hosted PlayStation BIOS is independently configured through `BIOS_ASSET_URL`.

- Leave `GAME_ASSET_BASE_URL` blank for the existing local `assets/games/` behavior.
- In production, point it at a CDN-backed object-storage `games` directory containing the exact files in `deploy/public-assets.manifest.json`.
- Point `BIOS_ASSET_URL` at the exact public BIOS object URL. Leaving it blank preserves the local `assets/bios/SCPH1001.BIN` fallback.
- The cabinet code resolves the same filenames through the runtime configuration, so switching between local and CDN assets requires no rebuild.
- ROMs and BIOS files are excluded from Git and Docker images. The S3-compatible multipart upload, public byte-range verification, CORS, and CDN deployment procedure is documented in `deploy/README.md`.
- MongoDB is not required. Current multiplayer state remains intentionally in memory; Redis is only needed when horizontally scaling the realtime service.

Build the production container with `docker build -t roms-retro-arcade .`. Run `npm run verify:games` to validate locally hosted games, `npm run storage:upload` to upload the approved public manifest, and `npm run storage:verify` to confirm CDN byte-range access.

Production uses one WebSocket-capable Node instance for authoritative multiplayer and a separate object-storage/CDN origin for game and BIOS downloads. This prevents multi-hundred-megabyte downloads from blocking movement, chat, cabinet ownership, or world events. A database is not necessary for the current feature set.

### Cloudflare realtime backend

`cloudflare/` contains an optional low-latency native WebSocket backend built with Cloudflare Workers and Durable Objects. Each room name maps to exactly one Durable Object, giving that room an atomic authority for players, cabinet ownership, chat, reactions, presence, AFK state, and reconnect grace. WebSocket Hibernation allows idle rooms to sleep while connections remain open. Room chat, cabinet state, reconnect records, and world state use Durable Object storage; ROMs, BIOS files, emulator frames, controller input, saves, video, and audio never enter this service.

The browser uses `realtime/realtime-socket.js`, a small Socket.IO-compatible transport boundary. With no `REALTIME_URL`, it uses the existing same-origin Socket.IO server unchanged. With `REALTIME_URL` configured, it uses native WebSockets and reconnects with bounded exponential backoff. This makes Cloudflare an opt-in production switch with an immediate Render fallback.

Cloudflare commands:

- `npm run cloudflare:typecheck` validates the Worker separately from the Node service.
- `npm run cloudflare:dev` starts a local Durable Object emulator.
- `npm run cloudflare:smoke` connects two local clients and verifies join, visibility, movement, sanitized chat, and acknowledgements.
- `npm run cloudflare:deploy` deploys the Worker after Cloudflare authentication.

After deployment, set the static host's `REALTIME_URL` to the full Worker endpoint, for example `https://retro-arcade-realtime.<account>.workers.dev/realtime`. Leave it blank to roll back to Render Socket.IO. The Worker validates room IDs, display names, approved avatar IDs, movement speed and bounds, cabinet proximity/ownership, chat, and reactions. Movement remains change-only at the browser and uses proximity-aware fan-out: nearby peers receive normal updates while far peers are capped at roughly one update per 300 ms.

The Worker currently accepts production WebSockets only from the approved Render and Cloudflare Pages origins (plus localhost development), limits each room to 48 active players, and validates the browser protocol version. Additional players should be distributed into additional room IDs rather than raising this limit without load testing.

### Arcade instances

`assets/rooms/registry.json` defines eight approved instances with a capacity of 48 players each, for a current configured ceiling of 384 concurrent room occupants. Players choose an instance alongside their name and avatar; the selection is remembered locally. Friends must choose the same named instance to share players, chat, cabinet occupancy, world state, and announcements. If a selected Cloudflare room fills between selection and connection, the native realtime client rolls forward through the approved instances and stops with a clear error if all eight are full.

Room IDs are validated against the same registry by both production architectures. Cloudflare maps every ID to a separate Durable Object. The Node fallback creates matching isolated `Room` objects. Adding an instance requires one unique `main-N` registry entry and a redeploy; do not accept arbitrary client-created room IDs.

One room deliberately maps to one authority to prevent cabinet races. A very large worldwide audience should be split into multiple geographically named rooms in a future room-selection phase; a single shared room cannot offer local-region latency to every continent while remaining strongly authoritative.

## Start the multiplayer arcade

1. Close any existing PowerShell arcade server window.
2. Double-click `start-arcade.bat`.
3. Open `http://127.0.0.1:8080/` in two browser windows.

Each browser joins the default arcade room, renders the other players' approved avatars, and receives the authoritative cabinet-occupancy snapshot. ROMs, saves, emulator input, video, and audio remain local to the browser using a cabinet.

## Arcade layout and emulator cores

The main arcade has two facing cabinet rows, a solid paneled prize-counter wall, and two accessible expansion rooms behind the PlayStation and Nintendo 64 partitions. The PlayStation row contains:

- **Tony Hawk's Pro Skater 2** (`pixel-rally`)
- **Gex: Enter the Gecko** (`gex-enter-the-gecko`)
- **Crash Bandicoot** (`crash-bandicoot`)
- **Spyro - Year of the Dragon** (`dungeon-88`)
- **Twisted Metal World Tour** (`turbo-grid`)

The opposite wall contains five stable Nintendo 64 cabinets (`n64-cabinet-01` through `n64-cabinet-05`). Behind each platform wall is a second room with five additional stable cabinets (`psx-back-cabinet-01` through `psx-back-cabinet-05` and `n64-back-cabinet-01` through `n64-back-cabinet-05`). These ten expansion cabinets intentionally have no hosted games yet, but they already participate in server-authoritative occupancy and accept locally selected compatible game files. Nintendo 64 cabinets use EmulatorJS's browser-compatible `n64` core and accept `.z64`, `.n64`, and `.v64` files. The supplied Gopher64 Windows executable is a native desktop application and cannot run inside a web page, so it is not shipped or launched by the site.

Tony Hawk's Pro Skater 2 is configured as a hosted local development image at `assets/games/tony-hawks-pro-skater-2.bin`. Spyro is hosted as a verified single-track CHD at `assets/games/spyro-year-of-the-dragon.chd`, and Twisted Metal is hosted as a verified 12-track CHD at `assets/games/twisted-metal-world-tour.chd`. Place only legally owned, browser-ready images in `assets/games/`; game and BIOS files are ignored by source control.

## Multiplayer architecture

- **PlayerManager** is the authoritative source for player movement, spawn points, reconnect grace, room membership, and lifecycle events.
- **RoomManager** currently provides one configurable `main` room, with a clear seam for adding more rooms later.
- The browser predicts its own movement instantly, sends compact position updates only when it changes, and gently corrects to the server-approved state.
- Other players are rendered from a short interpolation buffer, making their movement smooth despite network timing differences.
- A brief connection interruption keeps a player available for ten seconds; after that, the server cleans it up.

## Social presence (Phase 5)

Phase 5 keeps social behavior outside the movement and cabinet systems:

- **ChatManager** owns sanitized room-local chat history, system/announcement messages, the 180-character limit, and spam protection (four messages per six seconds, with at least 550 ms between messages).
- **StatusManager** owns activity timestamps and changes inactive players to `away` after 120 seconds. Keyboard, pointer, movement, chat, and reactions restore presence immediately.
- **PresenceManager** calculates proximity tiers. Nearby players receive normal movement updates; far-away moving players are reduced to at most one update every 300 ms, while idle and cabinet-state transitions are always delivered.
- **ReactionManager** validates approved quick reactions. Reactions are nearby-only, short-lived, and rate limited.

Socket handlers remain transport adapters. They derive player and room identity from the connected socket and delegate validation and state changes to these managers. Chat is held in bounded memory only; it is not global and is not persisted.

The client UI shows room population, room name, latency/connection quality, player avatar/name/status, fading chat, inspection details, quick reactions, and a temporary player-follow camera. Click a visible remote avatar to inspect it. Follow mode affects only the local camera and never streams cabinet gameplay.

Social configuration environment variables:

- `AFK_TIMEOUT_MS` (default `120000`)
- `CHAT_MAX_LENGTH` (default `180`)
- `REACTION_COOLDOWN_MS` (default `550`)
- `PRESENCE_NEARBY_DISTANCE` (default `12` world units)
- `PRESENCE_SOCIAL_DISTANCE` (default `15` world units)
- `PRESENCE_FAR_UPDATE_INTERVAL_MS` (default `300`)

Social event contract:

- Client requests: `chat:send`, `reaction:send`, `presence:activity`, `social:ping`
- Server state/events: `player:status`, `chat:snapshot`, `chat:message`, `reaction:shown`

Messages are normalized and stripped of control/angle-bracket characters by the server, then rendered with DOM `textContent`. Late joiners receive the last 40 room messages. Join and final-leave messages are generated by authoritative player lifecycle events; a temporary connection interruption therefore does not falsely announce a departure.

## Living world (Phase 6)

Phase 6 is configuration-driven through `assets/world/config.json`. `WorldManager` composes independent client systems and applies the server-owned room state without taking ownership of movement, cabinets, avatars, or emulation.

- **WorldManager** coordinates snapshots, room activity, announcements, events, themes, weather, the update loop, and the other world managers.
- **AudioManager** owns one shared Web Audio context, ambience/effects buses, cached procedural noise, positional cabinet/air-conditioning hums, activity-scaled crowd ambience, and short interface/announcement cues. Background music and avatar walking sounds are intentionally disabled. Browser audio unlocks only after a user gesture.
- **LightingManager** discovers existing scene lights and emissive materials once, preserves their base values, and smoothly adjusts brightness for quiet, active, and busy rooms. It also supports flicker, neon surges, animated emissive accents, and future palette control.
- **NPCManager** remains available as a future-facing ambient-character framework, but the live arcade currently spawns no wandering NPCs.
- **ParticleManager** pools typed position/velocity buffers for dust, snow, sparks, neon bursts, and future effects. Emitters stop updating outside their configured camera distance.
- **EnvironmentManager** creates interior window displays, applies configuration-defined theme/fog/window colors, and switches pooled snow, sunset dust, and fog-style effects without affecting collision or gameplay. The former N64-wall rain particle field has been removed for performance.
- **ObjectInteractionManager** detects nearby non-cabinet objects independently from cabinet ownership. The prize counter remains registered for future interaction. The jukebox, placeholder vending machine, and information kiosk were removed to keep the arcade floor and soundscape uncluttered.

Room-specific world state contains `themeId`, `weatherId`, `activityLevel`, population, and revision. The server validates theme and weather IDs against the registry. `WorldManager.setTheme()` and `setWeather()` are server-side expansion APIs for future schedules/admin controls. State is persistent for the lifetime of the server process but intentionally is not stored in a database.

### Themes, weather, NPCs, and objects

- Add a theme under `themes` with fog, ambient, ground, neon palette, and brightness values.
- Add weather under `weather` and map it to an existing pooled particle type (`snow`, `dust`, or `fog`), or use `null` for color-only weather.
- Ambient NPC spawning is disabled (`npcPaths` is empty). Future paths can use `[x, y, z]` points and world-units-per-second speeds.
- Add non-cabinet interactables under `objects` with a stable ID, type, position, and interaction distance. Implement behavior in the `WorldManager.interact()` boundary rather than inside `arcade.js`.

World wire events are `world:snapshot`, `world:state-changed`, `world:announcement`, and `world:event`. `WORLD_EVENT_INTERVAL_MS` defaults to `90000`.

Known limitations: world state resets on server restart; procedural crowd noise is abstract rather than recorded speech; NPCs are simple primitives; weather appears through dedicated interior display windows rather than a modeled exterior; and no admin theme/event UI exists. These are intentional seams for later phases, not blockers for the current environment.

## Multiplayer cabinets

`CabinetManager` owns room-specific reservations and occupancy. The browser detects a nearby cabinet locally, but it must request control from the server. The server derives the player and room from the socket, validates the stable cabinet ID and authoritative player position, then atomically grants or denies the request.

The lifecycle is `available -> reserved -> in-use -> available`:

1. `cabinet:request-use` reserves an available nearby cabinet and returns its approved player alignment.
2. The browser opens the existing local cabinet interface and sends `cabinet:activate`.
3. `cabinet:release` is sent when the interface or emulator closes.
4. A reservation that is not activated is released after five seconds.
5. A disconnect preserves ownership during the existing ten-second reconnect grace. Expired players release their cabinet automatically. A reconnect restores ownership but deliberately does not reopen the emulator; press **E** at the cabinet to resume its local interface.

Late joiners receive `cabinet:snapshot`; later changes arrive through `cabinet:state-changed`. A server-forced timeout uses `cabinet:forced-release`. Releases are idempotent, and each room owns an independent copy of the live cabinet state.

The approved registry is `assets/cabinets/registry.json`. It is the single source consumed by both browser and server. Every entry requires a stable lowercase dash-separated `id`, unique `sceneKey`, interaction point, player alignment point, facing rotation, and enabled status. To add a cabinet:

1. Create the Three.js cabinet in `arcade.js` using the exact registry `id`.
2. Add one registry entry; never generate the ID at runtime.
3. Place `interactionPosition` in front of the controls and `playerPosition` where the avatar should stand.
4. Set `playerRotationY` toward the cabinet and restart the Node server so it reloads the approved registry.

Configuration is available through `CABINET_INTERACTION_DISTANCE` (default `2.6` world units), `CABINET_ACTIVATION_TIMEOUT_MS` (default `5000`), and `CABINET_REQUEST_COOLDOWN_MS` (default `250`). Socket handlers only validate wire shape and delegate to `CabinetManager`; no ROM bytes, local file paths, emulator frames, audio, or controller input enter the multiplayer protocol.

Failure handling closes and releases the local session on iframe load failure, a 20-second emulator loader timeout, explicit exit, server-forced release, or server disconnect. Browser object URLs created for locally selected game and BIOS files are revoked on exit.

## Avatars

Before joining the room, each browser selects a display name and an approved avatar. The server accepts only names made of 2–18 ASCII letters, numbers, spaces, periods, dashes, or underscores. It trims and normalizes the name before sending it to other players. An unknown avatar ID is safely replaced with the `neon-capsule` fallback.

The approved registry lives in `assets/avatars/registry.json`. Each entry contains only local, site-controlled asset paths plus its scale, vertical offset, facing adjustment, and logical animation clip mappings. Model URLs are never sent over Socket.IO—only the avatar ID is networked.

### Add an approved avatar

1. Put its optimized `.glb` file in `assets/avatars/models/` and a small icon in `assets/avatars/thumbnails/`. The selector itself is deliberately text-only; the icon is retained for the compact multiplayer player list.
2. Add an enabled entry to `assets/avatars/registry.json`. Use a lowercase, dash-separated unique ID.
3. Set `scale`, `heightOffset`, and `rotationOffset` so the model rests on the floor and faces forward.
4. Map the model's actual clip names to logical states: `idle`, `walk`, and optionally `run` and `interact`.
5. Restart the Node server, then test the selection screen in two browser windows.

The neon capsule is the reliable fallback avatar. Extreme Gundam is the current animated example: it uses its built-in `Idle` clip and an in-place walk cycle generated from its intact arm and leg bones. New production avatars should ideally include separate looping idle and walk clips. The renderer uses `SkeletonUtils.clone` for each remote player, so skinned character rigs do not share mutable skeleton state.

Avatar GLBs should be reasonably small, use compressed textures where possible, avoid unnecessary high-resolution maps, and avoid dynamic shadows by default. The supplied animated Pepe asset is roughly 34 MB, so it is cached and loaded lazily; a neon capsule remains visible while it loads or if it fails. Avatar models, nameplates, and animation mixers are removed when a player leaves, while successfully fetched source assets remain cached for later players.

## Controls

- **WASD** — walk
- **Mouse** — look around
- **E** — use a cabinet when the prompt appears
- **Escape / close button** — leave a cabinet and release it for other players
- **Enter** — open room chat; Enter sends and Escape closes it
- **Click another avatar** — inspect that player and optionally follow them
- **Reaction toolbar** — send a nearby quick reaction
- **Choose ROM file** — initialize the cabinet game deck
- **Arrow keys / Space** — play the built-in CRT session

The ROM chooser deliberately accepts commonly used formats but does not ship an emulator core or games. That keeps the project legal and platform-agnostic. To play an owned ROM through a real emulator, replace the `game()` renderer in `arcade.js` with the initialization code for the emulator core you have licensed/chosen (for example a browser-supported MAME, NES, or Game Boy core), passing it the selected `File` object from the `rom-file` change listener.

## Crash Bandicoot cabinet

The cabinet labeled **Crash Bandicoot** is configured for PlayStation. Open it, select a PlayStation BIOS you have dumped from your own console, then select a legally dumped compatible game image (for example `.bin`, `.cue`, `.iso`, `.chd`, or `.pbp`). The site loads the image locally in the browser through EmulatorJS; it does not include or download game or BIOS files.

## Nintendo 64 cabinets

All N64 cabinets use EmulatorJS's `n64` target, which selects the Mupen64Plus Next browser core. Approach a cabinet, obtain multiplayer ownership, and choose a legally dumped `.z64`, `.n64`, or `.v64` image. N64 does not require the PlayStation BIOS. The ROM, emulator video, audio, controller input, browser saves, and save states remain local to the player's browser.

Hosted game metadata is centralized in `assets/games/registry.json`. To add a legally distributable title, upload its image to the configured R2 games prefix, add one enabled registry entry with a unique game ID, cabinet ID, system, filename, numeric emulator ID, and byte size, and set that cabinet's `defaultGameId` in `assets/cabinets/registry.json`. `games/game-registry.js` validates the browser copy before the scene starts. ROM and BIOS binaries remain ignored by Git and excluded from the Pages bundle.

The hosted N64 wall contains Pokémon Snap (`n64-cabinet-01`), Super Mario 64 (`n64-cabinet-02`), Glover (`n64-cabinet-03`), Doom 64 (`n64-cabinet-04`), and The Legend of Zelda: Ocarina of Time (`n64-cabinet-05`).

The rear N64 room currently contains Star Fox 64 (`n64-back-cabinet-01`), Mega Man 64 (`n64-back-cabinet-02`), and a second Super Mario 64 cabinet (`n64-back-cabinet-03`). Its remaining two cabinets are reserved for future N64 games.

## PlayStation 2 room

The five cabinets behind the PlayStation room are presented as the **PS2 ROOM**. God of War and Kingdom Hearts are assigned visually to the first two cabinets, with three future PS2 slots. PCSX2 2.6.3 remains unsuitable because its Windows installer cannot execute in a webpage and EmulatorJS does not provide a PlayStation 2 core. The PCSX2 installer and PS2 ISO images are therefore neither copied into the website nor uploaded to R2.

### Experimental PS2 prototype

The Kingdom Hearts cabinet is enabled as an isolated local-file prototype using the official experimental Play!.js WebAssembly build. It accepts legally dumped ISO, CSO, CHD, ISZ, BIN, and ELF files and requires no external BIOS. The selected file remains local to the visitor's browser and is passed directly to the emulator without being uploaded. Kingdom Hearts was verified to boot at approximately 53 FPS on the development PC. The 8.5 GB God of War image remained at 0 FPS in the same browser test, so that cabinet and the other three PS2 slots remain disabled pending compatibility work. The runtime snapshot and upstream license live under `emulators/play/`; PS1 and N64 continue to use the unchanged EmulatorJS player.
