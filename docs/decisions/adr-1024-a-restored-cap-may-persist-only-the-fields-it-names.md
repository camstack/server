---
id: D1024
title: A restored cap may persist only the fields it names
status: accepted
date: 2026-11-08
supersedes:
applies-to:
  - packages/system/src/builtins/device-manager/runtime-state-persist-gate.ts
  - packages/system/src/builtins/device-manager/device-state-mirror.ts
  - packages/types/src/capabilities/capability-definition.ts
  - scripts/check-runtime-state-durability.ts
---

## Context

Climate power-on must return to the last mode the device actually ran, and a
provider can never tell us that: after a restart it reports the mode the device
is in now. `lastActiveMode` therefore has to outlive a hub restart. The cap was
`durability: 'session'`, so nothing of it reached disk. Switching the whole slice
to `restored` would also have served the old mode and temperatures after a
restart, as if they were current, until the provider answered.

The first idea was `restored` plus `volatileStateFields` for every other field.
That does not work: a volatile field is only excluded from the "is this worth a
commit" comparison. It is still written and still seeded at boot.

## Decision

A `restored` cap may declare `restoredStateFields`. Only those fields are written
and seeded back at boot; every other field stays a session value, re-read from
the provider. A restored cap that declares nothing persists its whole slice, as
before. `climate-control` and `water-heater` declare `['lastActiveMode']`.

## Consequences

The write path (`persistableBlob`) and the boot seed (`seedMirror`) share one
function, `restoredPart`, so what is written and what is read back cannot drift.
A row that carries more than the named fields seeds only those. After a restart a
climate slice holds `lastActiveMode` alone until the provider reports; consumers
already treat an unanswered slice as unknown (D315).

## Enforcement

`scripts/check-runtime-state-durability.ts`: `restoredStateFields` requires
`durability: 'restored'`, and every name must be a field of the cap's runtime
state. `restored-state-fields.spec.ts` proves the restart behaviour for both
directions.
