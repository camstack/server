---
id: D507
title: A camera runs at most one root detector
status: proposed
date: 2026-09-15
applies-to:
  - packages/types/src/capabilities/pipeline-runner.cap.ts
---

## Context

`detectionSources` was a list, and a list can say "both". Nobody had asked for
both, and it was never free:

- Both planes feed the SAME per-device stationary registry, so the same parked
  object can be promoted twice. It merges rather than duplicating (D495), but
  only because a guard written for a different reason happens to cover it.
- The two detectors disagree about the same box by construction, which is
  exactly the disagreement D505 had to arbitrate — the ML re-detect overruling
  the firmware. On a dual-root camera the ML is a root in its own right, so the
  arbitration has to branch on which root is asking.
- Every parity fix of 2026-09-15 had to reason about the dual case separately,
  and none of it was exercised by a single camera on a single fleet.

Measured on this fleet over six hours of attaches: 3327 `["pipeline"]` and 2
`["onboard"]`. Not one camera had two. The capability existed only in the type.

## Decision

A camera runs AT MOST ONE root detector. `DetectionSourcesSchema` accepts zero
or one, and a stored longer value is TRUNCATED to its first element rather than
refused.

Truncation and not refusal, because this schema validates a cap input on the
attach path: a stored value that suddenly fails to parse takes the camera dark,
which is a fail-closed in the one direction that costs an operator their
cameras. The wire stays tolerant; the type is exact.

AT MOST one, not exactly one. The EMPTY list is a legal, deliberate pick — a
camera an operator left with no root detector — and `planDetectionSources` has
said so since it was written: inventing a root for them is how a default acts
without anybody choosing it. This was tightened to `length(1)` first and the
suite caught it.

The array SHAPE survives because the stored settings, the attach payload and
the device-settings UI already speak it everywhere. Changing the field to a
scalar is a rename across five packages for no behaviour.

Separately, `TrackSourceSchema` gains `'onboard'`. It was missing while
`DetectionSourceSchema` already had it, so a persisted onboard track failed
`safeParse` on read and came back with NO source — which `isSpatialTrack` then
admitted through its `undefined` arm rather than by anybody's decision, and
which `excludeSources` could not name. `isSpatialTrack` now allow-lists it
deliberately, which is what that function's own note asks for.

## Consequences

- The dual-root branch disappears from every parity question. D505's
  arbitration no longer needs "unless the ML is also a root here".
- An operator who had picked both — nobody, on any fleet we can see — silently
  keeps the first. That is the one behaviour change, and it is why the
  truncation is logged nowhere: it cannot happen on a value anybody has.
- `excludeSources` can now name an onboard track, and the spatial subsystems
  admit it on purpose instead of through the `undefined` arm.

## Enforcement

`one-root-detector.spec.ts`: the two single picks, the legacy two-root
truncation in both orders, and the empty pick which must stay legal.
`device-detection-settings.spec.ts` now asserts the normalisation end to end
through `resolveDetectionSettings`. `query-sources.spec.ts` enumerates the
enlarged source set, so a future addition to `TrackSource` cannot silently pass
the "excluding everything is impossible" case.
