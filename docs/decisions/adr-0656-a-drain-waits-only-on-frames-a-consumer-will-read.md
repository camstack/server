---
id: D656
title: A teardown drain waits only on frames a consumer is still going to read — a frame parked for a late crop does not hold the worker
status: accepted
date: 2026-09-27
supersedes:
applies-to:
  - packages/addon-pipeline/src/session-decode/session-decode-coordinator.ts
  - packages/addon-pipeline/src/session-decode/local-frame-registry.ts
  - packages/addon-pipeline/src/session-decode/on-demand-jpeg-fallback.ts
  - packages/addon-pipeline/src/session-decode/video-frame-generator.ts
  - packages/addon-pipeline/src/session-decode/retained-frame-store.ts
  - packages/addon-pipeline/src/session-decode/retained-content-fallback.ts
  - packages/addon-pipeline/src/pipeline-runner/retained-reader-hold.ts
  - packages/addon-pipeline/src/pipeline-runner/index.ts
---

## Context

D652 made a planned teardown drain: the coordinator stops the worker decoding
and kills it only once every image it yielded has been closed and every read
and crop already sent has been answered, bounded by
`SESSION_DECODE_DRAIN_BOUND_MS` (1 500 ms). It shipped in @camstack/server
1.2.394 / addon-pipeline 1.2.296 and removed the decode losses (0 `exited
before toBuffer`, 0 `runInference failed` in the 40 min after).

It also started a new WARN: `drain bound expired — killing the worker with
frames still held` fired about 80 times in those 40 min, and 99 times in the
hour to 09:28, on every node. Every line had `pendingReads=0 pendingCrops=0`
and `unsettledFrames` between 1 and 20. So almost every teardown waited the
whole 1.5 s, holding the node's live-worker slot (D652 returns it on the
process exit) for frames nobody read.

The "frames still held" were not frames anybody was going to read. D652
counted an image as held from the moment it was yielded until `close()`, and
the local frame registry closes an image only when its LAST reference drops.
For every frame with a detection, the runner's result callback
(`OnDemandRetentionSession.noteInferenceResult`) parks an on-demand JPEG
fallback in `RetainedFrameStore.rememberOnDemand`. That fallback takes a
registry lease at creation (`createOnDemandJpegFallback`) and keeps it until
post-analysis asks for the frame (`materialize`) or the store or the registry
evicts it (the registry's 24-frame bound, the store's byte budget). The runner
then releases its own owner reference, and the frame stays open under the
fallback's lease alone. `openImages` therefore counted every recent detection
frame of the session: 1–20, never read before the kill.

The registry itself holds nothing past its last reference (an entry at
`refs === 0` is dropped at once), and the worker's hold ring and tile stores
are on the worker's side of the channel, not open images. The fallback lease
was the only long-lived reference.

## Decision

**A drain waits on a frame only while a CONSUMER holds it** — somebody who is
going to read it while the worker lives: the owner reference the pump takes at
`register` and hands to the runner (queued, in flight, an awaited burst frame
before its `onSettled`), and every lease a reader takes to resolve a view.
A reference that only PARKS the frame for a read that may come later is
`retention` and does not hold the worker.

1. `LocalFrameRegistry.acquire(ref, holder)` takes a `FrameHolder`
   (`'consumer'`, the default, or `'retention'`); the entry counts its
   consumer references, and the image is told on each transition
   (`FrameImage.setPendingConsumer`): false when the last consumer lets go of
   a frame a retention lease keeps, true when a consumer comes back to it. A
   drop needs no signal — the image is closed.
2. `createOnDemandJpegFallback` takes its lease as `'retention'`. Nothing else
   parks a lease: every other `acquire` belongs to a reader (a pipeline
   invocation's root resolver, the motion view, an evidence or recovery crop)
   and is released when its read is done.
3. The coordinator splits its open images into `consumerImages` and
   `retainedImages`. A drain waits on consumer images, reads already sent and
   crops already sent; a teardown with only retained images kills at once.
4. **A retained frame whose read STARTED is a reader.** `materialize` sends a
   `toBuffer`, which is a pending read like any other and is waited for.
5. Every drain line (the bound WARN, the death-while-draining WARN) carries
   `consumerFrames`, `retainedFrames`, `pendingReads`, `pendingCrops` with
   `tags:{deviceId}`; the old `unsettledFrames` is gone. The bound WARN now
   means a consumer frame, read or crop really was abandoned. Retained frames
   dying with the worker are a debug line (`retained frames die with the
   worker`), since that happens on every teardown after a detection. A late
   request that finds one gone is already logged by name
   (`native full-frame miss — the retained store no longer holds this frame`).

### Why retained frames are not worth the worker

The fallback is read on one path only: a FULL-FRAME request that already
missed the native lease and the subject tile (`getNativeCrop` →
`ram-fullframe` → `RetainedFrameStore.cropAsync`). Post-analysis's crops
arrive 2.2–9.9 s after the frame (D652), past any bound worth holding a
worker, and D652 already refuses a native crop asked after the teardown for
that reason. The drain window could rescue such a read only by accident, when
the request happened to land within 1.5 s of the teardown. On the hub, the
`native full-frame miss` WARN that such a lost read produces ran about 47–54
per hour before the release (07:00–08:30) and about 38 per hour after it
(08:30–09:28, drain active), so the accidental window did not show as fewer
misses. A lost read after this change produces the same WARN, so the claim
is checkable (Enforcement).

Releasing the retained leases at drain start was rejected: while the worker
lives they can still be served, and the drain may stay open for a consumer.
They are simply not waited for.

### Fix round 1 — a read in progress is a consumer, across both rungs

`getNativeCrop` reads a frame in two rungs: a native crop, then, on a miss,
the retained full-frame fallback (`cropAsync` → hydrate → `materialize` →
`toBuffer`). The crop's miss reply settles the worker's last pending request
and calls `settleDrainIfDone()` in the same turn. The fallback's `toBuffer`
is only sent on a later microtask. On a retention-only frame the drain killed
the worker in that gap. That is a D652 regression: a read the runner had
already started was destroyed.

The rule is not a timing trick: **`getNativeCrop` holds the parked frame as a
`consumer` for both rungs** (`withRetainedReader` →
`RetainedFrameStore.holdReader` → the fallback's `holdReader`, which is a
consumer lease), released in a `finally`. A frame whose bytes are already in
RAM, or that has no fallback, needs no hold.

Once the kill is sent, a `toBuffer` is refused by name
(`SessionDecodeReadRefusedError`, `TO_BUFFER_REFUSED_KILLED`; after the exit,
`TO_BUFFER_REFUSED_EXITED`). A read during a drain is still served, since
serving it is the drain's purpose. Refusing on `stopRequested` alone, as a
native crop is, would refuse the queued frames' inference that D652 drains
for. `retained-content-fallback.ts` turns a failed or refused read into
`null`, which the caller counts (`noteMiss('fallback')`) and logs (`native
full-frame miss`). `on-demand-jpeg-fallback.ts` already did.

## Consequences

- A teardown after a detection no longer waits 1.5 s for nothing. The worker
  goes as soon as its consumers settle, often at once, and the live-worker slot
  comes back that much sooner at the node ceiling.
- A full-frame fallback read arriving in the first 1.5 s after a teardown is
  no longer served by accident. It misses, by name, as it already did after
  the bound.
- `FrameImage.setPendingConsumer` is optional. Only the session-decode
  coordinator implements it, and only the registry calls it. A source without
  it behaves as before.

## Enforcement

`session-decode-drain-retention.spec.ts` drives the real pump, coordinator,
registry and `createOnDemandJpegFallback` against a scripted child, in
production order (fallback parked, then the owner released). A teardown with
only retained frames kills at once with no WARN. A queued consumer frame keeps
the drain open while retained ones do not. A consumer that never settles hits
the bound, and the WARN counts `consumerFrames` apart from `retainedFrames`. A
retained read that started is waited for. `local-frame-registry.spec.ts` pins
the holder transitions. Disarmed and seen red: the fallback lease taken as a
consumer (3 red), the drain counting retained frames (2), the drain ignoring
consumer frames (7, D652 cases included), the bound never armed (2), the
registry never signalling the last consumer (4). Fix round 1 adds: a native
miss that falls back to the retained frame is served before the kill
(disarmed: `withRetainedReader` taking no hold, and the fallback's
`holdReader` holding nothing, each red); a reader re-acquiring a parked frame
holds the drain from its `acquire`, before any read (the `noteImageHolder(true)`
branch inert: red); a retained image closing does not release a drain a
consumer holds (`noteImageClosed` ignoring the split: red); a read after the
kill is refused by name and the retained fallback returns a miss (refusal
removed, and the fallback's catch removed: each red). The `getNativeCrop`
call site itself has no harness. Its one line is covered by review.

Live, passively: `drain bound expired` per hour should fall from ~99 to near
zero, and `native full-frame miss` per hour should not rise above its ~40–50
baseline.
