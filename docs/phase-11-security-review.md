# Phase 11 — Security Review (Milestone 11.38)

Scope: the Phase 11 diff on `claude/retro-arcade-multiplayer-update-2ithru`
(seven commits, Stages A–G). Pre-existing security posture is out of scope
except where Phase 11 changed it.

Method: read the diff against the review areas 11.38 lists, then probe the
running server directly for the surfaces that can be tested from outside —
path traversal, source exposure, unauthenticated access, oversized and
malformed bodies, and prototype-pollution-shaped query strings.

## Findings

### 1. Audit-write failure hung the request and risked terminating the process

**Severity:** Medium · **Status:** fixed in this phase ·
`server/src/operations/operations-actions.ts`, `server/src/http/operations-routes.ts`

`OperationsAuditLog.write` deliberately throws (`AuditSecretLeakError`) when a
record carries a secret-shaped field. That call sat *outside* the executor's
`try`/`catch`, so the throw rejected `execute()`. The route consumed that
promise with `.then(...)` and no `.catch(...)`, so the rejection would leave the
HTTP request hanging and surface as an unhandled rejection — which terminates
the Node process under the default policy.

Reaching it requires an authenticated operator *and* an action handler whose
result contains a key matching the secret guard. No shipped handler does, so
exploitability is low; the failure mode is severe enough to close anyway.

**Fix:** the audit write is wrapped, the failure is reported through an
`onAuditFailure` hook instead of propagating, and the action is still recorded
with the unwritable state stripped so the trail is never silently lost. The
route also gained a `.catch` that returns a 500 rather than hanging. Regression
test: `test/operations.test.ts`, "an audit write failure does not reject the
action promise".

### 2. Oversized and malformed request bodies reported as 500

**Severity:** Low · **Status:** fixed in this phase ·
`server/src/http/api/middleware/api-context.ts`, `server/src/http/operations-routes.ts`

Probing the running server with a 20 MB body returned `500 internal-error`.
`body-parser` rejections are client errors; reporting them as server faults
tells a caller to retry something that can never succeed, and misdirects
operators reading error rates. Now mapped to 413 and 400 respectively, verified
live. Regression test: `test/api-platform.test.ts`, "body-parser failures map to
client errors".

## Areas reviewed with no finding

Each was checked against the diff and, where externally observable, probed
against the running server.

**Plugin isolation and permissions (11.7, 11.10).** `PluginContext` is the
entire surface a plugin receives; it holds no database handle, Redis client,
filesystem handle, socket, cookie, or environment. The permission list contains
no grant for any of those, and a test asserts none can be added by matching
whole tokens (`read:player-safe-profile` legitimately contains "file", which a
naive substring check would flag). Grants are enforced at each call rather than
once at load.

**Arbitrary code execution via plugins (11.7).** Manifest validation rejects an
entrypoint that is absolute, a URL, traversing, or not a `.js`/`.mjs` file
inside the plugin directory. Separately, `plugin-bootstrap.ts` maps plugin IDs
to paths fixed in source: no value from configuration, a request, or a manifest
reaches an `import`. Only the project root is resolved at runtime, because the
build emits to `dist/` while plugins ship as plain JavaScript beside it.

**Plugin storage isolation (11.11).** The `arcade:plugin:{id}:` prefix is
applied by the storage layer, never supplied by the plugin, and keys containing
a separator are refused — so no key a plugin can construct reaches another
namespace. The filesystem backend hex-encodes keys into flat file names, which
removes path traversal by construction rather than by filtering.

**Operations authorization (11.27).** Verified against the running server: every
operations endpoint returns 401 unauthenticated, a forged cookie does not
authenticate, and a viewer holding a valid session *and* a valid CSRF token
still receives 403 on an action. Authorization is server-side only; the
dashboard hides nothing on its own. The session cookie is HttpOnly and
SameSite=Strict, confirmed unreadable from JavaScript in a real browser.

**Player-to-operator escalation (11.27).** Operator credentials live in a
separate store sharing no table, token format, or code path with player auth.
A connected Solana wallet is not special-cased — it is simply an unknown
operator ID. Login compares hashes in constant time and does the same work
whether or not the operator exists, and an unknown operator and a wrong token
return byte-identical responses.

**Arbitrary command, SQL, and Redis execution (11.28).** The action set is
enumerated. There is no route accepting a command, query, or key to run, and a
test attempts `exec`, `sh`, `eval`, `sql`, `redis.command`, `DROP TABLE users`,
`../../etc/passwd`, `__proto__`, and `constructor`, all refused as
`unknown-action`.

**XSS in the operations dashboard.** The dashboard builds every cell with
`textContent` and never touches `innerHTML`, `outerHTML`,
`insertAdjacentHTML`, `document.write`, `eval`, or `new Function` — verified by
grep over the new client files. Server-controlled strings therefore cannot
inject markup. The one plugin-reachable path to a player's screen
(`world:announcement`) is rendered with `element.textContent` in
`world/world-manager.js`.

**Path traversal and source exposure.** Probed live:
`/assets/../server/src/config.ts` and its percent-encoded form return 403;
`/server/src/config.ts`, `/package.json`, `/.env`, `/dist/...`, and
`/plugins/.../manifest.json` all return 404. Static hosting still serves only
the browser asset allowlist. Asset IDs in the game registry are restricted at
validation time to bare filenames or `https` URLs, rejecting `../`, absolute
paths, `http:`, and `data:`.

**API data exposure (11.30, 11.31).** Response DTOs are hand-written allowlists,
so a field added to a domain type cannot become public by accident — asserted
by a test that adds `metadata` and `pluginId` to a real definition and confirms
neither appears. Game DTOs omit asset IDs so the public catalogue does not
advertise ROM file names. No API response returns a stack trace; unexpected
errors become an opaque `internal-error` carrying only a request ID.

**Untrusted input handling.** Probed live: an oversized `limit` is clamped
rather than honoured, a `__proto__[x]` query string returns 200 with the server
healthy afterwards, a 500-character `zoneId` is rejected by length bounds, and a
traversal attempt in a path parameter 404s (IDs are Map lookups, never file
paths). `x-request-id` is echoed only when it matches
`^[A-Za-z0-9_-]{8,64}$`, which excludes CR/LF.

**Malicious registry input (11.38, "large cabinet registry inputs").** Registry
validation is depth-bounded and total over its input: `isSafeJsonValue` refuses
functions, class instances, non-finite numbers, cycles, and nesting past depth
8, so a hostile registry cannot blow the stack during validation.

## Not applicable this phase

**Replay upload validation and object-storage access.** Replay is deferred to
Phase 12, so there is no upload path, no replay payload parsing, and no
object-storage write credential in this phase. These must be reviewed when that
work lands; malicious replay payloads are the highest-risk surface the brief
anticipates, and none of it exists yet.

**Dependency integrity.** No dependencies were added or upgraded in Phase 11.

## Standing notes for operators

- `OPERATIONS_OPERATORS` tokens are only length-checked (24 characters minimum).
  Generate them from a CSPRNG; the format cannot enforce entropy.
- Operator sessions are in-memory, so a restart signs everyone out. That is the
  intended failure direction.
- Plugin storage is written to `PLUGIN_STORAGE_DIR` as plain JSON files. Treat
  that directory as application state, not as a secret store — plugins have no
  permission that would let them put a secret there, but the directory should
  still be excluded from backups shared more widely than the app.
