---
id: D443
title: hub-main's memory is read from its own heartbeat, never from a snapshot — and its two growths have different owners
status: accepted
date: 2026-09-10
applies-to:
  - packages/system/src/kernel/heap-watch.ts
  - packages/system/src/kernel/heap-spaces.ts
  - packages/system/src/kernel/transport/frame-codec.ts
  - server/backend/src/core/addon/addon-registry.service.ts
  - server/backend/src/main.ts
last-verified: 2026-10-02
---

## Context

hub-main (pid 7, `@camstack/server` 1.2.268 closure, `CAMSTACK_HUB_HEAP_MB=3072`,
`MALLOC_ARENA_MAX=2`) sat at 5.67 GB RSS after 22 h against a 2.3 GB JS live
set, with GC at 29.5 % of main-thread time and the live set growing ~57 MB/h
(D441). The question the evening could not answer was whether the ~3.3 GB
outside the JS heap was retained media (the retained tile store, the frame
handle registry) or something else — and the only tool anyone reached for was a
heap snapshot, which this repository forbids
(`scripts/check-no-heap-dump-command.ts`: twice it took the whole host down).

**The measurement already existed and was live.** `kernel/heap-watch.ts` +
`kernel/heap-spaces.ts` put `rss / heapUsed / heapTotal / external /
arrayBuffers / oldSpace / largeObjectSpace` and a per-peer UDS byte census on
every `[mem] hub-main` line — every 2 s while the heap is above 70 % of its
ceiling, which on this hub is always. Nothing had to be built or shipped to
answer the question; 10 764 lines from `docker logs` answered it.

Measured 2026-09-10, 30-minute post-GC floors (the reclaim's own
`heapUsed=A→B` lines give the true live set every 10 min):

| | 16:00 | 22:00 | Δ / 6 h |
| --- | --- | --- | --- |
| `oldSpace` floor | 1 833 MB | 2 123 MB | **+48 MB/h** |
| `largeObjectSpace` floor | 147 MB | 203 MB | +9 MB/h (one +33 MB step at 21:30) |
| `arrayBuffers` floor | 16 MB | 18 MB | **flat** |
| `external` floor | 492 MB | 569 MB | +13 MB/h |
| `rss` floor | 4 276 MB | 5 307 MB | +170 MB/h, 800 MB of it in one step |
| post-reclaim `heapUsed` (18:33 → 22:33) | 2 195 MB | 2 516 MB | **+80 MB/h** |

`/proc/7/smaps` (read as uid 1001, no pause): `RssAnon` 5.66 GB, `RssFile`
26 MB. Of the anonymous memory **2 725 MB is the single glibc `[heap]` (brk)
mapping** and 2 937 MB is V8's `[anon]` reservations (heapTotal ≈ 2.8 GB).
There is no sqlite mmap in this process and no 64 MiB arena mappings.

So the answer is **both, and they are different things**:

1. **Inside the heap: `old_space` grows ~50–90 MB/h.** `arrayBuffers` is flat
   at the floor. The retained tile store and the frame-handle registry are not
   in this process at all — they live in the `detection` runner — and the
   hypothesis that they held hub-main's memory is **falsified**.
2. **Outside the heap: ~2 GB of `stranded` (rss − heapUsed − external) is
   freed-but-unreturned glibc memory, not live objects.** Proof: when the
   17:26–18:31 ArrayBuffer episode below released 1.24 GB at once, RSS did not
   fall (4.4 → 5.3 GB permanent); when the 22:20 episode began, RSS stayed at
   its 5.3 GB floor for 20 minutes while `external` grew +1.4 GB — the new
   buffers were landing inside pages glibc already held. `heap-watch.ts`
   already says why the reclaim cannot touch it ("no V8 flavor can reach it;
   nothing in this repository calls `malloc_trim`").

**The churn is not the retention.** D441's CPU profile explains the GC share:
~600 req/s of sibling traffic decoded and re-encoded on the main thread —
`pipeline-orchestrator ↔ stream-broker` audio chunks at ~85 MB/min EACH WAY,
`sqlite-settings → hub-main` responses at 370–570 MB/min until 21:52 (then
~12 MB/min), `hub-main → pipeline-analytics` 100–600 MB/min of media
responses. That traffic is what feeds the brk residue (every burst above the
previous high-water mark leaves pages behind) and it is cost, not loss.

**What the 15-minute sampling heap profile named** (`HeapProfiler.startSampling`
over the inspector, 22:44:27–22:59:28 CEST, 16 KiB interval, no pause, 570 KB
of JSON; 72 MB of still-live sampled allocations):

- **41 MB — `@trpc/server/dist/ws-*.cjs:191` → `ws` `Sender.send` →
  `Writable._write`.** A tRPC WebSocket subscriber (`192.168.x.x:53390` on
  the LAN port 4480, the only WS client connected) was not reading:
  `socket.writableLength` 33 → 42 → 58 → 88 MB across the evening, ~2 MB/min,
  `bytesRead` frozen at 160 KB. `net.Socket` has `decodeStrings: false`, so
  the queued JSON strings live in **old_space**. Nothing bounds it; nothing
  logs it; the queue is released only when the socket dies (the 18:31 release
  of the earlier episode was not this — see below).
- **9.3 MB — `/data/addons/@camstack/addon-pipeline-orchestrator/dist/index.js`
  evaluated INSIDE hub-main** (`loadCJSModuleWithModuleLoad`).
  `AddonRegistryService.registerForkedAddonCustomActions` purges the require
  cache and re-imports a forked addon's whole bundle, in hub-main, at every
  spawn and every hot-update of that addon, to read `customActions`. The
  pipeline-orchestrator was deployed at 22:52:01, inside the window. Ten
  deploys in this process's 23 h life, **none of which exported a catalog**:
  the only outcome line is at `debug`, which the hub does not write, so ten
  bundle evaluations produced nothing and said nothing (D391). Module-scope
  state of an evicted graph (timers, listeners, pools) is exactly what a
  purge-and-reimport can pin, and the ESM record of each `?t=` URL is never
  released.
- 7.4 MB — Moleculer MsgPack `deserialize` of frames from the agents (fd 23,
  1.94 GB read from `192.168.x.x`), retained; 2.1 MB of Buffer pool slabs
  (`createPool`), i.e. ~30 k live 8 KiB slabs pinned by small Buffers.

**What it could NOT name: the ArrayBuffer episodes.** Twice today
`arrayBuffers` rose linearly and released in one instant, silently:

| | start | rate | peak | release |
| --- | --- | --- | --- | --- |
| episode 1 | 17:26 | ~20 MB/min | 1 264 MB at 18:30 | 18:31, to 21 MB in one heartbeat |
| episode 2 | 22:20 | 60–85 MB/min | **2 972 MB at 23:03 and climbing** | not yet |

Not one line from hub-main at either boundary. Verified NOT to be: any
socket's write queue (`process._getActiveHandles()` sums to 84 MB queued, all
of it the WS client above); the `ws` sender queue (empty, no deflate
negotiated); the reverse proxy (`upRes.pipe(clientRes)`, backpressured); the
deploy-bundle stage (single-use, 5-min TTL); Loki (10 k entries, strings); the
model distributor (never ran); UDS pending requests (60 s timeout). The
sampling profiler cannot see it by construction — it samples V8 heap
allocations, and an ArrayBuffer's backing store is not one. The measurement
that names its SHAPE is `Runtime.queryObjects(ArrayBuffer.prototype)` +
`callFunctionOn` for a byteLength histogram: one forced GC plus a heap walk,
in memory, nothing serialised, nothing written — the same ~1 s pause the
reclaim already pays every 10 min. It is prepared (`abhist` mode of the
session's inspector client) and was NOT run: this session's runtime refused
it, and a forced GC on production is the operator's call.

## Decision

- **hub-main's memory question is answered from the `[mem] hub-main` line
  first.** Inside/outside, churn/retention, and the per-peer census are all
  on it; `docker logs CamStack | grep '\[mem\] hub-main'` over 6 h is the
  measurement, and it costs nothing. A heap snapshot is never the next step
  (the guard stands); the sampling heap profiler over the inspector is the
  next step for an **old_space** growth, and it is declared with its start
  and stop times. An ArrayBuffer growth is a different question with a
  different tool (`queryObjects`), and a sampling profile that comes back
  empty for it is expected, not a negative result.
- **`stranded` on hub-main is glibc residue and is read as such.** It is not
  evidence of retained media, and it is not an emergency: it is refilled by
  the next burst before RSS grows. What shrinks it is less bulk transiting
  the router (D441's list), not a trim call.
- **A WebSocket subscriber that stops reading is disconnected, not
  buffered forever.** `bufferedAmount` above a bound (tens of MB) on a tRPC
  WS client closes that socket with a log line naming the peer and the
  queued bytes. **Shipped** — `server/backend/src/api/trpc/ws-slow-consumer-guard.ts`
  (`WS_SLOW_CONSUMER_MAX_BUFFERED_BYTES`). The `[mem] hub-main` per-peer census
  is still how you find one before the bound trips.
- **hub-main does not evaluate a forked addon's bundle to learn its
  custom-action catalog.** The catalog is answered by the runner over the UDS
  gateway like `data-planes` already is, or read from the manifest.
  **Shipped as [D444](adr-0444-hub-main-measures-its-own-episodes-bounds-its-readers-and-reads-no-bundle.md)**,
  and in the stronger form: the child DESCRIBES its catalog unasked, in its
  post-init register frame with schemas stripped, and hub-main applies the
  description (`applyChildCustomActions`). `registerForkedAddonCustomActions`,
  the purge-and-reimport this record measured at 9.3 MB, is gone — and with
  nothing left to purge, so are `require-cache.ts` and the D284 guard that
  watched it. The interim "log every load at `info`" is therefore moot: there
  are no loads.
- **A retention that releases in one instant with no line is a bug on its
  own**, whatever it retained: the release site logs what it dropped and why.

## Consequences

- The retained-tile-store hypothesis is closed for hub-main. The `worker-lease-gone`
  / `recycled-before-pin` misses on 101 are a runner-side lease question and
  are not this process's memory.
- Everything measurable here was measured from outside the closure: docker
  logs, `/proc`, and `Runtime.evaluate` over an inspector that an earlier
  session had left listening on 127.0.0.1:9229 (closed at the end of this
  one; `kill -USR1 7` inside the container reopens it). None of the fixes
  above is deployable with `camstack deploy`: the WS bound and the
  custom-actions loader are `server/backend`, the transport is
  `@camstack/system` — all ride a published `@camstack/server` (D16).
- The container still carries `CAMSTACK_RUNNER_HEAP_SNAPSHOT=on` in its
  environment. Nothing reads it any more; it is removed at the next
  container recreate so it cannot be read as permission by anyone.
- Two leftovers that described the removed heap-dump method as if it existed
  (`metrics-provider.cap.ts`, `native-metrics.addon.ts`) are deleted; the
  `// REMOVED` record stays.
- (planning repo: sessions/sessions.md) (2026-09-10, D441 entry, option 5) recommends <!-- drift-ok: moved to the private planning repo -->
  `v8.writeHeapSnapshot` over the inspector. That option is void — the
  guard forbids it and the operator confirmed it took the whole host down.

## Enforcement

`scripts/check-no-heap-dump-command.ts` (unchanged). The WS bound and the
custom-actions gateway are the next changes and each arrives with its
disarmed-red test; until then this record and the `[mem]` line are the
guard.
