# PTC Arcade Runtime

Runs PTC Arcade GameCube cabinets through [Dolphin](https://github.com/dolphin-emu/dolphin),
because a browser core cannot run them well enough to be worth playing.

Design, threat model, and the reasoning behind the security decisions:
[`docs/ptc-arcade-runtime.md`](../docs/ptc-arcade-runtime.md).

## Running it

```sh
node src/index.js
```

It binds a loopback port (49731 upward), prints a pairing code when the arcade
asks to pair, and otherwise stays quiet. Nothing is installed system-wide and
nothing runs as a service — it is a program you start, so its lifetime and its
permissions stay yours to reason about.

Point it at a different arcade with `PTC_ARCADE_ORIGIN`.

## Where it keeps things

| | Windows | Linux / macOS |
|---|---|---|
| Config and install secret | `%LOCALAPPDATA%\PTCArcadeRuntime\config.json` | `~/.local/share/PTCArcadeRuntime/config.json` |
| Downloaded games | `…\PTCArcadeRuntime\games` | `…/PTCArcadeRuntime/games` |
| Dolphin's own user directory | `…\PTCArcadeRuntime\dolphin-user` | `…/PTCArcadeRuntime/dolphin-user` |

`config.json` is written `0600`: it holds the install secret that makes a paired
token verifiable, so another user on the machine must not be able to read it.

Set `dolphinPath` there to point at a portable Dolphin build; otherwise the
usual install locations are probed.

## What it will and will not do

It will download a game named in the arcade's catalogue, check it against the
catalogue's SHA-256, and start Dolphin on it.

It will not accept a path, a URL, or a command from a web page. A page names a
game id and nothing else — a page that could name the file to run would be
naming an executable, and any site you visit can reach `127.0.0.1`. Pairing
requires a code shown in this program's own window, so a page cannot authorize
itself in the background.
