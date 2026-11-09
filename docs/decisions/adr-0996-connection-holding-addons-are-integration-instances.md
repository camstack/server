---
id: D996
title: Connection-holding addons are integration instances, a system collection cap over typed record kinds
status: accepted
superseded-in-part-by: D1013
date: 2026-11-02
supersedes:
applies-to:
  - packages/types/src/capabilities/integration-instances.cap.ts
  - packages/types/src/addon/record-integration-instances.ts
  - packages/system/src/builtins/loki-logging/**
  - packages/addon-smtp-nodemailer/src/relay-pool.ts
  - packages/addon-smtp-nodemailer/src/relay-record-kinds.ts
  - server/backend/src/api/core/cap-providers.ts
---

## Context

An addon that holds one remote connection and no devices (a log destination, a mail relay)
kept it in its addon-level settings, which D986 retires, and showed it on a page of its own
that the Integrations list did not know. Two such addons could not exist side by side, and
the secret sat in the addon's settings blob rather than bound to a row. The first attempt,
a name per connection inside the settings blob, left the registry row and the secret
without an owner.

## Decision

A connection-holding addon is an integration instance. It provides `integration-instances`
(system scope, collection, no mount; admin-gated, with typed hooks for the function page): `describe`, `instanceFormSchema`,
`listInstances`, `getInstance`, `createInstance`, `updateInstance`, `deleteInstance` and an
optional `testInstance`. The instance id IS the `integrations` registry id. The state is a
typed record kind (kind names are lower-case-dashed, so Loki's is `destinations`, owner
`loki-logging`), the secret is a keychain marker bound to the row, and the shared helper
`RecordIntegrationInstances` implements the cap over a kind. The hub routes on the presence
of the provider alone: with one, the integrations cap reads and writes the record; without
one, the legacy `integration-settings` path runs. **Operator decision (2026-11-02): a service instance is configured from its function page.** The Integrations page lists only integrations that bring devices: `integrations.list` omits every addon whose manifest declares `integration-instances` (generic, no per-addon list), and `getAvailableTypes` offers none, so the add wizard never shows one. The stored row (for Loki `int_0038`) and the record and its keychain secret are kept; `get` and `getByAddonId` still resolve it, which the migration relies on. Loki is a row of the Logging page's destinations list, edited through the cap in a dialog; with no record yet the provider picker creates it, under the addon id. There is no `connection` kind in the UI.
The per-destination on/off switch of a log destination
(D777) is superseded for instances by the amendment below.

## Consequences

D985 and D986 are narrowed: a connection is a record, not an addon-level setting. Loki is the
pilot; its settings schema is gone and a hub-only migration moves the old values (the
procedure `loki-logging/2026-11-02-connection-to-records`, then a `deleteKeys` plan). Agents
have no provider and re-read the record on a short period. Wave b moves the mail relays (below).

### Wave b - the SMTP relays (`smtp-nodemailer`)

`smtp-nodemailer` is the first MULTI-instance connection at the data layer: record kind `relays`,
one row per relay (host, port, secure, username, password as a keychain secret, From address and
name), `describe().instanceMode = 'multiple'`, served through `integration-instances` as the
CRUD and test API. UI exception (operator, 2026-11-02): a relay is NOT an integration-registry
row and is not listed on the Integrations page. Its id is minted by the addon
(`relay-xxxxxxxx`), and the page that always showed the SMTP settings (Connectivity → Email)
keeps its fields and place: the addon overrides `getGlobalSettings` and the two
`updateGlobalSettings*` writers to project onto the default relay (the first configured one;
created on the first save). `smtp-provider` `sendEmail`, `verify` and `getStatus` gain an
optional `instanceId` (additive; `verify` and `getStatus` take an object input now, `{}` for
none): absent means the first configured relay, an unknown id is an error, a provider with one
fixed relay ignores it. The notifier email adapter forwards an optional per-target
`smtpInstanceId`. Two migrations, same shape as Loki's: a `procedure` that creates the record
(an existing record is never overwritten, the only password copy is cleared once the record
holds it, a stored odd port or TLS flag is clamped or coerced to the kind schema so it never
blocks the owner), then a `deleteKeys` plan on the canonical `addon-settings` table that runs
only once the record is confirmed to hold the host and the password. The addon is an npm addon,
hub-only, one forked process; it reads its settings from the same canonical table as a builtin,
through the settings-store door.

**Amendment (operator, 2026-11-02): one list, a provider picker.** Every function page that has
instance-holding providers is one `ProviderInstancesPanel`: a row per record of each provider, a
fixed row (registry switch, addon settings) for a provider that holds none, and a picker that offers
the providers able to take another record. A `single` provider is offered while it has no record and
names its record after the addon; a `multiple` provider gets an opaque `inst-<8 hex>` id minted by the
UI. Ids are opaque: an `inst-` id and a migrated `relay-` id coexist in one list.

**Amendment (operator, 2026-11-02): every instance carries its own switch.** `enabled` lives on the
record body (absent means on, so no data migration) and is switched by the required method
`setInstanceEnabled({ id, enabled })`, a row control and not a field of `updateInstance.values`
(D62: the form patch is not the switch). `IntegrationInstance.enabled` is always present in the view.
`RecordIntegrationInstances` implements it and tells the addon through `onChanged`; each kind adds
`enabled: z.boolean().optional()`. D777's registry toggle remains only for providers that hold no
instance. Loki reads the flag in `destinationConfig()`, so a record that is off stops the timer,
the write, the flush and `read()` on the hub at once and on agents within the 30 s refresh. A
disabled-at-registry Loki is carried over by the procedure
`loki-logging/2026-11-02-registry-toggle-to-record` (record off, registry back on; idempotent; a
failed read writes nothing; run again after the provider registers, since it is not listed while the
addon initialises). A relay that is off is skipped by the default pick; a caller pinned to it gets
`smtp.relay-disabled` and no other relay answers; `verify` and `testInstance` still probe it;
`status()` is `ready: false` without an error. Restart is a row action (`addons.restartAddon`, per
addon and hub-only, a grouped addon restarts its whole group) and the activity of the providers in
the list sits under it.

## Enforcement

Specs: the helper (instance isolation, secret keep and clear, `enabled` default and `setInstanceEnabled`), the relay pool (default pick, pinned refusal, toggle survives an unchanged-body apply), the hub aggregation (connection
kind, no write to `integration-settings`) and the Loki migration (moves, secret resolves,
idempotent, a failed read writes nothing). `check-migrations-well-formed` and
`check-runner-barrel-free` guard the catalogue and the helper's imports.
