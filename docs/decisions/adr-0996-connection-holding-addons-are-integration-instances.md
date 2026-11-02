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
(system scope, collection, internal, no mount): `describe`, `instanceFormSchema`,
`listInstances`, `getInstance`, `createInstance`, `updateInstance`, `deleteInstance` and an
optional `testInstance`. The instance id IS the `integrations` registry id. The state is a
typed record kind (kind names are lower-case-dashed, so Loki's is `destinations`, owner
`loki-logging`), the secret is a keychain marker bound to the row, and the shared helper
`RecordIntegrationInstances` implements the cap over a kind. The hub routes on the presence
of the provider alone: with one, the integrations cap reads and writes the record; without
one, the legacy `integration-settings` path runs. An addon with this cap and no device
provider or adoption is listed with kind `connection`, which the admin UI treats like an
account without device discovery. The per-destination on/off switch of a log destination
(D777) is unchanged and is not wired to the integration's `enabled`.

## Consequences

D985 and D986 are narrowed: a connection is a record, not an addon-level setting. Loki is the
pilot; its settings schema is gone and a hub-only migration moves the old values (the
procedure `loki-logging/2026-11-02-connection-to-records`, then a `deleteKeys` plan). Agents
have no provider and re-read the record on a short period. Wave b moves the mail relays.

## Enforcement

Specs: the helper (instance isolation, secret keep and clear), the hub aggregation (connection
kind, no write to `integration-settings`) and the Loki migration (moves, secret resolves,
idempotent, a failed read writes nothing). `check-migrations-well-formed` and
`check-runner-barrel-free` guard the catalogue and the helper's imports.
