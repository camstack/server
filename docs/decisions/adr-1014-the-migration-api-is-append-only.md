---
id: D1014
title: The migration API is append-only - a migration reaches the world through MigrationApiV1 and nothing else
status: accepted
date: 2026-11-05
supersedes:
applies-to:
  - packages/types/src/migrations/api/**
  - packages/types/src/addon/base-addon.ts
  - packages/system/src/kernel/moleculer/migration-api-facade.ts
  - scripts/check-migration-api-append-only.ts
  - scripts/check-migration-ports-surface.ts
  - scripts/migration-api-contract.json
  - scripts/migration-ports-surface-pending.json
---

## Context

A node that jumps several versions runs every migration it missed, in order, on the NEW code. A
migration that calls `ctx.api.*`, `ctx.records` or a server module binds itself to the shape those
had the day it was written. The first time one of them changes, the oldest migration on the ledger
fails on a node that upgrades across it, and a failed migration blocks its owner. Deleting old
catalogues (planning#448) would hide that, not fix it: the next catalogue meets the same wall.

## Decision

A migration's ports are built from `MigrationApiV1` (`ctx.migrationApi`) and from nothing else:
`this.runMigrations(CATALOGUE, (api) => ports)`. The API is a facade over the existing handles
(ledger, legacy integration rows, records, settings, secrets, integrations, devices of an addon,
node id, log) and it is APPEND-ONLY: a method never disappears, a field never disappears or turns
required, an enum never narrows, a behaviour is never removed. A change that cannot be an addition
is `migration-api.v2` beside v1, and v1 keeps answering.

## Consequences

Every method needs a Zod pair, behaviour ids and a contract spec on real SQLite
(`migration-api.contract.spec.ts`). A migration reads no `ctx`, imports `@camstack/types`, zod and
local files only. A catalogue whose ports still need something outside V1 stays on the legacy
`runMigrations(bound[])` form and is named in `scripts/migration-ports-surface-pending.json`; the
list only shrinks. Each such catalogue says what V1 lacks (per-node settings projection, node
directory, hub-device creation, saved devices) and widening V1 for it is an additive change.

## Enforcement

- `scripts/check-migration-api-append-only.ts` against `scripts/migration-api-contract.json`.
- `scripts/check-migration-ports-surface.ts` (no `ctx`, imports, `defineAddonMigrations(` only in
  `base-addon.ts` or the pending list; a stale pending entry fails).
- `migration-catalogue-replay.spec.ts` replays the hub catalogue over seeded legacy data and the
  default-integration catalogue through a Proxy that refuses any method outside the contract;
  `check-migrations-well-formed.ts` asks every catalogue off the pending list for its seed.
