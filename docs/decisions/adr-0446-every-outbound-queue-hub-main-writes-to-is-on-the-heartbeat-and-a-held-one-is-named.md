---
id: D446
title: Every outbound queue hub-main writes to is on the heartbeat, a held one is named, and hub-main's live set is accounted for from its two boots
status: accepted
date: 2026-09-11
applies-to:
  - packages/system/src/kernel/outbound-queue-watch.ts
  - packages/system/src/kernel/moleculer/mesh-queue-report.ts
  - packages/system/src/kernel/socket-plane-report.ts
  - packages/system/src/kernel/heap-watch.ts
  - packages/system/src/kernel/transport/socket-channel.ts
  - packages/system/src/kernel/transport/local-child-registry.ts
last-verified: 2026-10-02
---

## Context

hub-main died at 01:32 CEST on 2026-09-11 with a 2 491 MB live set that had
been FLAT for two hours (D444). The question this record answers is what that
live set consisted of, and it is answered from the `[mem]` lines of the two
boots that followed — not from a snapshot, which this repository forbids.

**The live set was accounted for by two boots four hours apart.** The crashed
closure (`@camstack/server` 1.2.266) restarted at 01:33 in the same container
with the same 39 runners: post-GC `heapUsed` was **1 311–1 381 MB within two
minutes of boot** and 1 365 MB an hour later. The 1.2.269 closure (D444: no
addon bundle evaluated inside hub-main) restarted at 05:34 in the same
container: **686–722 MB within two minutes**, 714–716 MB two hours later, a
slope of ~0 MB/h in a quiet morning. The difference at boot, **~620–660 MB**,
is the one change between the two closures, and it is the bundle evaluation
D443 had sampled at "9.3 MB" — a sampling profile sees what was allocated in
its window, not what a module graph pins. Over the evening the floor moved in
steps of 30–80 MB at 19:38, 20:33, 22:07 and 22:52 — every one a
`camstack deploy` re-evaluating a bundle — for ~250 MB more. So of the
2 491 MB: ~690 MB is what a hub-main needs; ~870 MB was bundle evaluation
(gone with D444); ~88 MB was the phone's WebSocket queue (bounded by D444);
~95 MB is the residue of the ArrayBuffer episode below; ~750 MB accumulated
over 22 h from a source this record does not name — the 1.2.269 process must
be read at the same age before it is called a leak.

**The "sqlite-settings → hub-main 370–570 MB/min until 21:52" had a name all
along.** The per-peer census puts the burst at 20:32–21:52 CEST exactly, and
the sqlite profile line names it: `addon-device-settings` range walks, owner
`device-manager`, **2 694 calls/min returning 2 250 999 rows/min**. That is
the pipeline-orchestrator build installed at 20:33:39 (D440's placement
census reading every device's settings per dispatch) and it ends with the
build installed at 21:50:25 (D441). It was 500 MB/min of responses decoded
and re-encoded on hub-main's main thread for 77 minutes, and it was fixed by
a deploy nobody connected to it.

**The ArrayBuffer episode's owner is still unnamed, and one exclusion was
wrong.** The 4 968 MB climbed at a constant 63 MB/min for 77 minutes,
insensitive to load (the plane's tx/rx per minute did not move), survived the
orchestrator's respawn at 22:52, and released between the 23:37:04 and
23:37:06 probes; no peer's rate changed at either boundary. D443 excluded
"every socket write queue" by summing `writableLength` over
`process._getActiveHandles()`. That list holds only handles that keep the
event loop alive, and Moleculer's `TcpWriter.connect` calls `socket.unref()`
on every socket it opens to a peer node (`transporters/tcp/tcp-writer.js`).
The one outbound plane that writes to another MACHINE — where a reader that
stops draining is the ordinary failure — was never in the sum. Rejected
candidates, each by measurement: a UDS peer's stream parked in the frame
decoder (rx frame counts unchanged); the backup-archive download route
(`main.ts`, a `reply.raw.write` loop with no drain — real, unbounded, but
9 169 MB and 464 MB archives match neither 1 264 nor 4 968 MB, and a fast
disk would fill the queue in seconds, not at 1 MB/s); the orchestrator's
channel (its own loop ≤ 15 ms, its heap 28 MB, and a 4.9 GB backlog at
1.5 MB/s would have stalled its calls for an hour, not the 6 s measured);
the phone's WS (strings, 2 MB/min). The shape that fits — constant rate,
exact-size bodies (`frame-codec.ts` copies a relayed body to its own bytes),
~455 B of JS per ~10.7 KB buffer, ~100 objects/s — is one leg of the audio
plane (5 967 chunks/min at ~13.5 KB on the wire, 85 MB/min per leg) retained
in full, and nothing in hub-main's relay path holds a relayed body past its
response. What names it is the next episode, measured: the ArrayBuffer census
(D444) for the shape, and the queue readings below for the peer.

**What the audio plane costs hub-main, measured.** Per-peer bytes per minute
in steady state: stream-broker → hub 85 (chunk responses), hub → orchestrator
87 (the same responses relayed), orchestrator → hub 84 (`analyseChunk`
requests, ~1 s of PCM each), hub → audio-analyzer ~84. That is **340 of
~470 MB/min** of everything hub-main moves over UDS — essentially every
request byte and 60 % of every response byte — decoded and re-encoded twice.
It is churn, not retention: it feeds GC (the 32 % mutator share V8 died on)
and the brk residue, and removing it buys no live set.

## Decision

1. **Every outbound queue hub-main writes to is read on every heartbeat
   probe, from the channel, whatever the handle's ref state.** The UDS
   children report `socket.writableLength` through `SocketChannel.queuedBytes`
   (`socketQueued=`, `socketQueuedTop=`, and `socketQueuedUnmeasured=` for a
   channel that keeps no reading — unknown is never zero, D393). The mesh
   writer sockets are read from Moleculer's `TcpWriter.sockets` map through
   type guards (`meshQueued=`, `meshQueuedTop=`), and a broker with no such
   map — the `Fake` transporter, a broker not yet built — contributes nothing
   rather than zeros. A sum over `_getActiveHandles()` is never again the
   evidence that a queue is absent.

2. **A queue held at or above 64 MiB for 60 s is NAMED, once per 10 min,
   with its peer, its current and peak depth and its hold; a named queue that
   falls under half the bound, or whose peer vanishes from the readings, is
   reported RELEASED with its peak and hold.** A burst that drains inside the
   window says nothing: backpressure measures liveness, not identity (D444).
   The gate is not a bound — it terminates nothing. A UDS child whose channel
   is destroyed loses every in-flight call, and what to do about a peer that
   holds is decided with the peer named, not before.

3. **A per-process live set is accounted for from two boots of the same
   container before anything is called a leak.** The boot floor and the
   slope are two numbers with two owners; the 1.2.269 process is read again
   at 22 h of age (its reclaim line's `heapUsed=A→B`) and compared with
   2 491 MB.

## Consequences

- None of this ships with `camstack deploy`: `socket-channel.ts`,
  `local-child-registry.ts`, `socket-plane-report.ts`, `heap-watch.ts` and
  the two new modules are `@camstack/system`; the probe wiring is
  `server/backend/src/main.ts`. All ride one published `@camstack/server`
  (D16). Until then the episode owner stays unnamed and the D444 census is
  the only instrument armed.
- The `[mem] hub-main` line grows by two to five fields, APPENDED after
  `socketTop=` so every Loki prefix written since 2026-08-29 still matches.
- The audio plane's cost is now a number on the record. Removing the
  orchestrator relay (analyzer pulls from the broker: −2 legs, −170 MB/min)
  or the whole plane (a child↔child channel, −340 MB/min) buys GC share, not
  live set; the record says so in that vocabulary so it is not bought for
  the wrong reason.
- The backup-download route's unbounded `reply.raw.write` loop is a defect on
  its own and stays open here: it is named, not fixed, because fixing it
  without the disarmed test the rule demands would be a paragraph.

## Enforcement

- `packages/system/src/kernel/__tests__/outbound-queue-watch.spec.ts`: sustain,
  cooldown, per-peer judgement, release on drain and on a vanished peer.
  Disarmed: dropping the sustain check turns five of ten red.
- `packages/system/src/kernel/__tests__/heap-watch-outbound-queue.spec.ts`:
  the line carries `socketQueued=` and `meshQueued=`; a held UDS queue and a
  held mesh queue are each named through the sink and the release is logged.
  Disarmed: dropping `judgeOutboundQueues(at)` from the tick turns both red.
- `packages/system/src/kernel/moleculer/__tests__/mesh-queue-report.spec.ts`:
  the writer map is read, a missing map is `undefined` not `[]`, a throwing
  broker never escapes.
- `packages/system/src/kernel/__tests__/socket-plane-report.spec.ts` and
  `.../transport/socket-channel-queued.spec.ts`: the reading is live, unknown
  is `null`, the window totals and ranks.
