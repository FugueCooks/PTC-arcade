# Phase 7 load and rendering tests

## Repeatable multi-process smoke test

Start an isolated Redis-compatible service on localhost, set `REDIS_URL`, then run `npm run smoke:multi-process`. The harness refuses non-loopback Redis hosts, creates a unique temporary Redis namespace, launches two server processes, confirms both reach readiness, joins 26 real Socket.IO clients through matchmaking, proves the 25-player room boundary creates a second populated room, verifies two server registrations and room-owner leases, drains both processes, and removes its temporary keys. Override the default ports with `SMOKE_SERVER_A_PORT` and `SMOKE_SERVER_B_PORT` if `18081` or `18082` are occupied.

The first repeatable run on 2026-08-23 passed in 902 ms: 26/26 clients joined, the two rooms contained exactly 25 and 1 players, two server registrations were present, and each room had one ownership lease. This is a coordination regression test, not a production capacity measurement.

Never point load tests at production. Start the Node server and Redis in an isolated environment, then run `npm run load:test`. Configure with `LOAD_TEST_URL`, `LOAD_TEST_USERS`, `LOAD_TEST_DURATION_SECONDS`, `LOAD_TEST_RAMP_SECONDS`, and `LOAD_TEST_MOVEMENT_INTERVAL_MS`. Optional scenario intervals are `LOAD_TEST_CHAT_INTERVAL_MS` (minimum 5,000), `LOAD_TEST_CABINET_INTERVAL_MS` (minimum 7,500), and `LOAD_TEST_RECONNECT_INTERVAL_MS` (minimum 15,000); leave them at `0` to disable that traffic. Start at 10 users, then test 25, 50, 100, 250, 500, and 1,000 only when the previous level is healthy. The JSON report records successful joins, errors, movement/chat/cabinet traffic, reconnect cycles, and ping percentiles.

For isolated localhost tests above the per-IP matchmaking limit, start the test server with `TRUST_PROXY=1` and set `LOAD_TEST_FORWARDED_IPS=1`. The harness then assigns each synthetic user an address from the documentation-only `198.51.100.0/24` range. Never enable this switch against a public endpoint; it exists only to exercise capacity while preserving the production per-IP guard.

Cabinet requests deliberately target one known cabinet from ordinary spawn positions. Most are expected to exercise authoritative distance or ownership rejection; dedicated cabinet-success tests remain in the automated server suite.

Client rendering is a separate limit. On localhost only, append `?avatarStress=25` (supported range 1–100). The browser creates simulated remote avatars and refreshes `window.ARCADE_STRESS` once per second with FPS, frame time, render scale, draw calls, triangles, geometry/texture counts, JavaScript heap where the browser exposes it, avatar update cost, and nameplate count. Call `window.ARCADE_STRESS.stop()` to stop sampling. Use browser performance tools for deeper GPU timing and texture-memory analysis. This switch is hard-disabled on non-local hostnames.

No capacity claim is valid until a repeatable test records hardware, region, Redis topology, server version, room size, error rate, p95/p99 latency, CPU, memory, and event-loop delay.

## Harness smoke test

On 2026-08-23, the local single-process harness completed a five-user, 19-second mixed scenario with 451 movement packets, 10 chat messages, five cabinet-validation requests, and five reconnect cycles. All five users joined, no harness errors occurred, and measured ping was 1 ms p50/p95 and 190 ms p99. This validates the scenario tooling only; it is not a production or concurrency-capacity result.

## Local two-process Redis results

On 2026-08-23, two Node.js v24.9.0 server processes shared Memurai Developer 4.1.7 through the Redis protocol on one Windows 11 machine (Intel Core i7-12650H, 10 cores/16 logical processors, 15.7 GB RAM). Each process owned one globally unique room. These results validate local coordination and establish a development baseline; they do not establish public or regional production capacity.

| Users | Duration/ramp | Result | Scenario traffic | Ping |
| ---: | --- | --- | --- | --- |
| 10 | 10 s / 2 s | 10 joined, 0 errors | 535 movement, 19 chat, 10 cabinet requests | p50 1 ms, p95 1 ms, p99 1 ms |
| 25 | 20 s / 3 s | 25 joined, 0 errors, 25 reconnect cycles | 2,638 movement, 74 chat, 29 cabinet requests | p50 0 ms, p95 1 ms, p99 65 ms |
| 50 | 20 s / 5 s | 50 joined, 0 errors; two rooms reached exactly 25/25 | 5,525 movement, 199 chat, 125 cabinet requests | p50 0 ms, p95 1 ms, p99 1 ms |

The first 25-user attempt correctly hit the 20-requests-per-10-seconds localhost IP guard (20 joined, five HTTP 429 responses). The rerun used the documented synthetic proxy-IP mode; the production guard was not weakened.

Failure testing stopped Redis while both processes remained active. Before the reconnect-policy fix, permanently ending the Redis client caused the Streams adapter's read loop to starve HTTP. With capped reconnect backoff, both `/health` endpoints remained HTTP 200 and both `/ready` endpoints returned HTTP 503 with `redis-unavailable`. After Redis restarted, readiness returned to HTTP 200 and both rooms reacquired fresh fenced leases and republished. A separate cold-start test against an unavailable Redis port produced `/health` 200, `/ready` 503, and quick-join HTTP 503 without creating a reservation.

Do not raise the recommended room limit above 25 from these results. Rendering performance still requires the browser stress test on representative low-, mid-, and high-end devices, and production capacity still requires a managed Redis deployment plus tests across the actual load balancer and regions.
