---
id: D996
title: Connection-holding addons are integration instances, a system collection cap over typed record kinds
status: proposed
date: 2026-11-02
supersedes:
applies-to:
  - packages/types/src/capabilities/integration-instances.cap.ts
  - packages/types/src/addon/record-integration-instances.ts
  - packages/system/src/builtins/loki-logging/**
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
one, the legacy `integration-settings` path runs. **Operator decision (2026-11-02): a service instance is configured from its function page.** The Integrations page lists only integrations that bring devices: `integrations.list` omits every addon whose manifest declares `integration-instances` (generic, no per-addon list), and `getAvailableTypes` offers none, so the add wizard never shows one. The stored row (for Loki `int_0038`) and the record and its keychain secret are kept; `get` and `getByAddonId` still resolve it, which the migration relies on. Loki is edited on the Logging page in place, through the cap (`ConnectionInstanceForm`); with no record yet the form creates it, under the addon id. There is no `connection` kind in the UI.
The per-destination on/off switch of a log destination
(D777) is unchanged and is not wired to the integration's `enabled`.

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

## Enforcement

Specs: the helper (instance isolation, secret keep and clear), the hub aggregation (connection
kind, no write to `integration-settings`) and the Loki migration (moves, secret resolves,
idempotent, a failed read writes nothing). `check-migrations-well-formed` and
`check-runner-barrel-free` guard the catalogue and the helper's imports.
