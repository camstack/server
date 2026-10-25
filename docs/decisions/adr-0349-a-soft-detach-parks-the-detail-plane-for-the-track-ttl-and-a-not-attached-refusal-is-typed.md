---
id: D349
title: A soft detach parks the detail plane for the track TTL, and a not-attached refusal is typed
status: accepted
date: 2026-09-04
supersedes:
applies-to:
  - packages/addon-pipeline/src/pipeline-runner/detail-park.ts
  - packages/addon-pipeline/src/pipeline-runner/detail-subtree.ts
  - packages/addon-post-analysis/src/pipeline-analytics/detail-refusal.ts
  - packages/addon-post-analysis/src/pipeline-analytics/detail-dispatcher.ts
---

## Context

`runDetailSubtree: camera is not attached — no detail steps to run` fired
fleet-wide at ~600–900/h (dominated by `face-detection`/`face-embedding`, also
`clip-embedding`, `plate-detection`/`plate-ocr`, `vehicle-classifier`), paired
with `native full-frame miss` (`nativeMissReason: no-registry-entry`). Net
effect: person tracks that appear near the end of an on-motion session were
never embedded.

The first hypothesis — mis-routing — was disproved by measurement: over a 12 h
sample the node named inside the frame handle and the node emitting the
refusal matched **5000/5000**. The dispatch is correctly pinned to
`frame.frameHandle.nodeId`; do not touch the pin. The fault is
timing/lifecycle: an on-motion session ends (`motion_cleared`, or the D261
stillness test), the runner's soft detach does `attached.delete(deviceId)`,
but post-analysis closes tracks only 30 s after `lastSeen`
(`track-store.ts` `ttlMs: 30_000`), so `TrackDetailDispatcher`'s 1 s tick kept
dispatching for still-live tracks and every dispatch died at
`resolveDetailChildSteps` → `this.attached.get(deviceId)` → refusal.
Reconstructed against attach intervals: 70% of refusals came < 5 s after the
last detach on the emitting node, 93% < 15 s, 99.9% < 35 s — the signature of
post-analysis tracks (30 s TTL) outliving their session. Worse, each refusal
came back as an indistinguishable `null`, so the dispatcher then burned two
more doomed RPCs — a full-frame fetch against a store that no longer held the
frame, and a native-strict `captureCrop` against the same missing lease —
before `onFrameMiss` finally counted one miss.

The two naive fixes are both wrong and both were already rejected:

- Inflating a retention/lease TTL — rejected in
  [D73](adr-0073.md). The pixels are not the missing piece; the STEP-TREE
  LOOKUP is.
- Changing the pin — the pin is proven correct.

What actually holds the pixels across a soft detach was verified in code
before building: `retention?.forgetDevice` drops only PENDING admissions
(`on-demand-retention.ts`) — it never purges the `RetainedFrameStore` or the
subject tiles. The tiles live in the DECODE WORKER, which the soft detach
already parks warm for `DETECTION_KEEPWARM_MS` (15 s, D282); the
`NativeCropRegistry` entry that addresses them is evicted only by node-wide
LRU pressure (cap 256, measured pinned full). So for the dominant early bucket
(70% < 5 s) the pixels were still THERE — only the step resolution refused.

## Decision

Two rules, one per side of the wire:

1. **A SOFT detach parks the camera's detail step tree (and elected
   `deviceKey`) for `DETAIL_PARK_GRACE_MS` = 30 000 ms**, aligned to the
   post-analysis durable-track TTL. `resolveDetailChildSteps` answers from the
   park when the camera is not attached and the park is fresh; the crop ladder
   then resolves against whatever pixels remain (warm worker tiles, retained
   store). The window is bounded twice — an unref'd expiry timer AND a lazy
   clock check on every read — and a parked entry is dropped on hard detach,
   on re-attach, on shutdown, and at expiry. No pixel lifetime changes: this
   is not D73's TTL inflation by another name.

2. **The not-attached case is a TYPED refusal, not a `null`.** The pure
   subtree impl returns `{ refusal: 'not-attached' }`
   (`DetailNotAttachedRefusal`), and the cap method converts it to a thrown
   error whose message carries `runDetailSubtree-refused:not-attached`
   (`detail-park.ts`). It crosses the wire as an ERROR because it cannot cross
   as a field: the cap output schema (`z.object({ details }).nullable()`) is
   Zod-parsed on the hub route and unknown keys are stripped — a result field
   would need a `@camstack/types` + codegen + server-train change. The
   dispatcher (`detail-refusal.ts`, twin marker constant — addons never import
   each other) recognises the marker in any rung's catch, skips the remaining
   rungs, and feeds exactly ONE `onFrameMiss`, so the bounded give-up
   (3 consecutive misses) abandons the step instead of burning 3 RPCs per
   tick.

## Consequences

- End-of-session tracks get their face/clip/plate enrichment for up to 30 s
  after the session closes — bounded by which pixels survive (tiles ≈ 15 s
  behind the warm worker, retained full frame ≈ 3 s, registry LRU pressure).
  Between pixel death and grace end, dispatches still resolve steps and walk
  the ladder as before (bounded by the D73 give-up).
- Version skew is tolerated in both directions: an old dispatcher treats the
  marker error like any primary-call failure (falls through to the fallback
  rungs — today's behaviour); a new dispatcher against an old runner never
  sees the marker. Deploy addon-pipeline before addon-post-analysis (the D89
  order) to keep the mixed window short.
- The marker string is duplicated in the two packages (the same way
  `composeDetailSteps` mirrors the catalog chain). Changing it in one place
  silently reverts the dispatcher to the three-RPC behaviour — keep
  `detail-park.ts` and `detail-refusal.ts` identical.
- The `camera is not attached` warn remains the runner-side metric line; the
  dispatcher adds a throttled
  `detail dispatch refused: camera not attached (park grace lapsed)` warn so
  the dropped-work branch is never silent.
- A camera whose next session opens on a DIFFERENT node still benefits: the
  refusal-emitting node is the one that soft-detached, so its park covers the
  asks pinned to its own frames.

## Enforcement

- `detail-park-soft-detach.spec.ts` (addon-pipeline): in-grace dispatch after
  a soft detach resolves parked steps and cuts from the retained tile;
  grace+1 ms gets the typed refusal (the bound); hard detach purges
  immediately; the park map is cleared on expiry, re-attach and shutdown.
  The in-grace test was proven RED before the fix and proven to fail again
  with the park consult reverted.
- `detail-not-attached-refusal.spec.ts` (addon-post-analysis): a refusal
  skips both fallback rungs, and abandonment after exactly 3 dispatches
  proves one `onFrameMiss` per refusal.
- The grace value is pinned as a literal in the spec so moving
  `DETAIL_PARK_GRACE_MS` away from the track TTL breaks a test and forces the
  alignment to be re-argued.
- The marker twin constants: nothing checks them mechanically — review only.
