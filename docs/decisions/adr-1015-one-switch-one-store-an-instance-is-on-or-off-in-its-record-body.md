---
id: D1015
title: One switch, one store - an instance is on or off in its record body, for every role
status: proposed
date: 2026-11-06
supersedes: D1007 (the clause "the registry owns `enabled` for `role: devices`", and `setInstanceEnabled` refusing a devices addon)
applies-to:
  - packages/types/src/addon/record-integration-instances.ts
  - packages/types/src/migrations/registry-switch-to-body.ts
  - packages/types/src/addon/base-addon.ts
  - server/backend/src/api/core/cap-providers.ts
  - scripts/check-one-row-switch.ts
---

## Context

D1007 split the switch by role: a device integration kept `enabled` in the registry, a service kept
it in the record body. Two stores for one idea, two ways to flip it (`integrations.update` and
`setInstanceEnabled`), and nothing that said which was true when they disagreed. Nineteen device
addons learned of a switch by subscribing to `IntegrationEnabled` / `IntegrationDisabled`, events
that are telemetry and may be dropped (D8, D11). Epic planning#440 step 3 asks for one switch and
one store.

Tried first: keep the registry flag and mirror it into the body. Rejected: a mirror is a second
copy, and the question "which one wins" survives.

## Decision

The record body's `enabled`, read through `isInstanceEnabled`, is the only stored on/off of an
instance, for every role including `devices`. `integration-instances.setInstanceEnabled` is the
only way to write it; it creates a missing record from the addon's `initialBody(name)`. The
registry `enabled` column is neither read nor written by the switch (its drop is step 5).
`integrations.list`, `get` and `getByAddonId` project `enabled` from the instance body. The one
exception is a row with `info.fixed` (alarm panel, camera-grid, core-blocks, terminal): it has no
record, and `integrations.update({enabled})` still switches it.

An addon learns of a switch through `RecordIntegrationInstances.onSwitched((id, enabled) => ...)`,
called after `onChanged`, in the process that serves the instance. The event subscription is gone.

A registry flag that was off is moved into the body by `registrySwitchToBodyMigration` (D987):
a disabled integration stays disabled, an enabled one is left alone, a missing record is created,
a rerun does nothing.

## Consequences

- `integrations.update({enabled})` refuses every row that is not `info.fixed`.
- The projection falls back to the stored registry flag for a row with no provider, no instance
  or an addon that failed to answer (logged). Step 5 removes the column and the fallback.
- The hub emits no `integration.enabled` telemetry for an instance switch any more; the admin-ui
  invalidates its own queries. Nothing durable depended on the event.
- A context without the migration API skips the switch migration with a warning.

## Enforcement

`scripts/check-one-row-switch.ts` (a second `set...Enabled` cap method or a second
`setInstanceEnabled` implementation is refused outside its baseline); the migration spec on real
SQLite; the projection spec in `server/backend`.
