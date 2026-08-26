# Phase 11 — Repository Inspection and Staged Migration Plan

Status: **inspection complete; operator decisions recorded in §0; implementation underway.**

This document satisfies steps 1–15 of the Phase 11 implementation process. It records
the systems that exist today, the coupling Phase 11 must break, the systems the Phase 11
brief assumes but which are **not present in this repository**, the full list of proposed
file changes, and the staged milestone plan.

No production code has been changed. Baseline at time of inspection: **115/115 tests pass**
(`npm test`), working tree clean at `d5217ee`.

---

## 0. Operator decisions

The inspection below was presented before implementation. The operator made three calls:

1. **Replay and ghost systems are deferred to Phase 12.** Stage E (Milestones 11.17–11.24) is
   not implemented in Phase 11. The §2 gap analysis stands as the reason. Phase 11 therefore
   delivers cabinet/emulator decoupling, plugins, cabinet scale, operations, and the versioned
   API — a coherent subset that does not depend on the missing competitive layer.
2. **Run all remaining stages** (A, B, C, D, F, G), committing each separately as it goes green.
3. **Storage uses a filesystem-backed adapter behind an interface.** With replay deferred this
   applies to plugin-scoped storage and any later payload store, so the eventual R2
   implementation is a swap with no call-site changes.

Milestone coverage in Phase 11 is therefore 11.1–11.16 and 11.25–11.40, with 11.17–11.24
carried to Phase 12.

---

## 1. Current architecture

### 1.1 Topology

Single Node process (`server/src/index.ts`, 504 lines) serving:

- Express HTTP: auth, account, matchmaking, operational, static hosting
- Socket.IO realtime, optionally backed by the Redis streams adapter for multi-process
- PostgreSQL via Drizzle (identity only)
- Redis for room directory, ownership fencing, reconnect, identity presence, wallet challenges

Static browser client is served from the same origin: `arcade.js` (1113 dense lines,
125 KB) plus ES modules in `cabinets/`, `games/`, `rooms/`, `world/`, `social/`,
`avatars/`, `realtime/`, `wallet/`.

Deployment targets, all Docker on the same image: Fly (`fly.toml`, lax, 2 shared vCPU /
1 GB, `/ready` health check), DigitalOcean App Platform (`.do/app.yaml`, sfo), Render
(`render.yaml`, oregon). *Since this inspection, Render has been removed and Fly is the
sole target for `ptcarcade.fun`; see `docs/deployment-ptcarcade-fun.md`.* Game and BIOS binaries are served from Cloudflare R2 via
`GAME_ASSET_BASE_URL`. Cloudflare Pages/Worker configs exist under `cloudflare/`.

### 1.2 Cabinet architecture

Static definitions live in one JSON file, `assets/cabinets/registry.json`, **39 cabinets**,
loaded by both sides:

- Server: `server/src/cabinets/cabinet-registry.ts` reads it synchronously at module load
  via `readFileSync`, validates, freezes, exports a module-level `CABINET_REGISTRY` const.
- Client: `cabinets/cabinet-registry.js` fetches the same file and returns a `Map`.

`CabinetDefinition` today is: `id, name, sceneKey, enabled, interactionPosition,
playerPosition, playerRotationY, defaultGameId?, system?, emulatorId?`.

Live state is `server/src/cabinets/cabinet-manager.ts`. This is the **strongest part of the
existing design** and should largely survive: static definitions and per-room occupancy are
already separated (`roomStates: Map<roomId, Map<cabinetId, CabinetState>>`), the
reserve→activate→release handshake is synchronous with no async gap between check and set,
and ownership conflicts, cooldowns, activation timeouts, and disconnect sweeps are handled.

### 1.3 Cabinet → emulator coupling (the core problem)

In `arcade.js` a "cabinet" is a Three.js group with game metadata assigned onto it:

- `makeCabinet(id,name,x,z,hue,isCrash,isGex,system)` (line 467) builds geometry and pushes
  onto a flat `cabinets[]` array.
- `configureHostedCabinet(cabinetId)` (line 557) reads the game registry and `Object.assign`s
  `artSlug, system, gameName, gameId, gameRegistryId, gameFileName, gameSizeBytes,
  hostedGame, hostedDiscs` **directly onto the Three.js-bearing cabinet object**.
- `launchEmulator(gameFile, options)` (line 935) selects the core with inline ternaries on
  `activeCabinet.system`, builds the iframe URL per backend, and owns per-backend
  `postMessage` handshakes inline (line 1014).

Three emulator backends are reached three different ways:

| Backend | Systems | Delivery | Handshake |
|---|---|---|---|
| EmulatorJS | psx, n64, snes | CDN loader in `player.html` iframe | query string `?core=&game=&bios=&name=&id=` |
| Play! | ps2 | local wasm, `emulators/play/index.html` | `arcade:ps2-load-file` / `arcade:ps2-load-remote` |
| Gecko | gamecube | local wasm, `emulators/gecko/index.html` | `arcade:gamecube-load-*`, DSP ROM URL |

Direct dependencies to break (inspection step 11): `configureHostedCabinet`,
`launchEmulator`, `stopEmulator`, `closeMachine`, `openMachine`'s per-system copy
(lines 854–872), `warmEmulatorCore`/`emulatorWarmTargets`, the `message` listener at
line 1014, and the `['psx','n64','snes','ps2','gamecube'].includes(...)` system tests at
lines 895 and 1013.

### 1.4 Game registry

`assets/games/registry.json` — version 1, **29 games**, validated by `games/game-registry.js`.
Fields: `id, cabinetId, name, system, file, emulatorId, sizeBytes, enabled, discs?`.

Two structural problems for Phase 11:

1. **The index is inverted.** It is keyed `byCabinetId`, so the game points at the cabinet.
   Milestone 11.2 requires the cabinet to reference a game ID.
2. `emulatorId` is a *numeric EmulatorJS content id*, not an adapter identity. The real
   adapter selection happens implicitly through `system`.

`games/ps2-game-cache.js` provides IndexedDB/OPFS caching for large images, currently gated
to `CACHEABLE_SYSTEMS`.

### 1.5 Systems that assume a small fixed cabinet count (inspection step 12)

- `CabinetManager.statesFor()` eagerly materializes a `CabinetState` for **every cabinet in
  the registry** the first time a room is touched — 39 today, 10,000 later.
- `snapshot(roomId)` returns **all** cabinet states; `cabinet:snapshot` sends the whole array
  on every room join, with no zone scoping, revision, or delta.
- `releaseForPlayer()` does a full `[...states.values()].find(...)` linear scan.
- `arcade.js tick()` runs `cabinets.forEach(...)` with a `distanceTo` **every frame** to find
  the nearest cabinet.
- `setCabinetState` / `beginCabinetSession` use `cabinets.find(...)` — O(n) per call.
- All 39 cabinet meshes are built eagerly at scene construction; there is no zone streaming
  and no lazy scene-object creation.
- `CABINET_REGISTRY` is a module-level `readFileSync` singleton — no database source, no
  refresh, no zone grouping, no secondary indexes.

### 1.6 Code that cannot be extended without editing core files (inspection step 13)

There is no extension mechanism anywhere. Adding a cabinet type, an interaction, a UI panel,
a route, or a socket event requires editing `arcade.js`, `server/src/index.ts`, or
`server/src/protocol.ts`. `protocol.ts` is a closed union of literal event names, so
`ClientToServerEvents`/`ServerToClientEvents` must be edited for any new event. This is the
gap Milestones 11.7–11.12 close.

### 1.7 Routes, socket events, database, Redis, observability

**HTTP** (all under `/api`, unversioned): `/api/auth/{register,login,guest,session,
realtime-ticket,logout}`, `/api/auth/wallet/{challenge,verify}`, `/api/account/{profile,
preferences,sessions,sessions/:id,sessions/revoke-others}`, `/api/rooms`,
`/api/rooms/quick-join`, `/health`, `/healthz`, `/ready`, `/metrics`, `/runtime-config.js`.

**Socket events** (30): `room:{join,snapshot,resume,error}`, `player:{move,moved,state,
status,left,disconnected}`, `cabinet:{request-use,activate,release,snapshot,state-changed,
forced-release}`, `chat:{send,message,snapshot}`, `reaction:{send,shown}`,
`presence:activity`, `social:ping`, `world:{snapshot,state-changed,event,announcement}`,
`server:draining`.

**PostgreSQL** (`server/src/database/schema.ts`): `users`, `wallet_identities`,
`guest_identities`, `user_preferences`, `sessions`, `password_reset_tokens`,
`email_verification_tokens`, `security_audit_events`. Identity only — no gameplay tables.

**Redis** (`server/src/redis/redis-keys.ts`, single `prefix`): servers, server-heartbeats,
rooms, room-directory, server-rooms, room-owner, room-fence, room-members,
room-reservations, reconnect, socket-stream, socket-session, active-identity,
identity-presence, wallet-challenges, wallet-auth-rate-limit, wallet-account-lock.

**Observability**: `RuntimeMetrics` renders Prometheus text with process, socket, room,
transport, and event-loop-delay metrics. `HealthService.readiness()` gates on initializing,
draining, critical failure, Redis, database, connection/player/room capacity, RSS, and event
loop delay. `createLogger` emits structured JSON. `DrainController` handles SIGTERM/SIGINT.

Config is `server/src/config.ts` — 54 typed, bounded environment variables.

---

## 2. Gap analysis — Phase 11 assumes systems that do not exist

This is the most important finding, and it changes the shape of six milestones.

The brief instructs me to inspect and preserve the existing "competitive-entry, leaderboard"
systems, and several milestones build on them. **None of these exist in this repository:**

| Assumed by the brief | Reality |
|---|---|
| Competitive entry / burn flow | Absent. No burn, token, price-provider, or RPC code. |
| Leaderboards | Absent. No table, route, socket event, or client code. |
| Competitive attempts / `attemptId` | Absent. No attempt concept. |
| Replay system | Absent. Nothing to migrate. |
| Object storage for payloads | Only R2 **read** of game assets; no upload path from the app. |
| Operator role | Absent. Roles are `users.status` only; no operator boundary. |
| Score capture | Absent. No emulator score extraction of any kind. |

`docs/phase-9-wallet-authentication.md` states the intended Phase 10 scope was "profile/presence
polish … **not** payments, token gating, or emulator score claims", and the commits since then
(Mega Man room, avatars, mobile controls, hosted games) are consistent with that. So the
competitive layer was deliberately never built.

Phase 11 also forbids adding it: *"Do not add new monetization, token mechanics, progression …"*
and lists wagering, prizes, and payment mechanics under "do not implement".

**Resolution I propose, and will follow unless redirected:** build the replay, ghost, and
operations systems as *self-contained* subsystems, and express every competitive/leaderboard
touchpoint as a **declared seam** — the capability enums, the `competitiveAttemptId?` optional
field, the `ReplayVerificationStatus` union, and a `LeaderboardPort` interface with no
implementation behind it. That satisfies 11.17, 11.21, 11.24 structurally without inventing a
monetization system Phase 11 explicitly bans. Milestone 11.24 is therefore delivered as
*interface plus tests against a fake*, and the Phase 11 success criterion "existing competitive
systems remain stable" is vacuously met, which I will state plainly rather than imply coverage
that does not exist.

Two smaller mismatches, handled the same way:

- **Score extraction.** No adapter can extract a score today, so `EmulatorCapabilities.scoreExtraction`
  will be `false` everywhere in 11.5 and `ReplayCapability` for all 29 games will be `NONE` or
  `INPUT_LOG`. Per 11.4 and 11.20 I will not claim a capability that is not provided. Milestone
  11.20's determinism harness will be built and tested against a deterministic **fixture** adapter,
  not against EmulatorJS/Play!/Gecko, none of which offer deterministic replay through their
  current iframe boundary.
- **Ghost system (11.23).** With no score, position, or checkpoint data crossing the iframe
  boundary, only the abstraction and an isolation guarantee can be delivered. I will build
  `GhostSession` with a null/progress ghost and no live consumer.

---

## 3. Files proposed for creation and modification (inspection step 14)

### 3.1 New — server

```
server/src/domain/cabinet-definition.ts        CabinetDefinition, zone, policy, screen config
server/src/domain/game-definition.ts           GameDefinition, asset requirements
server/src/domain/game-session.ts              GameSession model + validated transitions
server/src/domain/ids.ts                       branded id types
server/src/cabinets/cabinet-index.ts           by-id / by-zone / by-game / by-type indexes
server/src/cabinets/cabinet-spatial-index.ts   2D uniform grid over interactionPosition
server/src/cabinets/cabinet-delta-publisher.ts snapshot + revision + delta, resync
server/src/cabinets/zone-registry.ts           zone bounds, adjacency, preload distance
server/src/games/game-registry-service.ts      centralized GameRegistry
server/src/games/game-launcher-service.ts      GameLauncher orchestration
server/src/emulators/emulator-adapter.ts       adapter interface + capabilities
server/src/emulators/emulator-adapter-registry.ts
server/src/sessions/game-session-service.ts    lifecycle, idempotent stop/dispose
server/src/plugins/plugin-manifest.ts          manifest schema + validation
server/src/plugins/plugin-host.ts              discovery, lifecycle, failure isolation
server/src/plugins/plugin-context.ts           the only surface plugins may touch
server/src/plugins/plugin-permissions.ts       permission enum + enforcement
server/src/plugins/plugin-storage.ts           namespaced Redis/PG storage + quotas
server/src/replays/replay-format.ts            versioned format + checksum
server/src/replays/input-recorder.ts           logical control events
server/src/replays/replay-service.ts           metadata, storage, retention
server/src/replays/replay-verifier.ts          determinism comparison + divergence
server/src/replays/ghost-session.ts            isolated ghost abstraction
server/src/replays/leaderboard-port.ts         declared seam, no implementation
server/src/operations/operations-service.ts    status aggregation
server/src/operations/operations-actions.ts    scoped, idempotent, audited actions
server/src/operations/operator-auth.ts         separate authorization boundary
server/src/operations/audit-log.ts             audit record writer
server/src/http/api/v1/*.ts                    versioned routers per domain
server/src/http/api/dto/*.ts                   request/response DTOs + validation
server/src/http/api/middleware/*.ts            request id, idempotency, pagination, errors
server/src/events/event-bus.ts                 typed internal bus
server/src/jobs/job-queue.ts                   durable queue, retry/backoff, DLQ
server/src/jobs/processors/*.ts                replay compression/verification/cleanup
plugins/example-info-kiosk/*                   first-party example plugin (11.12)
```

### 3.2 New — client

```
client/api/api-client.js                       typed client, one base URL, cancellation
cabinets/cabinet-scene-factory.js              lazy Three.js object creation
cabinets/cabinet-spatial-index.js              client-side nearby lookup
cabinets/zone-streamer.js                      preload / activate / unload
emulators/adapters/emulatorjs-adapter.js       thin wrapper, existing behavior
emulators/adapters/play-ps2-adapter.js
emulators/adapters/gecko-gamecube-adapter.js
emulators/emulator-adapter-registry.js
games/game-launcher.js                         client half of the launcher
ops-dashboard/*                                separate authenticated dashboard
```

### 3.3 Modified

```
arcade.js                       remove inline emulator selection; delegate to launcher;
                                replace per-frame scan with spatial index; lazy scene objects
server/src/index.ts             delegate socket handlers to services; mount v1 API
server/src/protocol.ts          versioned protocol; cabinet delta events
server/src/cabinets/cabinet-registry.ts   zone grouping, indexes, non-eager load
server/src/cabinets/cabinet-manager.ts    lazy per-room state; no full scans; deltas
server/src/database/schema.ts   replay_records, operations_audit, plugin_storage, operators
server/src/redis/redis-keys.ts  arcade:plugin:{id}:*, replay job keys, zone keys
server/src/config.ts            new bounded env vars
server/src/metrics/metrics.ts   Milestone 11.37 metrics
server/src/health/health-service.ts  plugin + queue health
assets/cabinets/registry.json   add zoneId, gameId, cabinetType
assets/games/registry.json      v2: launcher/emulator adapter ids, replay capability
drizzle/*                       new migrations
```

Roughly 45 new files and 14 modified. `arcade.js` carries the highest regression risk: it is
one 125 KB file with very long lines, no module boundaries, and no direct test coverage.

---

## 4. Staged migration plan

Six implemented stages (E is deferred). Each stage ends green (`npm run lint && npm run typecheck && npm test`) and is
committed separately. No stage begins before the previous one is green.

**Stage A — domain model, no behavior change (11.1, 11.2, 11.6)**
Introduce `CabinetDefinition`, `GameDefinition`, `GameSession` types and the centralized
`GameRegistry` alongside the existing registries. Invert the game index to cabinet→gameId
while keeping `byCabinetId` as a compatibility view. Registry JSON gains `zoneId`,
`cabinetType`, `gameId`; all 39 existing cabinet IDs stay byte-identical (11.39). Nothing is
removed. *Exit: existing tests untouched and passing, new type-level tests added.*

**Stage B — emulator adapters (11.3, 11.4, 11.5)**
Define the adapter interface, then wrap the three existing backends as thin compatibility
layers — EmulatorJS, Play!, Gecko — preserving ROM loading, controls, audio, entry/exit,
local-only execution, and browser support. Route `launchEmulator` through `GameLauncher` so
`arcade.js` stops selecting cores. Capabilities are declared honestly: no save states, no
deterministic replay, no score extraction. *Exit: every cabinet launches exactly as before;
compatibility tests added; no emulator rewritten.*

**Stage C — cabinet scale (11.13, 11.14, 11.15, 11.16)**
Indexes by id/zone/game/type; a 2D uniform grid spatial index (documented cell size and
complexity); lazy per-room state; snapshot + revision + delta with resync on missed
sequence; zone streaming with a guard against unloading an in-use cabinet. Replace the
per-frame `cabinets.forEach` scan. *Exit: benchmarks at 1k/5k/10k definitions, measured and
recorded — no cabinet count claimed without a measurement.*

**Stage D — plugin architecture (11.7–11.12)**
Manifest, validation, lifecycle, permissions, namespaced storage with quotas, and the
first-party info-kiosk example. Operator-installed only; no dynamic remote code; no plugin
access to DB clients, Redis, filesystem, cookies, wallet signatures, secrets, or ROM files.
Noncritical plugin failure is contained and reported. *Exit: the 9 plugin tests from 11.40.*

**Stage E — replay and ghost (11.17–11.24) — DEFERRED TO PHASE 12**
Not implemented, per the operator decision in §0. The §2 gap analysis is the reason: with no
competitive layer, no score extraction, and three opaque emulator iframes, replay would be
interface-only. Tests 26–35 of Milestone 11.40 are out of scope for Phase 11 and are recorded
as such rather than reported as passing.

**Stage F — operations (11.25–11.29)**
Operations API, separately authenticated dashboard, scoped idempotent actions with dry-run,
and the audit log. Server-side authorization only; a connected player wallet grants nothing.
No shell, no SQL console, no Redis console. *Exit: the 6 operations tests from 11.40.*

**Stage G — API, services, events, jobs, observability (11.30–11.37)**
Versioned `/api/v1` with DTOs and validation, typed client, service boundaries, typed event
bus, background jobs with retry/backoff/DLQ, and the 11.37 metrics. Existing unversioned
routes stay mounted as compatibility aliases until the client migration is verified.
*Exit: the 9 API tests, plus the 10 regression tests from 11.40.*

Stage E is skipped. Then the security review (11.38) and the 36 documentation deliverables.

**Sequencing rationale:** A and B are prerequisites for everything. C is independent of D–F
and could run in parallel, but touches `arcade.js` heavily, so it is kept serial to keep the
blast radius readable. G is last because it should describe the finished shape rather than be
rewritten by each preceding stage.

---

## 5. Risks

1. **`arcade.js` has no test coverage** and is the file most changed. Stages B and C need
   manual in-browser verification per cabinet system; the pre-existing test suite will not
   catch a regression there.
2. **Three emulator iframes are opaque.** Determinism, score extraction, and true ghost
   support cannot be delivered through the current boundary. Declared honestly, not faked.
3. **Object storage has no upload path.** Resolved for Phase 11 by §0.3: storage sits behind
   an interface with a filesystem adapter. No R2 write credentials are needed this phase.
4. **Scope.** This is 40 milestones against a 4.5 KLOC server and a monolithic client. The
   staged plan exists so the work is reviewable at six points rather than one.

---

## 6. Resolved questions

1. Competitive/replay gap — resolved by §0.1: deferred to Phase 12.
2. Object storage — resolved by §0.3: filesystem adapter behind an interface.
3. Operator identity — resolved during Stage F: a separate operator credential store with its
   own session boundary, rather than a role on player accounts. A connected player wallet
   grants no operations access under either design, but a separate store makes that
   structural rather than a check that could be forgotten.
