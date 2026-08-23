# Redis key reference

All keys begin with `REDIS_KEY_PREFIX`, normally `arcade:v1:production`. Use a different environment suffix for development, staging, and production.

| Pattern | Purpose | Lifetime |
| --- | --- | --- |
| `:servers:{serverId}` | JSON server registration | `SERVER_TTL_SECONDS` |
| `:server-heartbeats` | Sorted server heartbeat directory | stale entries removed on heartbeat |
| `:rooms:{roomId}` | JSON room directory record | `ROOM_DIRECTORY_TTL_SECONDS` |
| `:room-directory` | Sorted room IDs by activity | stale entries removed on listing |
| `:server-rooms:{serverId}` | Rooms registered by one server | room directory TTL |
| `:room-owner:{roomId}` | Exclusive owner lease and fencing value | `ROOM_OWNERSHIP_TTL_SECONDS` |
| `:room-fence:{roomId}` | Monotonic fencing counter | 24 hours after last acquisition |
| `:room-members:{roomId}` | Confirmed distributed admission members | refreshed temporary set |
| `:room-reservations:{roomId}` | Expiring admission reservations | pruned atomically on reservation |
| `:socket-stream` | Socket.IO cross-process packet stream | approximately 10,000 entries |
| `:socket-session:*` | Optional Socket.IO recovery state | adapter-managed |

Redis credentials, reconnect tokens, ROM data, local file paths, and chat history are not part of these keys. Redis must not be exposed to browsers or public networks.
