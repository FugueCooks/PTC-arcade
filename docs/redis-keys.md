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
| `:reconnect:{sha256(token)}` | Player-to-owner reconnect route | 20 seconds |
| `:socket-stream` | Socket.IO cross-process packet stream | approximately 10,000 entries |
| `:socket-session:*` | Optional Socket.IO recovery state | adapter-managed |
| `:wallet-challenges:{challengeId}` | Protected SIWS challenge, expected hash, origin, attempts | `WALLET_CHALLENGE_TTL_SECONDS` |
| `:wallet-auth-rate-limit:{sha256(identifier)}` | Distributed wallet/guest authentication counter | request-limit window |
| `:wallet-account-lock:{network}:{sha256(address)}` | Reserved wallet account-creation coordination key | short transaction window |

Redis credentials, raw reconnect tokens, signatures, signed messages, private keys, seed phrases, ROM data, local file paths, and chat history are not part of these keys. Reconnect tokens and rate-limit identifiers are one-way hashed before key construction. Redis must not be exposed to browsers or public networks.
