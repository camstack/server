---
id: D640
title: A sensor rule fires on the raise, the clear, or both — and a reading that cannot say which still fires
status: accepted
date: 2026-09-26
supersedes:
applies-to:
  - packages/types/src/notification/sensor-raised.ts
  - packages/types/src/notification/alarm-membership.ts
  - packages/addon-post-analysis/src/notification-center/rule-engine.ts
  - packages/addon-post-analysis/src/notification-center/sensor-transition-guard.ts
  - packages/addon-post-analysis/src/notification-center/rule-test-plan.ts
  - packages/addon-admin-ui/src/pages/system/notification-rules.helpers.ts
  - packages/addon-admin-ui/src/pages/system/NotificationRuleConditions.tsx
---

## Context

The operator's live "Allagamento" rule (`sensorKinds: ['flood']`, sensors 3223,
3229, 3235) notified on EVERY transition of a flood sensor: water detected, and
back to dry. The operator wants the alert only. A device-event rule had no way to
name an edge: the transition gate upstream (`sensor-transition-gate.ts`)
deliberately passes both edges, because a timeline marker for a door CLOSING is
something an operator wants to see, and the only edge filter that existed
(`sensorEdge`, [D630](adr-0630-an-arm-is-refused-by-openings-armed-around-only-by-name.md))
is derived, not configured, and applies to alarm rules over openings only.

Rejected alternatives:

- **Reuse `sensorEdge` for every rule.** It is an opening vocabulary
  (`opening`/`closing`/`neither`) read off contacts, covers and locks, and it is
  switched on by the rule BELONGING to the alarm, not by the operator. A flood
  sensor is not an opening, and making every contact rule opening-only would
  have silently changed rules nobody touched.
- **A second "which boolean is HIGH" table keyed by event kind.** One already
  exists, `SOURCE_CAP_ACTIVE_FIELD` (the doorbell's and the recorder's edge
  table, keyed by cap). A second one would diverge on the first cap added — the
  D62 failure. The kind table is DERIVED from it through `EVENT_KIND_BY_CAP`.
- **Fail closed on an unreadable reading.** A flood rule that went silent
  because one slice came back without its boolean is the worst outcome this
  condition could produce; the alarm's `sensorEdgeOf` already fails open for the
  same reason.
- **Prune the key at the hub on a wrong delivery.** The engine would then accept
  a save and ignore the choice without a word. Both editors already prune; a
  payload that still carries it is refused and logged.

## Decision

A device-event rule may carry `conditions.sensorTransition: 'raised' | 'cleared'`;
absent is both edges (no migration). The raise of an event kind is the boolean
its cap's `SOURCE_CAP_ACTIVE_FIELD` names, for kinds whose taxonomy category is
`sensor` (`sensorRaisedOf`, `packages/types/src/notification/sensor-raised.ts`).
The engine filters only a subject that could name its edge: a kind with no raise
or an unreadable slice PASSES, and the `rule matched — enqueueing` line says so
(`sensorRaised: null`). The condition is valid on `device-event` only — the hub
refuses it elsewhere on both save routes — and an editor offers it only when the
rule names at least one sensor kind and every one has a raise
(`sensorTransitionOffered`), pruning it on save otherwise.

## Consequences

- An alarm rule over a contact still fires on the opening edge only (D630 runs
  first): `sensorTransition: 'cleared'` on such a rule never fires. Not refused —
  the alarm-ness of a rule is derived — but the editor WARNS
  (`sensorTransitionNeverFires`; `ruleBelongsToAlarm` was hoisted into
  `@camstack/types` so the engine and the warning share one predicate).
- The linked-camera capture gate (`deviceEventRuleMayFireOnKind`) reads the edge
  too, with the evaluation's predicate: a refused edge takes no mosaic, and an
  unknown edge still captures.
- `presence` (a word), `switch` (category `control`), and every pulse kind
  (doorbell, button, event emitter) have no raise; the choice is not offered for
  them and has no effect if a stored rule carries it.
- The viewer mirrors the condition in a second step. Until it does, a rule
  carrying `sensorTransition` LOSES it when saved from the phone (the viewer
  re-emits `conditions` whole through its own schema). Both mirror guards carry a
  self-expiring `aheadOfViewer` allowance for it, and must lose that line the day
  the viewer ships it.
- `NcTestEventInput` gained `sensorRaised`; the per-rule Test plans a RAISED
  subject for a supported kind (cleared when the rule asks for the clear).

## Enforcement

- `packages/types/src/notification/__tests__/sensor-raised.spec.ts` pins the
  table to the caps' own schemas (a renamed field fails there).
- `rule-engine-sensor-transition.spec.ts` (raised, cleared, absent, unreadable
  and unknown passing); `sensor-transition-guard.spec.ts` and
  `nc-actions.spec.ts` (both save routes); `rule-test-plan.spec.ts`;
  the admin's `notification-sensor-transition.spec.tsx` (visibility, prune,
  announced drop).
- `scripts/check-nc-mirrors-in-sync.ts` now compares the viewer's
  `NcConditionsSchema` keys with the cap's, and
  `scripts/check-viewer-condition-mirror.ts` the `valueType` enum — each with the
  `sensorTransition` allowance that fails once the viewer catches up.
