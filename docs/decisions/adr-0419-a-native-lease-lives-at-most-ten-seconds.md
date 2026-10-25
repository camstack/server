---
id: D419
title: A native crop lease lives at most ten seconds, and the registry refuses the rest
status: superseded
date: 2026-09-09
supersedes:
applies-to:
  - packages/addon-pipeline/src/session-decode/native-crop-lease-age.ts
  - packages/addon-pipeline/src/session-decode/native-crop-registry.ts
---

## Context

Mac agent node (`MacMiniAgent.localdomain`), 2026-09-09, a 54-minute window:
**332 `native crop miss` lines, every one of them `worker-lease-gone`, at a
median `handleAgeMs` of 30 099 ms**. The node-wide `NativeCropRegistry` sat
pinned at `registrySize 4096 / registryCap 4096` for the whole window. Measured
consequence: on track `d64ace88` (device 111) the frontal-face frames never
reached the face detector, because every native fetch missed, and the operator
marked the track as "the best shot was wrong".

The instinctive read of that line is "the registry is full, raise the cap", and
it is wrong twice. It keeps more full-resolution surfaces alive (real RAM, on a
ring that has leaked a VAAPI surface pool before — see `native-frame-ring.ts`),
and it only moves the threshold at which the same pinning returns. It also
cannot work: the decode worker expires a frame's tiles at `NATIVE_TILE_TTL_MS`
(30 s), so a handle 30 s old has nothing behind it at any registry size. The
repo's standing rule is to remove the cause of allocation, not raise a ceiling.

Who was asking that late, traced through the code:

- **`TrackDetailDispatcher`** (`addon-post-analysis`
  `pipeline-analytics/detail-dispatcher.ts:364`) runs a per-device
  `setInterval` at 1 Hz whose `DetailScheduler` retry/periodic requests have
  `maxPerTrack = Infinity`. Since D397 a *coasted* frame no longer refreshes a
  track's frame association (`detail-dispatcher.ts:280`), so a track that stops
  being matched keeps its **last matched handle frozen for the rest of its
  life** while the tick keeps re-dispatching against it. Its give-up bound
  (`MAX_CONSECUTIVE_FRAME_MISSES = 3`) is bypassed whenever the ≤640 rung
  answers with an empty detection list, which resets the counter. That is the
  ~1 Hz re-ask of a dead handle, and it was the suspicion; it held.
- **The two `keyFrame` capture sites** (`pipeline-analytics/index.ts:9365`
  `persistKeyFrames`, `:9304` `offerGroupShot`) are the only `CaptureScheduler`
  requests that omit `staleAfterMs`; every other site passes
  `ENRICHMENT_CAPTURE_STALE_MS = 3_000`. A queued keyFrame therefore holds its
  handle until the 3-slot lane drains, and the code already records landing 8 s
  late (`index.ts:9414`). The confirmation gate had the same defect and was
  fixed on 2026-08-30, having measured `handleAgeMs` up to **32 847 ms**.

## Decision

**A native crop lease lives at most `NATIVE_CROP_LEASE_MAX_AGE_MS` (10 s), and
the bound is enforced by `NativeCropRegistry`.** A lookup for a handle
registered longer ago than that returns `expired`: the entry is dropped, its
worker-side lease released, and the requester closure is **never invoked** — no
IPC to the decode worker, no tile-store scan, no encode. The caller takes the
detection-frame fallback that `native-frame-ring.ts` calls free and expected.
`register` additionally sweeps expired entries from the head, so a lease is
released when it stops being useful (10 s) instead of when 4 095 later handles
push it out of a capacity eviction (~30 s on this cluster).

The bound lives at the registry and nowhere else, for a reason that is not
stylistic: **it is the only place a handle's registration wall-clock exists.**
`FrameHandle` carries no correlatable clock (`pts` is explicitly process-local
and must never be compared against another), so a requester-side bound would
have to be a hand-copied number owned by another addon — the failure mode this
repo names in `native-lease.ts` — and would measure the requester's own receipt
time, which by construction misses exactly the queue delay that produced the
30 s asks. A worker-side bound is the round trip we are trying not to pay. The
registry is also the single node-wide chokepoint every native path funnels
through (the `getNativeCrop` cap, `getNativeCropForDetail`, `runDetailSubtree`
rung 1), so one rule covers all of them with no second owner.

Ten seconds is comfortably above every measured *legitimate* ask: p50 367 ms,
p90 4.3 s, and the tile TTL's own sizing note gives 2.2–9.9 s as the observed
range. What it refuses is the tail the operator judged meaningless.

## Consequences

- An ask between 10 s and the worker's 30 s tile TTL that would have hit a
  retained tile is now refused. On the measured node that set was 332/332
  misses, but it is not empty in principle, and this is the cost being accepted.
- `handle-expired` joins `NativeCropMissReason`, and the runner logs it under a
  **different message** — `native crop refused — the handle is past the lease
  age bound` — with `tags: { deviceId }`, `handleAgeMs` and `leaseMaxAgeMs`. A
  miss ("the frame was gone when we asked") and a refusal ("we declined to ask")
  must never share a word again; sharing one is how 332 lines read as one number.
- Not a knob, deliberately: it is a property of the pipeline, not of a node's
  hardware, so a per-node value would make the same camera produce different
  crop quality depending on placement (same argument as the lease knobs).
- **D58 is unaffected.** The passes that must retry until media LANDS re-run
  over *stored* media through `runStatelessStep` — `rebuild-detail-request.ts`,
  `embedding-rebuild.ts`, `face-reembed-pass.ts` all send `frameJpeg` from the
  persisted key frame and never call `getNativeCrop`. The live "until it lands"
  retries (`key-frame-retry.ts`, 3 × ≥2 s; the per-frame thumbnail) fire on a
  **later frame**, i.e. a fresh handle whose age is ~0, so the bound never sees
  them. Nothing that lands today stops landing because of this.
- **Left open, on purpose:** the two caller-side defects above. Giving the
  keyFrame sites the existing 3 s `ENRICHMENT_CAPTURE_STALE_MS` would drop
  queued captures whose handle is still inside the 10 s bound, and bounding the
  detail dispatcher's `maxPerTrack` would suppress rungs 2 and 3 as well as
  rung 1 — both are behaviour changes that need their own measurement, and the
  refusal line added here is what will produce it (`handle-expired` per
  `deviceId` is now countable).

## Enforcement

`packages/addon-pipeline/src/session-decode/__tests__/native-crop-lease-age.spec.ts`
pins the bound, its inclusive boundary (10 000 served / 10 001 refused), the
release-on-expiry and the sweep, using the measured 30 099 ms.
`packages/addon-pipeline/src/pipeline-runner/__tests__/native-crop-age-refusal.spec.ts`
pins that the worker is never asked and that the refusal is a distinct,
`deviceId`-tagged log line. Both go red when the comparison in
`classifyNativeCropLeaseAge` is removed — verified, not assumed.
