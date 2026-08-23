# Phase 7 load and rendering tests

Never point load tests at production. Start the Node server and Redis in an isolated environment, then run `npm run load:test`. Configure with `LOAD_TEST_URL`, `LOAD_TEST_USERS`, `LOAD_TEST_DURATION_SECONDS`, `LOAD_TEST_RAMP_SECONDS`, and `LOAD_TEST_MOVEMENT_INTERVAL_MS`. Optional scenario intervals are `LOAD_TEST_CHAT_INTERVAL_MS` (minimum 5,000), `LOAD_TEST_CABINET_INTERVAL_MS` (minimum 7,500), and `LOAD_TEST_RECONNECT_INTERVAL_MS` (minimum 15,000); leave them at `0` to disable that traffic. Start at 10 users, then test 25, 50, 100, 250, 500, and 1,000 only when the previous level is healthy. The JSON report records successful joins, errors, movement/chat/cabinet traffic, reconnect cycles, and ping percentiles.

Cabinet requests deliberately target one known cabinet from ordinary spawn positions. Most are expected to exercise authoritative distance or ownership rejection; dedicated cabinet-success tests remain in the automated server suite.

Client rendering is a separate limit. On localhost only, append `?avatarStress=25` (supported range 1–100). The browser creates simulated remote avatars and refreshes `window.ARCADE_STRESS` once per second with FPS, frame time, render scale, draw calls, triangles, geometry/texture counts, JavaScript heap where the browser exposes it, avatar update cost, and nameplate count. Call `window.ARCADE_STRESS.stop()` to stop sampling. Use browser performance tools for deeper GPU timing and texture-memory analysis. This switch is hard-disabled on non-local hostnames.

No capacity claim is valid until a repeatable test records hardware, region, Redis topology, server version, room size, error rate, p95/p99 latency, CPU, memory, and event-loop delay.

## Harness smoke test

On 2026-08-23, the local single-process harness completed a five-user, 19-second mixed scenario with 451 movement packets, 10 chat messages, five cabinet-validation requests, and five reconnect cycles. All five users joined, no harness errors occurred, and measured ping was 1 ms p50/p95 and 190 ms p99. This validates the scenario tooling only; it is not a production or concurrency-capacity result.
