---
id: D254
title: A durable reconcile reads the column its live gate decides on
status: accepted
date: 2026-08-27
supersedes:
applies-to:
  - packages/addon-pipeline/src/recorder/object-trigger.ts
  - packages/addon-pipeline/src/recorder/addon/recording-controller.ts
  - packages/addon-pipeline/src/recorder/addon/index.ts
---

## Context

The recording trigger path is deliberately two-sided (D8/D11): an event opens a
window fast, and an RPC reconcile rebuilds the same windows from persisted rows,
because a window the keep gate never learned about means every segment of that
episode is unlinked and the footage is gone.

The object-detection trigger added on 2026-08-27 qualifies on a discriminator:
only `source: 'pipeline'` detections open a window. `onboard` — the camera's own
AI — is refused, because it never passes through the executor and therefore
never met `enabledMacroClasses`, the per-macro confidence floors or the
full-frame guard. Recording on it would mean the operator's sliders describe one
detection and the recording follows another.

The plan for that work specified the reconcile as
`getObjectEvents({ …, projection: 'slim' })` filtered by
`(event.source ?? 'pipeline') === 'pipeline'`. Both halves are individually
correct and together they are a silent defect: `SLIM_OBJECT_COLUMNS`
(`addon-post-analysis/.../store/event-store.ts`) does not select `source`, so
every slim row arrives with `source` absent, the `?? 'pipeline'` reads that as
pipeline, and the reconcile folds ONBOARD rows — re-opening from SQL exactly the
windows the live gate declined, on a beat that runs per camera for ever. It
type-checks, it has no failure mode a test on the pure functions can see, and
the symptom is the one this whole track exists to prevent: two truths about one
detection.

## Decision

A durable reconcile must read every column its live gate decides on. Choosing a
narrower projection is only permitted after checking that projection's column
list against the fields the qualification reads; when the two disagree, the
reconcile takes the wider projection, and says why at the call site. A
qualification that the reconcile cannot apply is not a reconcile — it is a
second, weaker authority over the same footage (D62).

The same rule forbids a reconcile that covers only some of a source's cases.
Where the durable rows cannot express the live qualification at all, the source
travels on the event path only and the code NAMES the gap: the sensor trigger's
`SensorEvent` rows are LEVEL, not EDGE, and — measured on 2026-08-27, not
eyeballed — `binary`, a source cap, has no entry in `CAP_TO_KIND`, so its edges
never reach that table. Nine source caps out of ten reconciled reads as ten.

## Consequences

- `loadObjectEvents` pays the `full` projection: `bbox`, `zones` and the tiered
  label JSON per row. Bounded — only bands that list `objectClasses` reach it,
  `classFilter` narrows to one class, `limit` caps the rows — but it is a real
  cost, and a future slim variant that carries `source` is the right fix, not
  dropping the filter.
- Audio and sensor have no durable half, and `reconcileTriggerHistory`'s
  docblock states which sources it covers and why the others are absent. That
  paragraph is load-bearing: without it the method reads as covering everything.
- Adding a fifth trigger source means answering this question again before
  writing its reconcile.

## Enforcement

Review only, plus one guard that catches the adjacent failure rather than this
one: `scripts/check-recording-trigger-fed.ts` (CI) proves every key of
`RecordingTriggersSchema` has a real `onTrigger` feed, so a source cannot ship
authorized-but-dead. It does NOT check the reconcile's projection — nothing
does. The protection here is the call-site comment naming
`SLIM_OBJECT_COLUMNS` by name, so the next person changing that projection is
reading the reason before the code.
