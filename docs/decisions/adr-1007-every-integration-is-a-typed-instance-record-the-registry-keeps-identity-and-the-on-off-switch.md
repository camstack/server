---
id: D1007
title: Every integration is a typed instance record; the registry keeps identity and the on/off switch of a device integration
status: proposed
superseded-in-part-by: D1015
date: 2026-11-04
supersedes: the "legacy integration_settings rows stay for addons that bring devices" part of D996, and the integrationSettingSections / per-integration settings rows part of D986
applies-to:
  - packages/types/src/capabilities/integration-instances.cap.ts
  - packages/types/src/addon/record-integration-instances.ts
  - packages/types/src/migrations/integration-rows-to-record.ts
  - packages/types/src/records/secret-paths.ts
  - packages/system/src/builtins/sqlite-storage/integration-rows-ports.ts
  - server/backend/src/api/core/integration-role.ts
  - server/backend/src/api/core/cap-providers.ts
  - scripts/check-integration-instances-declared.ts
---

## Context

D996 moved the connection-holding service addons (Loki, SMTP relays, tunnels) to typed instance
records served by `integration-instances`, but an addon that brings DEVICES kept its configuration
as `integration_settings` key/value rows, read through `ctx.api.integrations.getSettings`. Two
stores for one idea: a different form, a different secret door (`integration/<id>` markers), a
respawn on every settings change, no typed shape for 22 readers. The live census (21 integrations,
1388 devices) showed the rows still in use by sixteen addons.

Tried first: a thin alias that keeps `integrations.getSettings` answering for a release while addons
move. Rejected by the operator: two paths means a reader that falls back to the old shape silently,
and a migration nobody can prove finished.

## Decision

Every integration's configuration is a typed record of the addon's own kind, keyed by the
`integrations` registry id (`int_NNNN`), served through `integration-instances`. The `integrations`
registry stays what it is for the hub: id, addon, name, `enabled`, discovery and adoption.

- `describe()` states `role` (`devices`, `services`, `both`) and an optional `discovery`
  (`none | lan | account`, `scopedToInstance`). The hub decides the Integrations page, the wizard
  discovery word and the test button from it; the manifest's `integrationRole` stays as an override
  and is the only reader of capabilities for an addon still on rows.
- (Superseded by [D1015](adr-1015-one-switch-one-store-an-instance-is-on-or-off-in-its-record-body.md): the body owns `enabled` for every role.) The registry owns `enabled` for `role: devices`: the body must not declare it, the instance view
  carries none, and `setInstanceEnabled` refuses, naming `integrations.update`. `services` and
  `both` keep the switch in the body (D996) until their own move.
- A record secret path may sit in a MAP of the body (`applianceSecrets{}`: one level, each value its
  own keychain value, the key stays in the row). `z.record(z.string(), z.string().meta({ secret:
  true }))` declares it; a patch entry that is omitted, empty, the redaction token or the stored
  view keeps its secret.
- `onChanged(id, change)` runs in the process that serves the instance after every create, update,
  enable and delete: an edit applies on the next use with no respawn.
- Migration only, no fallback: `moveIntegrationRowsToRecords` (a `block-owner` procedure) reads
  every legacy row with its secrets through the owner's door before writing anything, puts the
  record `ifRev: 0`, reads every secret back (a record it created must match exactly, an existing
  one must hold each secret) and only then clears the rows and their keychain values. A locked
  keychain throws and the rows stay. After an addon's migration nothing reads its old rows.

Discovery, per `describe().discovery`: `lan` is offered by the wizard as `auto`; `none` and
`account` are `manual` there (an account's devices appear after the instance signs in).

## Consequences

Each device addon owns a record kind, a form, a `describe()` and a migration; the hub keeps its
legacy branch (`findInstancesProvider` null) until the last addon moves, then deletes it with the
registry's settings methods and the table (a later hub-store migration, after a ledger check).
`IntegrationMigrationPorts.createIntegration` (Ecowitt's hub migration) still writes rows until
Ecowitt moves. A `both` broker keeps its body `enabled` until the Home Assistant / Alexa waves
decide its switch.

## Enforcement

`scripts/check-integration-instances-declared.ts`: a device addon that declares
`integration-instances` carries a record kind and a `describe()` role; one that does not is on the
committed `onRows` baseline, which only shrinks. Specs: `integration-rows-to-record.spec.ts` (real
SQLite: both secrets read back, rows cleared, rerun no-op, locked keychain throws and leaves the
rows, a secret that does not read back removes the record), `records-map-secrets.spec.ts`,
`record-integration-instances-p7.spec.ts`, `integrations-connection-instances.spec.ts`.
