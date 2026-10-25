---
id: D906
title: A paired system event is one class — both edges on an instant rule, the bad state on a summary
status: accepted
date: 2026-10-22
supersedes:
applies-to:
  - packages/types/src/notification/system-event-classes.ts
  - packages/addon-post-analysis/src/notification-center/rule-store.ts
  - packages/addon-admin-ui/src/pages/system/notification-system-events.ts
  - packages/addon-admin-ui/src/pages/system/notification-system-event-field.tsx
---

## Context

The rule editors listed every system event kind as its own checkbox, so an
operator could pick `stream-offline` without `stream-online`, and several kinds
were split on purpose so that a "stall only" rule would not announce recoveries.
On 2026-10-22 the operator asked for the opposite: an outage told without its
end leaves every alarm open-ended on the phone. Events that come in pairs must
be ONE choice, notified on both fronts. A scheduled summary is a different
question: "what is broken right now", never a list of changes.

## Decision

`NC_SYSTEM_EVENT_CLASS_SPECS` (`@camstack/types`) groups the paired kinds into
classes: a bad edge and a recovery edge of one condition (device, stream and node
connectivity, the device switch, battery, consumables, tanks, recording health,
storage space, critical alerts, rule health). One-edge kinds stay single.
Nothing new is stored: a rule keeps listing edge kinds.

- On an INSTANT system rule a class means BOTH edges. A stored instant rule
  that lists one edge of a class is read as the class (`withSystemEventClasses`,
  applied on load and on every write in `NcRuleStore`, logged once per rule). A
  bad edge brings the class's recovery, a recovery brings its bad edges, and a
  bad edge never brings a sibling bad edge (`storage-location-critical` does not
  start hearing `storage-location-low`). A `mixed` rule is left alone.
- On a SCHEDULED STATE SUMMARY a class means the bad state at the scheduled
  time. Such a rule is never widened; the editor labels each class as a snapshot
  ("Streams offline now") and says that the summary sends what is in the bad
  state, not each change. The summary already reports state per kind group
  (D647). Recording health, storage space, critical alerts and rule health have
  no state source in it, and the editor says so ("no state snapshot, reports
  nothing") rather than inventing one.
- Recovery texts read as recoveries ("back online", "recording again").

## Consequences

- Existing instant rules start receiving the recovery of the classes they name.
  This is the operator's request.
- The viewer gets the class chips with the next types publish and its OTA
  (until then it lists edges, and a save from it keeps the hub's widening).

## Enforcement

`system-event-classes.spec.ts` (one family per class, both edges, no sibling
bad edge, idempotent, summary and mixed rules untouched),
`rule-store-event-classes.spec.ts` (a one-edge instant rule matches the
recovery, a save writes the class, a summary rule is never widened) and the
admin field specs (one checkbox per class, both edges written, snapshot meaning
on a summary).
