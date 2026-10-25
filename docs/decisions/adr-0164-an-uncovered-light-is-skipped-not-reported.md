---
id: D164
title: A lighting variant with no reference is SKIPPED, not reported — and every scene knob is reachable
status: accepted
date: 2026-08-15
supersedes:
applies-to:
  - packages/types/src/capabilities/scene-monitor.cap.ts
  - packages/addon-post-analysis/src/pipeline-analytics/scene/scene-engine.ts
  - packages/addon-post-analysis/src/pipeline-analytics/scene/scene-scoring.ts
  - packages/addon-post-analysis/src/pipeline-analytics/scene/scene-monitor-provider.ts
  - packages/ui-library/src/composites/cap-settings/scene-monitor-copy.ts
  - packages/ui-library/src/composites/cap-settings/SceneSettingsForm.tsx
---

## Context

Two findings from the operator's first real scene ("Pannelli", device 102), one
day after the feature shipped.

**1. Every knob existed and none was reachable.** The stored monitor already
carried `enabled`, `triggerMode: 'both'`, `checkIntervalSec: 60`,
`check: { threshold: 0.8, hysteresisCount: 3 }`, `quietSeconds`,
`minObservationSpacingSec`, `emit`, `autoRestore` and `confirm`, and
`updateScene` already accepted a patch for all of them. The editor exposed
**Capture day / Capture IR / Reset / Check now / delete** and nothing else. An
operator whose scene fired too eagerly had exactly one move available: delete it
and draw it again. Tuning knobs that exist and cannot be reached are worse than
absent ones — from the code they read as a shipped feature, so nobody looks
again.

**2. The night reference was mandatory in practice and optional in nobody's
plan.** [`docs/design/scene-state-analysis.md`](../design/scene-state-analysis.md)
§6.2(b) correctly killed the silent cross-condition fallback: a `day` reference
scored against an IR frame collapses the cosine and would latch "the bin was
taken at 21:40" every single night. What it put in its place was
`verdict: 'unknown'` + `unavailable: 'no-reference-for-condition'`, pushed
through `applyEngineResult`, logged at **warn**, and rendered as a "Can't tell"
badge. Correct, honest — and wrong for the operator, because it describes a
scene configured exactly as they meant it as a scene that is failing. Nobody
stands outside at 22:00 to photograph a wheelie bin in infrared, and a great
many scenes are daytime questions ("is the bin on the kerb at 08:00") that never
need a night reference at all. The feature spent every night from dusk to dawn
reporting a fault about work the operator was never asked to do.

The two are the same mistake at different altitudes: a capability the code holds
that the operator cannot exercise, and a choice the operator made that the code
reports as a defect.

## Decision

**A lighting condition with no comparable reference of its own is SKIPPED, and
skipping is a non-event.** Per scene, `onUncoveredCondition` selects:

- **`skip` (default)** — the check is not made. No verdict moves, no
  `unknown` is reported, the latch is not written *in either direction*, and the
  pending hysteresis run is neither spent nor cleared. The engine emits one
  advisory `suspendedCondition` on the transition into that light and one more
  clearing it on the way out; the provider treats a result carrying
  `suspendedCondition` as a **non-observation and writes no latch row at all**.
  The card says *"Paused — nothing was captured in night (ir)"* in the neutral
  tone. Logged at `info`, once per transition, with `tags: { deviceId }`.
- **`judge-anyway`** — score against the other conditions' references, as a
  last resort only (an exact-condition reference always wins). For the installs
  where the two lights genuinely look alike; wrong everywhere else, for the
  reason §6.2(b) gives.

The skip never applies when the scene has **no** comparable reference in any
light: that is "not armed yet", it stays `no-reference-for-condition`, and
silence there would hide the one step the operator has not finished.

**And every knob the model carries is reachable from the scene card** —
`SceneSettingsForm`, one panel per scene, writing the same `updateScene` patch
the provider already owned. No second store, no draft list, no save button
(D62). `check.mode: 'llm'` is deliberately **not** offered: no production caller
supplies `SceneEngineDeps.llm`, so an `llm`-mode scene is permanently
`unavailable`, and the switch would let one click break a working scene. The
vision model reaches a scene through `confirm` instead, which is wired.

## Consequences

- A scene with only a daylight reference now genuinely works: it watches all
  day, sits out the infrared hours, and resumes by itself. That is the shape the
  design doc's own §5.4 copy promised ("capture again in daylight so the scene
  works around the clock") without the engine ever backing it.
- **Detection genuinely stops at night for a day-only scene.** This is the
  cost, and it is the honest one — the alternative was never "detects at night",
  it was "reports a fault at night". The coverage line names it and the
  `judge-anyway` opt-in exists for anyone who disagrees.
- `SceneEngineResult` gains a required `suspendedCondition`, so every
  construction site has to decide rather than inherit. `SceneMonitorSchema`
  gains `onUncoveredCondition` and `suspendedCondition`, both with Zod
  `.default()`s — existing rows migrate on the `SceneMonitorSchema.safeParse` in
  `configFromRecord`, which is the only path a stored scene reaches the engine
  by, so no migration step is needed.
- **Train-bound.** The two new fields and the patch member live in
  `@camstack/types`; the engine, provider and UI behaviour deploy, but an older
  `@camstack/server` will strip the new fields on the cap path.
- The latch is now written by strictly fewer paths than before, which is the
  right direction for the one fact nothing else in the system can regenerate.

## Enforcement

- `scene-engine.spec.ts` — a describe block pins all five properties of the
  skip: no verdict change, once per transition, self-resume, hysteresis credit
  preserved across the dark, and `judge-anyway` scoring instead of skipping.
  Neutralising the branch (`false` in place of the condition) reddens two of
  them.
- `scene-monitor-provider.spec.ts` — *"a SKIPPED check writes no latch at all"*
  compares the whole latch row before and after. Neutralising the early return
  in `applyEngineResult` reddens it.
- `scene-scoring.spec.ts` — a PAIR: the default still refuses to fall back, and
  the opt-in falls back but never beats an exact-condition reference. One
  without the other would let a regression through in one direction.
- `scene-monitor-copy.test.ts` — asserts the card never reads as a fault for a
  missing IR reference: `badgeFor` returns the neutral `Paused`, the coverage
  line says "optional" and not "can't tell", and a held flag still outranks a
  pause.
- Nothing guards "every model knob is reachable from the UI" — review only, and
  it is worth writing down, because this ADR exists precisely because that went
  unnoticed for a release.
