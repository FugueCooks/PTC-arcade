# Phase 7 scalable multiplayer architecture

## Runtime topology

Cloudflare Pages and R2 continue to serve the browser, models, emulator code, and approved game assets. The scaled realtime path is a set of Node.js/Socket.IO game servers connected to one trusted Redis deployment. Redis Streams forwards cross-process Socket.IO broadcasts and resumes after temporary Redis interruptions. Redis coordination keys provide server discovery, room discovery, admission reservations, and exclusive room-owner leases.

Each active room has exactly one owning game-server process. Its player, movement, cabinet, chat, presence, reaction, jukebox, and world simulation remains in process. Redis contains routing and short-lived coordination records, never ROM bytes, emulator frames, controller input, or game audio/video.

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

## Deployment state

Redis activates only when `REDIS_URL` is configured. `REDIS_REQUIRED=1` makes readiness fail whenever Redis is unavailable. Local development without Redis retains the in-memory directory and the existing single-process Socket.IO adapter. The production Cloudflare Durable Object backend remains the rollback path until the Node/Redis route reaches complete protocol parity and passes load testing.
