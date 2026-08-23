# Phase 7 load and rendering tests

Never point load tests at production. Start the Node server and Redis in an isolated environment, then run `npm run load:test`. Configure with `LOAD_TEST_URL`, `LOAD_TEST_USERS`, `LOAD_TEST_DURATION_SECONDS`, `LOAD_TEST_RAMP_SECONDS`, and `LOAD_TEST_MOVEMENT_INTERVAL_MS`. Start at 10 users, then test 50, 100, 500, and 1,000 only when the previous level is healthy. The JSON report records successful joins, errors, movement packets, and ping percentiles.

Client rendering is a separate limit. On localhost only, append `?avatarStress=25` (supported range 1–100). The browser creates simulated remote avatars and exposes setup measurements as `window.ARCADE_STRESS`. Record FPS, frame time, draw calls, triangles, heap, animation time, and nameplate cost in browser performance tools. This switch is hard-disabled on non-local hostnames.

No capacity claim is valid until a repeatable test records hardware, region, Redis topology, server version, room size, error rate, p95/p99 latency, CPU, memory, and event-loop delay.
