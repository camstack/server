---
id: D456
title: A byte census names the ACTION and says how much of it the parent actually read, and a cost is attributed to the thread that burns it
status: accepted
date: 2026-09-11
supersedes:
applies-to:
  - packages/system/src/kernel/transport/cap-action-census.ts
  - packages/system/src/kernel/transport/socket-channel.ts
  - packages/system/src/kernel/transport/local-child-registry.ts
  - packages/system/src/kernel/socket-plane-report.ts
last-verified: 2026-10-02
---

## Context

D454 closed with one sentence of unfinished business: *"Naming the METHOD needs
a per-action byte census on the channel, which `socket-traffic.ts` deliberately
does not keep. That is the next instrument, and it should be built before
another fix is proposed for this flow."* This record is that instrument, and the
profile that had to come with it.

**Why the bytes on the line stopped being the cost.** Raw-forward is live on
1.2.270. Measured on the hub at 13:03 CEST, `socketFwd=30349/5051` — **85.7 % of
sibling cap calls cross hub-main without being read.** A forwarded body costs a
`writev` of a view; a decoded one costs msgpack in both directions plus the
garbage. Two peers moving the same megabytes now cost hub-main wildly different
amounts, and nothing on the line said which was which. *What costs is what
hub-main LOOKS at, not what it carries.*

**Why `socket-traffic.ts` keeps no method, read before it was changed.** Three
reasons, all real, and the design answers each rather than relaxing it:

1. *The channel does not know one.* `SocketChannel` sees `{ k, id, body }` with
   `body: unknown`. The cap envelope is one layer up. A counter reaching into
   `body.capName` would make the transport depend on the protocol it carries.
2. *A `res` frame carries no method at all* — only its correlation id. And the
   responses are the entire question: 144–262 MB/min to `pipeline-analytics` on
   1 966–2 411 responses, a 73–108 kB mean, against 2 kB of requests. Charging
   those bytes to a method is not a counter, it is a **correlation** — state per
   in-flight request, which does not belong in a two-addition hot path.
3. *Cardinality.* `recordSocketFrame` is 2.37 ns and allocates nothing at
   ~44 000 calls/s; its own rule is "an instrument that changes what it measures
   is not an instrument".

**The cardinality was measured, not assumed.** `nodes.getCapUsageGraph` already
keeps `(caller, provider, cap, method)` and, queried on this hub, holds **53
rows for the entire cluster** — 14 for `pipeline-analytics`, whose top three
caps are 2 077 of its 2 141 calls/min. A peer uses a handful of methods. The
binding limit is the LINE's width (D446: Loki reads these prefixes), not the
map's size, and those are different limits.

**And the first job of the profile was to clear the instrument itself.** D454
sums bytes per peer on every 2 s probe and sorts two rankings. A 50 s V8 CPU
profile of hub-main (inspector opened with `SIGUSR1`, closed from inside the
process afterwards; `Profiler.start` stalled **867 ms**, taken deliberately at
15:07 CEST) has **no sample at all** in `readTraffic`, `sampleSocketDirection`,
`diffSocketPlane`, `formatSocketPlane`, `queuedBytes` or `recordSocketFrame`;
`process.memoryUsage()` is 1 ms of 17 687 ms busy (0.006 %). The ironic
hypothesis is refuted with a null, which is the only way it could have been.

**What the same profile says about the release that shipped raw-forward.**
Of 17 687 ms busy: msgpack in total — `doDecodeSync`, `Encoder`, `doEncode`,
`utf8Count`, `decodeString`, `encodeFrame`/`encodeFrameHead` — is **5.9 %**,
against D441's 27 % decode + 6 % encode. **D448 delivered what it claimed.** The
largest single JS cost on the UDS plane is now `resolveChildId` at **7.1 % self
time (1 259 ms)** — more than all msgpack combined — a linear scan over 39
children × their cap descriptors on every `cap-call-out`.

**Where hub-main's CPU actually goes**, sampled 15:11 CEST over 30 s from
`/proc/7/task/*/stat`:

```
PROCESS TOTAL 135.7%
   39.6%  MainThread
   23.9%  V8Worker   ×4   = 95.4%
    0.6%  libuv-worker ×4
```

**Seventy per cent of hub-main's CPU is not JS at all** — it is V8's concurrent
GC on four platform workers, against a 785 MB heap and 632 MB of old space. The
main thread was **34.8 % busy**; it was idle for 33 s of the 50 s profiled. A
`%CPU` read from `ps` is a LIFETIME AVERAGE (108 % for this pid) and is not the
same number as an instantaneous sample (144.8 %); a before/after comparison that
mixes the two measures nothing.

And on the main thread the top cost is not the UDS plane either: **20.8 % of
busy is one `_write`** — `Buffer.concat([this.buf, chunk])` plus
`Buffer.from(packet)` in Moleculer's TCP transporter `Parser`
(`@camstack/system/dist/index.js:78909`, reached through `Readable.pipe`), which
re-copies a packet's whole remainder on every chunk that leaves a partial. It is
quadratic in the chunk count of a large cross-node message, it is the
**cross-node mesh and not the UDS plane**, and nothing in 1.2.270 touched it.
A further ~7 % is `BufferListStream.append` under the same transporter's msgpack
serializer on the publish path.

## Decision

**A byte census names the ACTION — `<peer>!<cap>.<method>` — and carries, on the
same row, how many of that action's calls the parent FORWARDED against how many
it DECODED. Bytes it cannot name are named as unnamed, and the census grades its
own coverage on the line.** Concretely:

1. **The channel owns the bytes and the correlation; never the label.**
   `SocketChannel.observeActions(observer)` takes a labeller from the layer that
   understands the protocol, calls it once per `req` frame (never per frame,
   never on the `evt` path), holds the answer against the frame's id, and
   settles it when the matching `res` is written or read. `send` returns the
   byte count the per-kind counter was given, so the two censuses can never
   disagree. A refusal is charged like an answer: a census that counted only the
   calls that succeeded would under-report exactly the methods going wrong.

2. **Full counters in memory, bounded per peer; top-N only at REPORT time.** A
   sampled window was rejected — the flow is few, enormous responses, and a
   sample that misses a method reports it as zero bytes, the `null`-vs-`0`
   confusion D393 exists to forbid. A byte THRESHOLD was rejected for the mirror
   reason: it decides what to keep before it knows the window's shape, so the
   method that only matters during an episode is the one it discards. Rank when
   the totals are known. `MAX_CAP_ACTIONS_PER_PEER = 64` (four times the
   measured worst case) bounds the unbounded case that a wire-supplied key makes
   possible in principle; past it the bytes go to a named `(overflow)` bucket
   and stop being *named*, which is a different and visible failure from being
   dropped.

3. **The line grows by two fields, appended LAST, after `socketFwd`** (D446: no
   existing field moves, every Loki prefix written since 2026-08-29 still
   matches). `socketActions=<labelled>/<total>kB` is the census grading itself
   and prints even at `0/0` — a census that named nothing is a reading.
   `socketTopActions=<peer>!<cap>.<method>:<kB>/<calls>:r<raw>/d<decoded>,…` is
   conditional, like `socketTop`: a ranked list of nothing is noise. Absent
   entirely from a registry that keeps no census, never zeroed.

4. **A CPU attribution names the THREAD.** A process figure for a Node runner is
   main thread plus V8's platform workers plus libuv's pool, and on this hub
   those are 39.6 / 95.4 / 0.6. A main-thread CPU profile answers "what is the
   event loop doing" and says nothing about the other 70 %; a `ps` `%CPU`
   answers "since this process started". Neither is "how loaded is hub-main
   right now", and a regression claim built on either alone is not measured.

## Consequences

- **The 150 MB to `pipeline-analytics` is already answered, by two instruments
  that existed.** The cap-usage graph says analytics makes 2 141 calls/min of
  which **2 091 (97.7 %) are `(unresolved: parent-routed)`** — served by
  hub-main's own in-process providers — against 47 that reach a sibling. A
  parent-routed call is `forwardedDecoded` by construction: raw-forward exists
  only sibling→sibling. So **essentially none of that flow is opaque; hub-main
  encodes every byte of it itself.** Cluster-wide the graph's 30 588 sibling /
  5 387 parent split corroborates `socketFwd=30349/5051` to within 1 %. What
  D456 buys is that this join — two queries and an hour — is one row on a line.
- **Scaletta item 1bis is now answerable rather than answered.** The census will
  name the method; it has not yet run on the hub, and this record does not claim
  a method. The standing hypothesis stays a hypothesis: `deviceState`
  (939 calls/min, parent-routed) carries ~140 of the 144 MB if `settings-store`
  answers at the 2.2 kB mean D454 measured, which would put ~150 kB on the mean
  `device-state` response. Written here as a hypothesis, in the format D454
  demanded.
- **`resolveChildId` is the next real win on the UDS plane, and it is measured:
  7.1 % of hub-main's busy main thread**, a linear scan of every child's cap
  list per call, now larger than all msgpack. It is not built here.
- **hub-main's cost is not on the UDS plane at all.** 70 % of its CPU is
  concurrent GC; the largest main-thread item is the Moleculer TCP Parser's
  quadratic re-copy. Neither is addressed by anything in the scaletta.
- **Nothing is rolled back.** `rollbackServerUpdate` would take D448 out with
  eight other records that shipped in the same 1.2.270 (D437, D446, D447, D449,
  D451, D452, D453, D454) — the version number cannot separate them, only the
  profile can, and the profile exonerates D448. It is also worth knowing before
  reaching for it that `getServerPackageStatus` currently reports
  `previousVersion: null`.
- The census costs one labeller call and one map lookup per `req` frame — not
  per frame, and not on the `evt` majority — and one integer add per completed
  pair. It is opt-in: a channel with no observer records nothing.

## Enforcement

Four specs, 31 tests: `transport/cap-action-census.spec.ts` (the label, the
per-peer charge, the raw/decoded split, the unnamed bucket, the bound, the
byte ranking, the window, the snapshot, the respawn clamp, the coverage),
`transport/socket-channel-actions.spec.ts` (the label taken off the envelope and
not after the handler, an error answer charged, both directions, the late `res`,
opt-in, a throwing observer, events charged nothing),
`transport/local-child-registry-action-census.spec.ts` (the wiring, the peer
identity, raw and decoded on the same key, forgetting a closed peer),
`socket-plane-action-report.spec.ts` (absent-never-zero, the field content,
coverage at zero, the D446 field ORDER, the ranking, the window).

Every guard disarmed and the four specs re-run:

| disarmed | red |
| --- | --- |
| the census ranks by CALLS instead of bytes | 2 |
| the per-peer bound is removed | 1 |
| `read()` hands back the live maps instead of a copy | 3 |
| the channel labels after the handler ran, not off the envelope | 3 |
| a `res` is charged before the waiter check | 2 |
| the registry drops what it cannot label instead of naming it | 1 |
| a raw forward is not charged per action | 1 |
| the line prints the cumulative census, not the window | 1 |
| `socketActions` is appended before `socketQueued` (D446 order) | 1 |
| the coverage field is omitted when nothing was named | 2 |

One disarm produced **no red on the first attempt**: removing the
`p.action !== null` guard left the late-`res` test green, because that test's
`res` finds no pending entry at all and never reaches the line. The test was
guarding a property — a late answer is charged to nobody — provided by the
`if (!p) return` above it, not by the line it was labelled against. Re-disarmed
at the anchor that actually provides it (recording BEFORE the waiter check):
2 red. The mislabelled disarm is recorded rather than quietly re-pointed,
because a guard whose red you have not seen is a guard you have not got.

Part 4 of the decision — a CPU attribution names the thread — is **review-only**.
No guard can tell that a percentage quoted in a plan came from `ps` rather than
a sampled delta, or from the main thread rather than the process. The defence is
that this record writes down what each number means and what it cost to learn
the difference.
