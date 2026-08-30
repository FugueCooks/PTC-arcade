# Socket Protocol (Milestone 11.33)

The multiplayer socket protocol is documented separately from the REST API
because it is a different contract with different guarantees: it is stateful,
room-scoped, and mostly unacknowledged, where the REST API is stateless,
request-scoped, and always acknowledged.

Source of truth for payload shapes: `server/src/protocol.ts`. That file's
`ClientToServerEvents` and `ServerToClientEvents` are closed unions, so an event
not listed there cannot be sent or received.

## Versioning

The socket protocol version is the server's `softwareVersion`, reported by
`GET /api/v1/platform`. Phase 11 adds events without removing any, so an
existing client keeps working (Milestone 11.39): `cabinet:snapshot` and
`cabinet:state-changed` are still emitted alongside the new
`cabinet:zone-snapshot` and `cabinet:delta`.

A client that requires zone streaming should check for `cabinet:zone-snapshot`
on join. If it does not arrive, the server predates Phase 11 and the client must
fall back to the whole-room snapshot rather than assuming an empty world.

## Authentication

A socket authenticates once, at connection, using a short-lived realtime ticket
from `POST /api/auth/realtime-ticket`. Every event below is therefore already
authenticated; none carries credentials of its own, and none should ever be
extended to.

## Client to server

| Event | Payload | Ack | Auth | Rate limit | Room scope | Reliability |
|---|---|---|---|---|---|---|
| `room:join` | `RoomJoinRequest` | no (`room:snapshot` follows) | ticket | once per connection | none → one room | must arrive; failure is `room:error` |
| `player:move` | `PlayerMoveInput` | no | ticket | per-tick, server-clamped | current room | lossy by design; the next update supersedes |
| `cabinet:request-use` | `{ cabinetId }` | `CabinetUseResult` | ticket | 250 ms cooldown per player | current room | must arrive |
| `cabinet:activate` | `{ cabinetId }` | `CabinetUseResult` | ticket | bounded by reservation timeout | current room | must arrive |
| `cabinet:release` | `{ cabinetId }` | `CabinetUseResult` | ticket | none | current room | must arrive |
| `cabinet:resync` | `{ zoneIds }` | `CabinetResyncResult` | ticket | max 16 zones per request | current room | must arrive |
| `chat:send` | `{ text }` | `ChatSendResult` | ticket | server-side limiter | current room | must arrive |
| `reaction:send` | `{ emoji }` | `SocialActionResult` | ticket | server-side limiter | current room | lossy acceptable |
| `presence:activity` | none | no | ticket | coalesced | current room | lossy acceptable |
| `social:ping` | `{ sentAt }` | `{ serverAt }` | ticket | none | none | must arrive |

## Server to client

| Event | Payload | Room scope | Reliability |
|---|---|---|---|
| `room:snapshot` | `RoomSnapshot` | the joining socket | must arrive |
| `room:resume` | `{ resumeToken, resumed }` | the joining socket | must arrive |
| `room:error` | `{ message, code? }` | the offending socket | must arrive |
| `player:state` | `PlayerState` | the owning socket | latest wins |
| `player:joined` / `player:moved` / `player:reconnected` | `PlayerState` | room | latest wins |
| `player:left` / `player:disconnected` | `{ id }` | room | must arrive |
| `player:status` | `{ id, status, at }` | room | latest wins |
| `cabinet:snapshot` | `CabinetSnapshot` | the joining socket | compatibility; superseded by zone snapshot |
| `cabinet:zone-snapshot` | `CabinetZoneSnapshotPayload` | the joining socket | must arrive |
| `cabinet:delta` | `CabinetDeltaPayload` | room | ordered by `revision`; a gap triggers resync |
| `cabinet:state-changed` | `CabinetState` | room | compatibility; superseded by delta |
| `cabinet:forced-release` | `{ cabinetId, reason }` | the owning socket | must arrive |
| `chat:snapshot` / `chat:message` | `ChatMessage` | room | must arrive |
| `reaction:shown` | `ReactionEvent` | room | lossy acceptable |
| `world:snapshot` / `world:state-changed` | `WorldState` | room | latest wins, ordered by `revision` |
| `world:announcement` / `world:event` | announcement / event | room | lossy acceptable |
| `server:draining` | `{ message, deadlineAt, warningMs }` | all sockets | must arrive |

## Cabinet synchronization

The only part of the protocol with an ordering requirement.

1. On join the client receives `cabinet:zone-snapshot` for the zones around its
   spawn, carrying the `revision` the snapshot was taken at.
2. Each later change arrives as `cabinet:delta` with the revision it produces.
3. A client applies a delta only when `delta.revision === clientRevision + 1`.
   A delta at or below the client's revision is a duplicate and is dropped.
   Anything higher means an update was missed.
4. On a gap, the client emits `cabinet:resync` naming the zones it holds and
   replaces its state from the returned snapshot.

Static cabinet metadata — position, type, display name — never travels on this
channel. It comes from the versioned registry (`GET /api/v1/cabinets`), so a
delta carries only the dynamic fields.

Rules in `server/src/cabinets/cabinet-delta-publisher.ts`; exercised by
`test/cabinet-deltas.test.ts`.

## Plugin events

A plugin granted `register:socket-event` receives a namespaced event name of the
form `plugin:{pluginId}:{event}`. The namespace is applied by `PluginContext`,
not supplied by the plugin, so a plugin cannot register or emit a core event
name. Plugin room events are delivered as ordinary world announcements.

## Explicit non-goals

**Replay uploads never travel over the socket.** The brief forbids it, and
nothing in this protocol carries a payload larger than a chat message. Replay is
deferred to Phase 12 in any case; when it arrives it belongs on an HTTP upload
path with size limits and checksums, not here.

**No competitive attempt events exist.** The competitive layer they would
describe does not exist in this repository — see §2 of the Phase 11 inspection.

## Error behaviour

- An event with a malformed payload is rejected through its acknowledgement
  where one exists, and ignored otherwise. It never disconnects the socket.
- `room:error` carries a code for join failures only.
- No acknowledgement ever includes a stack trace or an internal identifier.
- A socket that outlives its ticket is disconnected on the next authenticated
  action rather than being silently downgraded.
