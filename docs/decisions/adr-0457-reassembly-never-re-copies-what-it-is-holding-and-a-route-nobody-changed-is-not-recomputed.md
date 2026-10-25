---
id: D457
title: Reassembly never re-copies what it is holding, and a route nobody changed is not recomputed
status: accepted
date: 2026-09-11
supersedes:
applies-to:
  - packages/system/src/kernel/transport/cap-child-index.ts
  - packages/system/src/kernel/transport/local-child-registry.ts
  - patches/moleculer+0.15.0.patch
last-verified: 2026-10-02
---

## Context

D456 profiled hub-main and ended by naming two costs it did not fix. This
record is those two, and only those two — the 70 % that is V8's concurrent GC
against a 785 MB heap is a separate investigation and is untouched here.

**The first was a claim, not a measurement.** The profile put **20.8 % of
hub-main's busy main thread** inside one `_write` — Moleculer's TCP transporter
`Parser`, on the MESH plane, which no release has ever touched — and asserted
it was quadratic in the chunk count. A profile can say where the time goes; it
cannot say what shape the cost has. So the shape was measured first
(`scripts/bench-moleculer-tcp-parser.mts`, best-of-7, the two implementations
alternating per iteration, against an allocation-only floor of 3–16 µs). One
4 MiB packet, halving the chunk size each row:

| chunk | chunks | ms | vs previous row |
| --- | --- | --- | --- |
| 64 K | 65 | 8.26 | — |
| 32 K | 129 | 17.03 | 2.06× |
| 16 K | 257 | 33.57 | 1.97× |
| 8 K | 513 | 65.18 | 1.94× |
| 4 K | 1025 | 132.61 | 2.03× |

Halving `c` doubles the time at fixed `M`. **The claim is confirmed**: the cost
is ~M²/c, because `_write` did `Buffer.concat([this.buf, chunk])` AND
`Buffer.from(packet)` — two full copies of the pending remainder — once per
chunk that left a partial packet.

**What is large enough on that plane to split into many chunks.** Two senders,
both by design and both documented where they live: `pipelineRunner.getNativeCrop`
takes `encodeJpeg` precisely so the CROSS-NODE fetch carries a base64 JPEG
rather than raw pixels (D9, D18), and `pipelineRunner.runStatelessStep` carries
a **full frame** as base64 JPEG, node-pinned, for every bulk re-embedding pass
(D54). `maxPacketSize` is 10 MiB. A full-resolution key frame was measured at
**2 824 077 B** base64 on this hub (`pipeline-analytics.cap.ts`), i.e. ~43
chunks of 64 KiB — ~120 MB of copying, for one request. This is an enumeration
from the code and the cap contracts; **the live size distribution on the mesh
was not measured**, and nothing here claims a per-sender figure.

**The second cost was already measured and needed no experiment.**
`resolveChildId` at **7.1 % self time (1 259 ms of 17 687 ms busy)** — after
D448 removed the msgpack, larger than all of msgpack put together — a linear
walk of 39 children × their cap descriptors on every `cap-call-out`. And the
decoded sibling branch paid it **twice**: it resolved the target, then handed
the call to `callCap`, which resolved the same cap again.

**Why the map was not there, read before it was added.** Not an oversight. What
`resolveChildId` reads MOVES: a runner is replaced on every update, a crash
respawns one, a child re-registers with a replacement manifest after init, and
`childId` is reused across generations so a superseded connection's close must
NOT evict the live successor (D188 — recording was absent for 7 hours). An
index maintained incrementally — add on register, remove on close — is a second
authority that can disagree with the first, and a stale one routes work into a
socket nobody is reading. That is strictly worse than a slow scan, and it is
the thing D3 forbids: no shadow registries.

## Decision

**Reassembly holds its pending bytes in a LIST and concatenates once per
completed unit, never per chunk; and a derived route index is a pure function
of the registry it derives from, discarded whole on every mutation of it and
never maintained in place.** Concretely:

1. **The mesh parser accumulates without copying.** `patches/moleculer+0.15.0.patch`
   replaces `Parser._write`'s accumulator with the same shape CamStack already
   applied to its own UDS `FrameDecoder`: pending chunks in an array, one
   `Buffer.concat` when a whole packet is available, **none at all while one is
   still incomplete**, and the 6-byte header read across the chunk boundary
   without flattening what is behind it. Everything else is byte-for-byte the
   original: the framing, the CRC check and its position, the `maxPacketSize`
   rule measured against the ACCUMULATED bytes rather than the declared length,
   the `data` event shape, the error text. The old `this.buf` field is
   **deleted**, not shimmed — nothing outside the file read it, and a
   getter-only shadow of a formerly-writable field is a new incompatibility
   dressed as compatibility.

2. **A patch, not a transporter, and not smaller messages.** `transport.md`
   says there are exactly two transports and a third is not to be added, so
   writing our own transporter to fix a 25-line accumulator is an architecture
   change standing in for an optimisation — it would put discovery, gossip,
   reconnect and the agent handshake back on the table for a defect that is
   none of those. Shrinking the two identified senders (base64 `str` → msgpack
   `bin`: ~25 % fewer bytes and, because the cost is ~M²/c, ~44 % less copying)
   is real and is NOT rejected — it is a cap wire-contract change with version
   skew, on the pipeline surface that has just shipped (D455), and it leaves
   the quadratic in place for every other message and for the next sender.
   `patch-package` is already this repo's mechanism (two existing patches, a
   `postinstall` hook), the patch is a reviewable diff in the tree, and a
   moleculer bump makes it fail to apply LOUDLY at install rather than silently
   reverting.

3. **The patch ships because the parser is BUNDLED.** `moleculer` is inlined
   into `@camstack/system/dist/index.js` at build time (the profile's own
   frame, `dist/index.js:78909`), so the patch — applied by `postinstall`
   wherever the artifact is built — is part of the published closure. It is not
   a runtime dependency on the hub and there is no `patches/` directory there.
   That also means the usual framework rule applies: this is **not live until a
   `@camstack/server` containing it is installed**.

4. **The index is discarded, never maintained.** `buildCapChildIndex`
   (`cap-child-index.ts`) is a pure function of the children it is handed; it
   captures nothing and cannot be updated in place. `LocalChildRegistry` holds
   one, sets it to `null` in the same statement as every write to `children`
   (the register, which REPLACES a manifest wholesale, and the delete on a
   close that was not superseded), and rebuilds it on next use. There is
   therefore no update path that could disagree with the map: the map stays the
   single authority and the index holds no fact it does not.

5. **What the index does NOT hold is as deliberate as what it does.** The
   operator's `setActiveSingleton` preference changes without any child
   connecting or leaving, so it is read LIVE at resolution time and the index
   supplies only the ordered candidate list. The two tiers stay separate — a
   device lookup is never answered from a deviceId-less descriptor — because
   `resolveChildId` owns the fallback from one to the other and folding them in
   would make it unreachable.

6. **A route already resolved is not resolved again.** The decoded sibling
   branch calls `callCapOnChild(target, …)` with the child it already resolved,
   falling back to `callCap` only if that entry vanished in between, so the
   error wording callers read is unchanged.

## Consequences

- **Measured, on this Mac, not on the hub.** The parser: a 4 MiB packet in
  64 KiB chunks goes **8.26 ms → 0.15 ms (55×)**, and at 4 KiB chunks
  132.61 ms → 0.32 ms (414×); the patched column is FLAT across chunk sizes,
  which is the linearity claim rather than a speed claim.
  `scripts/bench-cap-child-index.mts` over 39 children / 666 descriptors /
  3 000 calls: **3.166 ms → 0.131 ms above a 3 µs floor, 96.0 % removed**,
  1.054 µs → 0.042 µs per call. Applied to the profile's shares that is
  ~6.8 of the 7.1 points of `resolveChildId`, and the bulk of the 20.8 points
  of `Parser._write` — but **the before/after on the live hub is not measured
  here and is not claimed**. This worktree must not deploy, and the "after"
  cannot exist until a release carrying it is installed. The number to take on
  the hub afterwards is a *sampled* main-thread figure against D456's
  17 687 ms busy / 34.8 % — never a `ps` lifetime average (D456 part 4).
- **hub-main's largest cost is still not addressed.** 70 % of its CPU is V8's
  concurrent GC on four platform workers against a 785 MB heap. Both items here
  are on the main thread's 34.8 %, and shrinking the copying reduces the
  garbage those workers are marking only incidentally. The heap is its own
  investigation.
- **A moleculer upgrade now has a step.** `npm ci` fails if the patch does not
  apply, and `mesh-tcp-parser.spec.ts` fails if it applies but the behaviour
  moved. Re-generate with `npx patch-package moleculer` after re-applying the
  accumulator, and re-run `scripts/bench-moleculer-tcp-parser.mts` — a version
  that fixed this upstream would show the legacy and live columns converge.
- **The cross-node payload sizes are still unmeasured.** The census D456 built
  is per-peer on the UDS plane; the mesh has `meshQueued=` (what is waiting to
  be written) and nothing about what arrives. If the sizes matter again, that
  is the instrument to build, and the answer this record gives — two named
  senders, from the contracts — is an enumeration, not a measurement.

## Enforcement

Three specs, 21 tests.

`moleculer/mesh-tcp-parser.spec.ts` (9) tests code we do not own, which is
justified only because the patch is part of the shipped artifact: six framing
cases that must not change (three packets in one chunk, a header straddling two
chunks, byte-for-byte reassembly across many chunks, a trailing partial
completed later, a bad CRC, `maxPacketSize` against the accumulated bytes and
not the declared length) plus two copy-accounting guards. The accounting is
**structural, not timed** — a spy on `Buffer.concat` counting calls and bytes —
because a threshold on a duration is a flaky guard and the call count is the
property the fix is actually about.

`transport/cap-child-index.spec.ts` (7) asserts the index against a REFERENCE
implementation of the scan it replaces, over a fleet carrying every case that
distinguishes them: insertion order, a child declaring a cap twice, a contested
device pair, a device lookup that must not be served from a singleton, an empty
fleet.

`transport/local-child-registry-cap-index.spec.ts` (6) is the invalidation, over
real UDS sockets: a child registering after an earlier resolution, a re-register
replacing a manifest, a disconnect, a superseded connection's close that must
NOT evict the live successor (D188), the index built once across 600
resolutions, and one resolution per decoded sibling call.

Every guard disarmed and the specs re-run:

| disarmed | red |
| --- | --- |
| a register does not invalidate the index | 3 |
| a disconnect does not invalidate the index | 2 |
| the index is rebuilt on every call (no cache) | 1 |
| a child declaring a cap twice is named twice | 3 |
| the LAST child wins a duplicated device pair | 1 |
| a device lookup is answered from a deviceId-less descriptor | 2 |
| the parser flattens on every chunk again (the quadratic) | 2 |
| `maxPacketSize` measured against the DECLARED length | 1 |
| the header is read only from the first chunk | 1 |
| the decoded branch re-resolves via `callCap` | 1 |

Ten disarms, ten reds, each on the anchor it was labelled against. Two of them
are worth naming: removing the register and disconnect invalidations also went
red in `local-child-registry.spec.ts` ("atomically replaces a child cap set on
re-registration", "drops a child cap when the child disconnects") — those
properties were **already guarded before this change**, which is why adding a
cache behind them was safe. The new file's own contribution is the supersede
case, the build count, and the single resolution.

The tenth disarm existed only because the ninth change had no guard at all: the
removed double resolution is behaviour-identical, so no existing test could see
it. Rather than ship it on "it is obviously the same", a spy on `resolveChildId`
was added and the disarm run against it. A change nothing can observe is a
change nothing will notice breaking.
