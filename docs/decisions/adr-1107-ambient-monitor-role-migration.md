---
id: D1107
title: A device is migrated to the ambient-monitor role once, by a verdict that never overwrites a role the operator chose, and the marker is written only after the change lands
status: accepted
date: 2026-11-27
supersedes:
---

## Context

A sensor that exposes two or more reading capabilities (temperature, humidity,
CO2, VOC, PM2.5, PM10, AQI) was typed as a plain sensor or a thermometer, so its
device card showed one value and hid the rest. A new device role,
`ambient-monitor` (`DeviceRole.AmbientMonitor`, icon `gauge`), groups these
devices so the card can lay out every reading.

Existing devices already carry a role that an earlier provider default wrote.
Changing it for them is a migration, and two naive forms of that migration fail:

- Re-deriving the role on every start overwrites a role the operator changed by
  hand. The next boot silently undoes the operator's choice.
- Migrating every device unconditionally has the same failure, on the first boot
  after the upgrade.

The migration also has to survive a failed write. Hub services are not ready at
boot, so `setRole` can fail on the first activation. If the per-device marker
that says "the verdict ran" were written before `setRole`, a failed call would
mark the device as migrated and the migration would be lost for that device
forever. This was found in review, not in production.

## Decision

Existing devices are migrated to `ambient-monitor` once per device, by the
single function `ambientRoleVerdict` in
`packages/types/src/device/ambient-role-migration.ts`. It returns one of three <!-- drift-ok: lands in the following commit -->
verdicts:

- `set`: the device's current role is the previous provider default, so it
  becomes `ambient-monitor`.
- `kept`: the device has a role other than the previous default. That role is
  the operator's choice and is kept.
- `skip`: nothing to do.

A per-device marker, `ambientRoleReviewed`, in the device config store records
that the verdict ran. The marker is written in the order the verdict requires:

- for `set`, the marker is written only after `setRole` has succeeded, so a
  failed call retries on the next activation;
- for `kept`, the marker is written immediately.

Providers that adopt multi-reading sensors call this same verdict. The mqtt-ha
provider does it in `backfillRole`, with the role from
`deviceRoleForCapabilities` (two or more reading capabilities give
`ambient-monitor`). The Homematic provider does it in `reviewRole`, with
`sensorRoleOf` in `hm-entity-spec.ts`: the old role is kept in `channelRole`,
and `config.role` is read only as the `replaces` fallback.

The card layout follows the reading count: one reading renders a single value,
two to six render circular gauges, seven or more render a grid.

## Consequences

- A role the operator changed is never touched again by the migration. Only a
  device still on the provider default is moved, and only once.
- A new provider that adopts a multi-reading sensor must call the same verdict
  and must not invent its own rule for the old default. Two providers deciding
  the same question differently is the failure this record prevents.
- The marker is a retry guard, not a completion record. Code that reads it must
  treat `ambientRoleReviewed` as "the verdict has been decided", and the role on
  the device as the authority.
- The Homematic old role lives in `channelRole`. A reader must not treat
  `config.role` as the current role; it is only the fallback for `replaces`.

## Enforcement

Review only, for now. The code lands in a following commit, which adds the `covers:` entry for
`ambientRoleVerdict`'s file. No guard checks that a
provider calls the verdict, and no test yet pins the ordering of the marker
write against `setRole`. Until a spec does, the ordering rule is trusted to the
reviewer.
