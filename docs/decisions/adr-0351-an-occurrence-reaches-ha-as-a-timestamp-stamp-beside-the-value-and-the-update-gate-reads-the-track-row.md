---
id: D351
title: An occurrence reaches HA as a timestamp stamp beside the value, and the update gate reads the track row
status: accepted
date: 2026-09-05
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/track-lifecycle.ts
  - packages/addon-post-analysis/src/pipeline-analytics/index.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/track-store.ts
  - packages/addon-provider-homeassistant/src/ha-export/state-projector.ts
  - packages/addon-provider-homeassistant/src/ha-export/entity-catalog.ts
---

## Context

Recognised faces reached Home Assistant only on the lifecycle `end` event —
measured six for six on device 104 (2026-09-05): every `person_last_label`
change landed at `lastSeen + ~33 s` (track TTL 30 s + sweep + push batch),
zero while the subject was still on camera. Two independent causes:

1. **The update gate read only the frame patch.** `maybeEmitTrackLifecycleUpdate`
   fed `evaluateTrackLifecycleUpdate` from `t.labelPatch`, the per-frame tiered
   patch written by frame-riding classifiers. The face recognizer assigns its
   identity over the async detail plane and writes it to the track ROW
   (`applyLabelCandidate`) — never into a frame patch — so the gate's
   `identity` trigger could not fire for a face. Its unit test was green
   because the test hand-fed the label the production signal never fetched:
   the fake supplied the value production forgot to fetch, again.
2. **A repeat of the same identity was invisible end to end.** The push client
   dedups per topic, so an unchanged `person_last_label` never left the hub;
   and an identical value is not a state change in Home Assistant anyway, so
   a state-trigger automation would not re-fire even if it had.

The native home for an occurrence is HA's `event` platform. It was considered
first and refused: no released `camstack/homeassistant-component` builds it —
the negotiated platform list (`component-support.ts`) does not contain it, and
announcing a platform the component cannot construct produces one warning in
HA's log and NO entity, the exact zero-entities failure D152 records. That
repo also ships on its own train, so nothing here may depend on it.

## Decision

Three rules, one per layer:

- **The update gate's label reads the frame patch AND the track row**
  (`resolveLifecycleUpdateLabel`, row side via `trackStore.peekActive`), so an
  identity resolved on the async detail plane emits a `phase:'update'` while
  the subject is still on camera. A newly-entered zone (`zonesVisited` growth)
  is likewise an update trigger: intermediate events ride `update`, never only
  the closing summary.
- **Cadence is per occurrence, never per frame**, and a trigger dropped by the
  debounce is COUNTED and NAMED (`suppressed` on the decision,
  `suppressedSinceEmit` in the memory, one debug line with `deviceId`) — a
  silent throttle is how the 30-second delivery delay stayed invisible.
- **Every `<macro>_last_label` is paired with `<macro>_last_label_at`**, a
  `sensor` with `device_class: timestamp` that moves on EVERY carried
  identification, identical values included. The label value is ordered before
  the stamp in the same batch, so an automation that triggers on the stamp
  reads the fresh label. Automation authors bind their trigger to the stamp
  and read the label — never the reverse.

## Consequences

- Three more enabled entities per exported camera (person/vehicle/animal
  stamps); the pressure-valve guard's expected set names them deliberately.
- Within-track re-confirmations of the same label move the stamp; automation
  authors who want one firing per visit use a `for:`/cooldown, and the
  occurrence unit stays "track × identification".
- The mechanism is macro-generic (faces, plates, animal sub-classes). Motion,
  audio and zone occupancy keep their existing live paths — they already carry
  occurrence edges and were not duplicated.
- Membership still decides which cameras export at all; nothing here assumes
  every camera is exported.
- When a component release ships the `event` platform, the stamp semantics can
  migrate behind the existing platform negotiation — this record is the marker.

## Enforcement

`entity-catalog.spec.ts` (stamp exists for labelled macros only, enabled, and
in the valve's expected set), `state-projector.spec.ts` (stamp always moves on
a repeat of the same label; label ordered before stamp),
`track-lifecycle.spec.ts` (row-fallback label resolution, zone trigger,
debounce suppression counted and reset on emit). All were written first and
proven RED against the pre-change code.
