---
id: D337
title: A reading nobody has taken is null, and the key a stored pick is matched on must exist in every projection
status: accepted
date: 2026-09-04
supersedes:
applies-to:
  - packages/types/src/capabilities/battery.cap.ts
  - packages/types/src/device/container-primary-child.ts
  - packages/system/src/builtins/device-manager/device-linked-devices.ts
---

## Context

Two bugs from the same week, both of which looked like working features.

**The battery.** Reolink battery cameras behind an NVR announced 0% at every
start and the real level a moment later. The operator found it in the low-battery
notifications, which is where a fabricated reading does its damage. Measured on
the live hub, the gap is real: the cameras register at 12:36:28 and the hub's
first per-channel battery read lands at 12:37:18 — fifty seconds during which
something has to be said about a level nobody has read.

`BatteryStatusSchema.percentage` was `z.number().min(0).max(100)`, so the only
thing a provider COULD say was a number, and the honest number does not exist.
Registration seeded `0` (with a comment explaining that the slice had to exist so
field-level writes would merge), and `mapBatteryInfo` fell back to `0` for a push
that carried no numeric level. Neither author was careless; the schema left no
other move. `vacuum-control` and `lawn-mower-control` had already modelled the
same field as nullable, so the outlier was `battery`.

**The container pick.** `resolveContainerPrimaryChild` accepted an operator
override from the day it shipped and nothing ever passed one. The call site
carried a comment saying `DeviceInfo` had neither the child identity nor the
stored pick. It has both. What it does not have, under the `slim` projection
linked-devices is pinned to, is `sourceInfo` — rebuilt from the config blob that
`slim` exists to avoid reading (a measured 36 814 queries/minute). The pick was
keyed on `sourceInfo.id`.

Wiring it against `slim` would have compiled, passed, and been wrong: measured
across the live fleet, **677 of 925 container children have a `sourceInfo.id`
different from their `stableId`**. The override would have missed the operator's
choice for three children in four and fallen back to the type default — which is
indistinguishable from an operator who never chose.

## Decision

**A value that has not been observed is `null`, and the schema must let it be.**
A required scalar with no honest default is a schema bug: it forces every
provider to invent one, and the invented value is indistinguishable from a real
measurement. Where the invented value is also actionable — a flat battery, an
empty timeline, an offline node — the schema has manufactured an alarm.

Consumers of a nullable reading SAY NOTHING rather than something false.
HomeKit publishes neither `BatteryLevel` nor `StatusLowBattery` for an unknown
level (it still reports charging, which IS known); the Home Assistant projector
omits the topic, extending the judgement it already applied to binary
indicators. `battery-band` needed no change — it already declined to band a
non-finite reading, which is the shape the others were missing.

**A durable pick is keyed on an identity that survives every projection the
resolvers run under.** Not the richest identity available at the surface where
the operator chooses — the one available everywhere it is read. For a device
that is `stableId`: a NOT NULL column, and the `(addonId, stableId)` index is
already how the row store re-identifies a device across a re-sync, which is
exactly the durability the pick claims. A pick stored under the previous key
still resolves; new ones are written as `stableId`.

## Consequences

A shape duplicated by hand drifts, and this is the proof: the event-bus payload
carried an inline copy of `BatteryStatus` under a comment saying the two were
"kept in lock-step by hand". They were not — it stayed `number` and refused the
value its own capability now defines. Only the compiler noticed. This is why
`z.infer<>` is the rule.

A docblock claiming a unification is not one. `container-primary-child.ts` said
three copies of the precedence now delegated to it. None did. `ui-library` does
now; the other two cannot — the viewer resolves `@camstack/types` from its own
`node_modules`, where a newly added export simply is not present at runtime, and
the Home Assistant provider ranks `DeviceType` enum members because it answers a
different question from the same ordering. Both keep a copy, and
`scripts/check-container-priority-in-sync.ts` fails the build when either drifts.
A comment asking two files to stay in sync never could.
