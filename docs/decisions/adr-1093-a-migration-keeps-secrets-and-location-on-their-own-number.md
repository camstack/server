---
id: D1093
title: A migration keeps each number's secrets and location on that number
status: accepted
date: 2026-11-23
supersedes:
applies-to:
  - packages/system/src/builtins/device-manager/migrate-hardware-state.ts
  - packages/system/src/builtins/device-manager/device-row-store.ts
  - packages/system/src/builtins/keychain/keychain-service.ts
---

## Context

D339 says role state stays with the number and hardware state follows the
hardware. `migrateDevice` swapped the per-device config, secret markers
included, but a marker is `secret://<owner>/device/<id>/<field>` and the ref is
the AAD of the ciphertext. On 2026-11-23 a Reolink NVR child (3628) and a
standalone (5920) were migrated: 3628 then carried a marker pointing at scope
`device/5920` and the reverse. Removing either device purges its own scope
(D864), which deletes the secret the OTHER number's config points at. The same
swap also moved `meta.location` with the hardware, so the room followed the
camera instead of staying on the number (and a child's inherited room was
re-derived from the wrong parent).

## Decision

A migration moves secrets and location as follows. Each number's markers always
point at that number's own keychain scope: `swapHardwareState` exchanges the
two `device/<id>` scopes in the keychain FIRST (`keychain.swapDeviceScopes`,
re-encrypting each value under its new ref, caller `device-manager` only), then
re-points the markers, and reports the result as `secretScopes`. A keychain
failure fails the swap before any config moves and is never swallowed.
`swapIds` leaves the room on the number, children included. A pair crossed by
the old code is repaired with `deviceManager.repairMigrationSecrets` (admin,
idempotent, dry-run by default) through `scripts/hub/repair-migration-pair.ts`.

## Consequences

There is no transaction across the keychain and the settings store. A migration
REFUSES (`secret-scopes-crossed`, before anything is disabled) a pair whose
configs already name each other's scope, so a second swap cannot mix the
passwords. The repair keeps its state in the configs themselves (stage copy,
point at it, write the end refs, point at them, delete the stage), so a crash at
any step is re-run to the right end state; one-sided pairs work field by field.
The migration swap's own keychain exchange (`swapDeviceScopes`) is NOT crash
safe between its writes: a process death inside that millisecond window can
lose a value, and the migration then reports a partial move the operator
re-enters by hand. D339's "swap the markers" step is superseded by this record.

## Enforcement

`migrate-hardware-secrets.spec.ts`, `migrate-secret-repair.spec.ts`,
`keychain-device-scope-swap.spec.ts` and `device-row-store-swap.spec.ts`
(location cases); each fails when the corresponding step is removed.
