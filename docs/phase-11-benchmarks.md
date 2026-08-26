# Phase 11 — Cabinet Registry Benchmarks

Node v22.22.2, measured 2026-08-26T01:09:24.244Z. Reproduce with `npm run build && node tools/cabinet-benchmark.mjs`.

Median of 5 runs per measurement. Phase 11 forbids claiming a cabinet count
without measurements; these are them.

## Results

| Definitions | Build | Cells | Largest bucket | Cells/query | Lookup by ID | Lookup by zone | Nearby (indexed) | Nearby (full scan) | Speedup | Zone activation | Zone snapshot |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1,000 | 2.849 ms | 256 | 4 | 4 | 0.1342 µs | 0.038 µs | **0.2498 µs** | 4.3631 µs | **17.5×** | 1.2666 µs | 4.5547 µs |
| 5,000 | 8.316 ms | 1,275 | 4 | 4 | 0.1472 µs | 0.0352 µs | **0.3622 µs** | 31.3168 µs | **86.5×** | 1.1576 µs | 26.136 µs |
| 10,000 | 21.42 ms | 2,500 | 4 | 4 | 0.19 µs | 0.0376 µs | **0.6169 µs** | 140.1209 µs | **227.1×** | 1.207 µs | 52.8053 µs |
## Reading these numbers

**Nearby queries are the headline.** This is the per-frame interaction lookup,
and before Phase 11 it was a full scan of every cabinet. At 10,000 definitions
the indexed query is ~227× faster. The full-scan column is not hypothetical: it
is the same algorithm the render loop and the server both used, measured on the
same data.

**Cells visited per query stays at 4 regardless of registry size.** That is the
property the grid exists to provide — an 8 m cell against a 2.6 m interaction
radius spans at most two cells per axis, so the work per query is bounded by
local cabinet density rather than by how many cabinets exist.

**The indexed query still grows about 2.5× from 1k to 10k.** Cells visited is
constant, so this is not algorithmic: it is cache and hash-map behaviour as the
cell map outgrows L2. Worth stating plainly rather than rounding to "O(1)".

**ID and zone lookups are flat**, as expected for map reads.

**Zone snapshot grows with zone size, not registry size.** The synthetic layout
puts 1/20th of the registry in each zone, so at 10,000 definitions a zone holds
500 cabinets and its snapshot costs ~53 µs. That is the correct shape: a join
pays for the zone it enters. The shipped arcade's largest zone holds 10
cabinets. If a real deployment ever authored 500-cabinet zones, the fix is
smaller zones, not a faster snapshot.

**Build cost is one-time at startup**: 21 ms to validate, index, spatially hash,
and derive zones for 10,000 definitions.

## What is not measured

Rendering thousands of cabinet models simultaneously, which Phase 11 explicitly
does not require. The goal is holding thousands of *definitions* while loading
and synchronizing only the relevant subset, and that is what these measure.

Concurrent game-session creation, plugin initialization, replay serialization,
and API throughput are listed in the Phase 11 brief's performance section but
belong to later stages; replay is deferred to Phase 12 entirely.

## Supported scale

On this hardware the registry sustains **10,000 cabinet definitions** with
sub-microsecond indexed lookups and a bounded per-frame nearby query. Nothing
here is claimed beyond what the table shows.
