---
id: D716
title: A composed edge never counts the first answer of a source that was down, boot included
status: accepted
date: 2026-10-06
supersedes:
applies-to:
  - packages/system/src/builtins/composer/composition-evaluation.ts
  - packages/types/src/composition/evaluate-field.ts
---

## Context

`rose` disarms after its source was unavailable (the D49 inverse in
`composition-evaluation.ts`): the first answer after a binding flap baselines
the level instead of rising, because a provider restart re-seeds its state.
The D670 amendment (2026-09-29) exempted a field that had NEVER observed a
level — "a source late at boot is not recovering, its first press counts" —
and its tests modelled the late source's first answer as the press itself.

That exemption leaves one door open. The hub boots while Home Assistant is
down; HA comes back and seeds its restored switch `on` with a NEW
`last_changed` (HA restamps a restored state). The composer's first answered
reading is then `on`, stamped after the hub started and inside the 30 s
first-sighting window, and `evaluateSensorLevelEdge` calls it a rise.

Does anything downstream stop it? No. The cap contract derives `onPressed`
from `lastPressedAt` strictly advancing (`fromState: { field, on: 'advance' }`).
The composer's own `strictFiniteAdvance` emits `doorbell.onPressed` on the
bus — every consumer of the event sees a press — and post-analysis'
`SensorTransitionGate.observeAdvance` passes it too: it seeds silently only a
first stamp OLDER than its process start, and this stamp is newer. So the fix
belongs at the composer.

## Decision

**A source that did not answer — since boot or since a flap — gets its first
answer baselined, never counted as an edge.** The `hasObservedRoseLevel`
exemption is removed: any field whose previous outcome said a source did not
answer (unavailable, or held over it, D713) disarms `rose` for its next
evaluation.

An expression that FAILED on answered values is not an outage: it carries
`expressionFailed: true`, its rose memory was never committed, and the next
success compares against the level from before — so a real edge during the
failure still counts. For the same reason D713 does not hold such a field.

## Consequences

- The 09-28 late-at-boot case still counts its first press: in production the
  late source's first answer is its idle level (`off`), which baselines, and
  the press is a real `false → true` transition. The tests now model that.
- Accepted residual, erring toward silence like every first-sighting rule: a
  press that is ITSELF a source's very first answer after an outage (the
  provider registers mid-ring) is not counted.
- The first-sighting freshness rule still applies to a source that answers at
  the composer's very first evaluation.

## Enforcement

`packages/system/src/builtins/composer/__tests__/composition-runtime.spec.ts`:
"source down since boot, first answer a restored ON with a fresh stamp: no
press, no change" (fails with the D670 exemption restored), the two
late-at-boot cases (`{ null, 0 } → { T, 1 }`, `{ T0, 2 } → { T, 3 }`), and
"does not consume rose memory when a later expression node fails".
