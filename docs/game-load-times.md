# Game Load Times

How long a player waits between pressing E and playing, why, and what is left
to do about it. Measured 2026-08-27 against `https://assets.ptcarcade.fun`.

## The principle

An emulator reads a few percent of a disc in a session, and booting one touches
only megabytes. So the size of a game image is not, by itself, a load time.
Three things decide it:

1. **Fetch only what is read.** A virtual disc whose reads are HTTP ranges makes
   time-to-first-frame a function of the boot path, not the image.
2. **Fetch it before it is asked for.** Warming those bytes while the player
   walks up removes the wait entirely.
3. **Keep what was fetched.** An on-disk chunk store makes the second session
   local.

A 4.3 GB PS2 game starts about as fast as a 32 MB N64 ROM because all three
apply to it. Nothing in that scheme is size-dependent: a 9 GB dual-layer image
behaves the same.

## Where each platform stands

| System | Format | Largest | Path | First play |
|---|---|---|---|---|
| SNES | sfc | 2 MB | whole file | instant |
| N64 | z64 / n64 | 32 MB | whole file | instant |
| PSX | chd, one pbp | 524 MB | whole file, EmulatorJS | seconds to minutes |
| PS2 | iso / chd | 4.3 GB | **range-streamed, pre-warmed** | seconds |
| GameCube | rvz | 1.36 GB | whole image into wasm memory | minutes |

### PS2 — done

`emulators/play/index.html` hands the Play! core a virtual file whose `slice()`
calls are range requests: 4 MB chunks, read-ahead of 2–4 chunks, a memory LRU
over an OPFS store shared with the arcade page. `warmEmulatorCore` in `arcade.js`
pulls the boot region as the player approaches, so the cabinet modal opens onto
a running game.

Two refinements are in place beyond the original scheme:

- **The chunk store evicts.** It used to stop accepting anything at 512 MB, so
  whatever a player read first was all they ever kept and every later session
  re-fetched the rest of the disc. It is now an LRU with the boot chunks pinned.
- **Warming can be measured rather than guessed.** Warming the opening chunks
  assumes the executable sits near the front. A title can instead declare
  `bootChunks` in `assets/games/registry.json` — the 4 MB chunk indexes a core
  was seen reading while booting, in order. To record a title: play it once,
  wait 45 seconds, and read the line the frame logs:

  ```
  arcade: bootChunks for kingdom-hearts-v1.chd = [0,1,2,37,38]
  ```

  Paste that array into the game's registry entry. Absent means guess; present
  means measured.

  Mega Man X7 is measured. It reads **46 chunks — 184 MB — before its title
  screen**, and they are not at the front of the disc: after the opening five it
  jumps to 189, 185-188, 168-172, 34-38, and on. Warming the first three chunks
  of the disc, which is what the guess does, caught three of those forty-six.

  Two numbers from booting it against the live CDN. Cold, it issued 59 range
  requests, each taking **517-1080 ms** — a 4 MB chunk on a 45 Mbit line — and
  every one of those is a stall the player sees. With the boot set already on
  disk, the same boot issued **zero**. That is the whole argument for measuring
  a title and for warming the rest of its list in the background once it starts:
  the stalls are not the emulator being slow, they are the disc arriving late.

- **A disc fills itself in while it is played.** Streaming makes a game start
  quickly; it does not make it stall-free, because any read that misses is a
  round trip the player feels. From the moment a disc is handed to the core the
  frame walks the rest of it in the background, skipping what is already
  stored, standing aside whenever a read reaches the network, and stopping if
  storage runs short. Measured on Mega Man X7 while playing it: about 38 chunks
  a minute — 150 MB — with the core holding 55-56 f/s, so a 761 MB disc is
  wholly local after roughly four minutes of play. After that the game never
  touches the network again.

  This is why the hosting is not the lever. A 4 MB range from the CDN takes
  0.94 s at 4.5 MB/s, which is the line rather than the origin; the same disc
  served from anywhere else on the same connection costs the same. What removes
  the wait is already having the bytes.

### GameCube — blocked, and mostly by design

Gecko's `DiscBuffer.append()` then `.start()` needs the whole image resident in
WebAssembly memory before a frame renders. Streaming it means changing the disc
reader inside the Gecko core — a Rust change, in a repository this one does not
vendor (see `tools/gecko-web-disc.patch` and `emulators/gecko/BUILD.txt` for the
existing local patch). The usual shape is a read callback served from a worker
over `SharedArrayBuffer` + `Atomics.wait`, so a synchronous read inside wasm can
block on an async fetch. The COOP/COEP headers this app already sets allow that.

That work is probably not worth doing. Gecko is the experimental fallback; the
[PTC Arcade Runtime](./ptc-arcade-runtime.md) is the real GameCube path.

**What is worth doing is free.** Every hosted GameCube image is stored with
compression `NONE`:

```
$ npm run verify:images -- --system gamecube
super-smash-bros-melee   1361 MB   packing NONE   97.7% of the disc
wind-waker               1035 MB   packing NONE   74.3%
super-mario-sunshine     1122 MB   packing NONE   80.6%
zelda-twilight-princess   980 MB   packing NONE   70.4%
pikmin                    630 MB   packing NONE   45.2%
```

RVZ strips a disc's junk data whether or not it compresses, which is why these
sizes looked plausible. Re-encoding with zstd typically lands a GameCube title
at 30–50% of the raw disc — Melee would go from 1.33 GB to roughly half a
gigabyte, halving every player's first play, with no code change at all:

```bash
DolphinTool convert -f rvz -c zstd -l 5 -b 131072 -i melee.rvz -o melee-zstd.rvz
```

Then re-upload with `npm run storage:upload`, update `sizeBytes` in the
registry, and confirm with `npm run verify:images`. This needs DolphinTool and
the source images, so it has not been run here.

The same applies to the two raw PS2 ISOs (`gta-san-andreas` 4.3 GB,
`dbz-tenkaichi-3` 2.9 GB). They stream, so the wait is already short, but CHD
would cut what the CDN serves — `kingdom-hearts` is CHD and is the smallest of
the three despite being a full disc.

### PSX — one image worth converting

The PSX titles are CHD, which is compressed and block-indexed, and small enough
that the download is tolerable. EmulatorJS takes its ROM as a URL and reads it
whole; feeding it a virtual file would mean changing a third-party loader, which
is not worth it at 300–500 MB.

`crash-bandicoot` is the exception: a raw `.pbp` at 524 MB, the largest PSX
image by some way. Converting it to CHD would make it the smallest.

## Delivery

Verified against the live CDN — every image, all 29:

- `206 Partial Content` with a correct `Content-Range` on every object.
- `Accept-Ranges: bytes` present.
- `access-control-expose-headers` includes `Content-Range`, without which a
  browser on another origin cannot trust a range and streaming silently falls
  back to whole-file downloads.

`npm run verify:images` re-checks all of this and exits non-zero if any image
loses range support. Run it after any storage or CDN change.

The asset origin is also preconnected from `index.html` as soon as the runtime
configuration names it, so the first range request does not pay for DNS and a
TLS handshake at the moment a player is waiting.

## What would make it instant, end to end

In rough order of payoff:

1. Re-encode the five GameCube images with zstd. Free, halves that queue.
2. Record `bootChunks` for the remaining PS2 titles — Kingdom Hearts, GTA San
   Andreas, DBZ Tenkaichi 3. Mega Man X7 is done; each is one play session.
3. Convert `crash-bandicoot` from pbp to CHD.
4. Convert the two raw PS2 ISOs to CHD.
5. Only then, if browser GameCube still matters: a streaming disc reader in
   Gecko.
