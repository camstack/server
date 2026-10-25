---
id: D688
title: A frame handle refused as expired is retired by the caller, never named again
status: accepted
date: 2026-09-30
supersedes:
applies-to:
  - packages/addon-pipeline/src/pipeline-runner/detail-park.ts
  - packages/addon-pipeline/src/pipeline-runner/detail-subtree.ts
  - packages/addon-post-analysis/src/pipeline-analytics/detail-refusal.ts
  - packages/addon-post-analysis/src/pipeline-analytics/detail-dispatcher.ts
covers:
  - packages/addon-pipeline/src/pipeline-runner/index.ts
---

## Context

On 2026-09-30 the runners logged `native crop refused — the handle is past the
lease age bound` (`reason=handle-expired`) 954 times in two hours: seven
cameras, all three nodes, ~7 lines per handle, handle ages 30.0–35.2 s. Every
line was the post-analysis detail dispatcher. A coasting track's frame
association is frozen (D397), so each periodic tick re-dispatched the track's
steps against the same handle, and each dispatch named it twice — rung 1
(`runDetailSubtree({ frameHandle })`) and rung 3 (`captureCropBase64`, which is
native-strict against the same handle). Only the scheduler's three-miss
give-up (`MAX_CONSECUTIVE_FRAME_MISSES`) ended it, per step.

The dispatcher could not do better: the runner answered a refused handle with
the same bare `null` it uses for "this dispatch found no pixels", and a `null`
does not say that the HANDLE is finished. Raising the lease bound would only
move the same loop later.

## Decision

When the only pixel source a detail dispatch named is a handle the lease
registry refused as expired, the runner says so, typed: `runDetailSubtree`
returns `{ refusal: 'handle-expired' }` internally and the cap method throws an
error carrying `runDetailSubtree-refused:handle-expired` (twin constants in
`detail-park.ts` and `detail-refusal.ts`, the same wire shape as D349's
not-attached refusal, for the same reason: the output schema strips unknown
keys). On that refusal the caller retires the handle for the track: it is
removed from the stored frame association, so neither rung 1 nor the
native-strict crop rung names it again; the parked frame (D422) still serves,
on the same dispatch; a newly OBSERVED frame brings a fresh handle. The
retirement is logged once per (track, handle), `tags: { deviceId }`,
`reason: handle-expired`, with the handle spelled as the runner spells it.

Every other native miss stays a `null`. Only the registry's own refusal is
final for a handle; anything else is not promoted into one.

## Consequences

- A refused handle costs one runner line per track instead of ~7.
- An old runner with a new dispatcher behaves as before (a `null`, bounded by
  the scheduler); a new runner with an old dispatcher throws an error the old
  dispatcher treats as a failed primary and falls through its ladder, as it did
  for any transport error — no worse than today.
- The lease bound (`NATIVE_CROP_LEASE_MAX_AGE_MS`) is unchanged.

## Enforcement

Tests: `detail-crop-ladder.spec.ts` (5)/(6) and
`detail-park-soft-detach.spec.ts` (2b) pin the runner half, including the wire
literal; `detail-handle-expired-refusal.spec.ts` pins the dispatcher half (the
refused handle is named exactly once, rung 3 is never asked, the log line fires
once with the camera tag, a fresh frame restores the native rung). The twin
constant is review only.
