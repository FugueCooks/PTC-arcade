# Phase 7 scalable multiplayer architecture

## Runtime topology

Cloudflare Pages and R2 continue to serve the browser, models, emulator code, and approved game assets. The scaled realtime path is a set of Node.js/Socket.IO game servers connected to one trusted Redis deployment. Redis Streams forwards cross-process Socket.IO broadcasts and resumes after temporary Redis interruptions. Redis coordination keys provide server discovery, room discovery, admission reservations, and exclusive room-owner leases.

Each active room has exactly one owning game-server process. Its player, movement, cabinet, chat, presence, reaction, jukebox, and world simulation remains in process. Redis contains routing and short-lived coordination records, never ROM bytes, emulator frames, controller input, or game audio/video.

The current public safety envelope is 10 rooms per server, 25 players per room, and 250 active players per server. These are launch guards, not measured capacity claims; they should be lowered if production load tests expose a tighter CPU, memory, or bandwidth limit.

```text
Browser -> CDN/static assets
        -> sticky load balancer -> Node game server A --+
                                -> Node game server B --+-> Redis
                                -> Node game server C --+
```

HTTP polling requires sticky load-balancer sessions even with the Redis Streams adapter. WebSocket-only deployments can remove that dependency after browser and mobile compatibility testing. Redis must use authentication, TLS or private networking, ACLs, and dedicated credentials.

## Room lifecycle

`starting -> available -> full -> available -> draining -> closing -> closed`

An unhealthy owner changes the room to `unhealthy`, which removes it from placement. Room IDs created for coordinated deployments contain a UUID and are globally unique. Seeded fixed IDs remain only for local compatibility. Empty dynamic rooms expire after `ROOM_IDLE_TIMEOUT_SECONDS`; seeded local rooms remain available.

Room records carry server ownership, capacity, population, health, creation and activity timestamps, plus cabinet/world/jukebox revision counters. The active state itself stays in the relevant authoritative manager.

## Ownership and admissions

Room ownership uses `SET NX PX` leases. Every acquisition increments a fencing counter. Lease renewal and release use compare-and-act Lua scripts so a stale server cannot renew or delete a newer owner's lease.

Placement uses short-lived admission reservations. A Lua script atomically counts active members plus non-expired reservations before granting a slot. Confirmation converts the reservation into active membership. Release is idempotent.

## Placement and owner routing

`GET /api/rooms` returns a sanitized browser view containing room names, population, capacity, and status. `POST /api/rooms/quick-join` atomically reserves a slot and returns a short-lived token with the public realtime endpoint of that room's authoritative owner. The browser connects directly to that endpoint, and the owner confirms the token during `room:join`.

Public endpoints come only from `PUBLIC_REALTIME_URL`; private hostnames and server identifiers are not rendered in the interface. A deployment using one load-balanced Socket.IO URL must still provide sticky sessions while HTTP polling is enabled. If `MATCHMAKING_URL` is absent or an older production backend does not expose the API, the client retains the established direct-connection rollback path.

Reconnect routes are stored under a SHA-256 hash of the opaque browser token. Connected-player routes refresh every five seconds; disconnect changes the record TTL to `RECONNECT_GRACE_SECONDS`. Placement prefers the previous room and therefore its owning server. If that room has expired or become unhealthy, ordinary placement selects a safe replacement rather than claiming that live state survived.

## Deployment state

Redis activates only when `REDIS_URL` is configured. `REDIS_REQUIRED=1` makes readiness fail whenever Redis is unavailable. Local development without Redis retains the in-memory directory and the existing single-process Socket.IO adapter. The production Cloudflare Durable Object backend remains the rollback path until the Node/Redis route reaches complete protocol parity and passes load testing.

Runtime Redis reconnects use capped exponential backoff and never permanently close the client. This is required by the Socket.IO Redis Streams reader: permanently closing its client would make stream reads reject immediately and could starve the event loop. During an outage `/health` remains live, `/ready` returns unavailable when Redis is required, new joins stop, and existing process state is retained until coordination recovers.

If Redis restarts and loses ephemeral coordination keys, each room's next ownership refresh obtains a new fencing token before republishing the room as healthy. A room that cannot reacquire its lease remains unhealthy and is excluded from placement, preventing two processes from claiming the same simulation.

Startup waits up to `REDIS_STARTUP_TIMEOUT_SECONDS` (default 5) for coordination. If required Redis is unavailable, the HTTP process still exposes liveness and failed readiness, but it never accepts players through an in-memory multi-process fallback. Restart the process after Redis is restored; runtime outages after a successful bootstrap recover automatically.

The quick-join endpoint uses the same readiness gate as Socket.IO. An unready or draining process returns `503 temporarily-unavailable` without creating an admission reservation, allowing the client waiting-room backoff to retry safely.

## Graceful draining

`SIGTERM` and `SIGINT` mark the process and every owned room as draining, fail readiness immediately, stop new reservations, and broadcast `server:draining` with a deadline. Existing sessions remain connected until the active-player count reaches zero or `SERVER_DRAIN_TIMEOUT_SECONDS` expires. Cleanup removes server registrations and room records, releases leases, closes Redis, then closes Socket.IO and HTTP. Repeated drain signals are idempotent.

## Runtime metrics

`GET /metrics` exposes Prometheus text gauges and counters for sockets, players, rooms, room population, drain state, memory, cumulative process CPU time, event-loop mean/p50/p95/p99/max delay, and approximate Engine.IO transport bytes sent and received. Transport-byte counters measure encoded Engine.IO packet payloads and are intended for trend and regression detection; they are not a substitute for provider-level billable bandwidth metrics. Domain counters cover matchmaking, reconnects, rejected validation, cabinet conflicts, Redis errors, room lifecycle, and shutdown behavior.
