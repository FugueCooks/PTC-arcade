# PTC Arcade Runtime

A native companion application that runs GameCube cabinets through
[Dolphin](https://github.com/dolphin-emu/dolphin), because a browser core cannot
run them well enough to be worth playing.

Gecko stays as the experimental browser fallback. A player without the runtime
gets what they get today; a player with it gets native speed.

## Why a companion application

The browser constrains GameCube emulation in ways no amount of optimisation
removes: a hard memory ceiling, a JIT that cannot emit the code a recompiler
wants, and no direct GPU access on the path Dolphin's backends expect. Cloud
streaming avoids the install but costs real money per active player, every hour
they play. A local process avoids both, at the price of an installer.

## The shape of it

```
  browser                          native
  ─────────────────────────        ────────────────────────────
  cabinet                          PTC Arcade Runtime
    └ adapter  ──frame──▶ session.html ──http──▶ 127.0.0.1:49731
                                         │
                                         ├── catalogue  (from ptcarcade.fun)
                                         ├── library    (download + verify)
                                         └── Dolphin    (separate process)
```

The native launch still goes through an ordinary emulator **adapter** and an
ordinary **frame**. That is not ceremony. The arcade already tracks which
cabinet a player holds, tells the room it is occupied, and releases it when the
session ends — all through the adapter interface. A native launch that bypassed
it would leave the player standing at a cabinet the server believed was free
while Dolphin ran behind the browser. So `session.html` stays on screen showing
progress and a way back, while Dolphin has the display.

## The security model

This is the part to get right. The runtime starts native processes on request
from a web page, and **every site the player visits can reach `127.0.0.1`**.
Four things stand between a hostile page and a launched process, and none of
them is sufficient alone:

1. **Loopback only.** The socket never binds a routable address, so nothing off
   the machine can reach it.
2. **Origin allowlist.** Exact matches, no wildcards, no suffix matching —
   `https://ptcarcade.fun.evil.com` is not a match. Plaintext origins are
   permitted only on loopback, for development.
3. **Manual pairing.** The runtime displays a six-digit code **in its own
   window**, which the player types into the page. A background page cannot read
   that window, so it cannot pair itself. Codes expire, and wrong guesses burn a
   limited number of attempts.
4. **A token per install, bound to origin.** Signed with a per-install secret and
   checked in constant time, so a token lifted from one site's storage is
   useless from another.

### The rule the whole design rests on

**A page names a game id. It never names a path, a URL, or a command.**

A page that could name the file to run would be naming an executable to run, and
any site the player visits could then name one. So the launch request carries an
id; the runtime resolves it against a catalogue it fetched from the arcade over
TLS; and a request carrying anything resembling a path or an argument is refused
outright rather than sanitized — there is no legitimate request that carries one.

The same reasoning governs the frame: `session.html` is handed a game id, not
the hosted URL the browser already holds, because a frame that can give the
runtime a URL can give it any URL.

### Downloads are untrusted until proven

Every catalogue entry carries a SHA-256, taken from the manifest used to upload
the image, so the catalogue and the objects in storage agree by construction.
An entry that cannot be given a digest is **omitted from the catalogue** rather
than published without one — an entry with no digest is an unverifiable
download, and the runtime would have nothing to check the bytes against before
handing them to a native emulator.

The digest is computed while downloading rather than in a second pass; a
GameCube image runs past a gigabyte and reading it twice doubles the slowest
part of a first launch. A response longer than the catalogue declared is aborted
mid-stream rather than at the end, so a lying `Content-Length` cannot fill the
disk. A mismatch is never repaired or retried in place: the file is discarded.

### Dolphin's argument list

Built in exactly one function, from values the runtime resolved itself. There is
no "extra arguments" parameter, and an image path that would parse as a flag is
refused. Dolphin runs as a **separate process**, never linked into the runtime —
which is also the arrangement its GPL licence is simplest to satisfy under, and
means an emulator crash cannot take the runtime with it.

## What exists now

| Piece | State |
|---|---|
| `emulators/ptc-runtime/protocol.js` | Contract shared verbatim by page and runtime |
| `ptc-runtime/src/security.js` | Origin checks, pairing, tokens |
| `ptc-runtime/src/library.js` | Catalogue parsing, path resolution, download + digest |
| `ptc-runtime/src/dolphin.js` | Argument construction, discovery, exit interpretation |
| `server/src/runtime/runtime-catalog.ts` | Builds the catalogue from registry + upload manifest |
| `emulators/ptc-runtime/runtime-client.js` | Detection, pairing, launch, progress |
| `emulators/adapters/ptc-runtime-gamecube-adapter.js` | The adapter, and the runtime-or-Gecko choice |
| `emulators/ptc-runtime/session.html` | The in-arcade session panel |

All of it is covered by tests that run without Dolphin, without a network, and
without Windows — 47 of them, over the parts where being wrong is expensive.

The protocol is **one plain-JavaScript module imported by both sides** rather
than a type shared by one and re-declared by the other. The GameCube launch path
already lost a day to exactly that failure: the browser registry called a field
`system`, the server called it `platformId`, and every SNES cabinet quietly
launched on the PlayStation core. Two processes drifting the same way would be
far harder to see, because half the evidence would live on the player's machine.

## What does not exist yet

- **The HTTP server** that binds the loopback port and wires these pieces
  together. The parts it composes are written and tested; the composition is not.
- **Dolphin process supervision** — spawning, watching for the window, reporting
  the exit. `interpretExit` decides what an exit *means*; nothing calls it yet.
- **The arcade wiring.** `chooseGameCubeAdapter` exists and is tested, but
  `arcade.js` does not consult it yet, so GameCube cabinets still go to Gecko
  unconditionally. This is deliberate: wiring it before the runtime is
  installable would gate cabinets behind an application nobody can install.
- **The Windows installer**, code signing, and the runtime's own window.
- **Verification against real Dolphin.** Nothing here has been run against the
  actual emulator; this environment is Linux with no Dolphin and no network. The
  argument list follows Dolphin's documented CLI but has not been executed.

## Licensing

Dolphin is GPLv2-or-later. Shipping it alongside the runtime means carrying its
licence text and offering corresponding source for the binary distributed.
Launching it as a separate process — rather than linking it — keeps the runtime
itself outside the GPL's derivative-work boundary. Confirm the arrangement
before distributing an installer that bundles a Dolphin build.

## Following on

Android is a different problem, not a port: it has no loopback-service model a
browser can reach the same way, so it would need the arcade to run inside a
native shell instead. Worth doing after Windows proves the shape, not alongside.
