---
id: D979
title: Stale data is detected read-only and deleted only by an operator call that re-checks its verdict
status: accepted
date: 2026-10-30
supersedes:
applies-to:
  - packages/system/src/builtins/sqlite-storage/stale-data/**
  - packages/system/src/builtins/sqlite-storage/records/records-engine.ts
  - packages/types/src/capabilities/storage-admin.cap.ts
---

## Context

`auth-oidc` kept a legacy `providers` array in its global settings after the
code stopped reading it. The array held keychain markers bound to settings
paths, so the keychain reported `records/foreign-marker` errors for data nobody
used, and nothing flagged the leftover. The record catalog had the same hole:
`orphaned_at` existed but nothing set it, so a kind whose owner stopped
declaring it looked identical to a live one.

## Decision

The hub audits for data an addon left behind, and the audit never deletes.

- **Three verdicts, never blurred.** A record kind is `orphaned` when its owner
  package is not installed, or when its owner is running, declared at least one
  other kind since the engine started, and did not declare this one. A settings
  key is `stale` when the running addon, asked in its own process
  (`getDeclaredSettingsKeys`), does not declare it. Anything else that cannot be
  judged - an owner installed but not running, an addon that does not answer, an
  unreadable list, a running owner that declared nothing since the hub started -
  is `unknown` and is never offered for deletion (D315).
- **Detection is read-only.** It runs once when the registry reports the addons
  started (`SystemAddonsReady`, no timer to wait for readiness, D3), every 24 h,
  and on demand. The result is kept in memory and served by `staleDataReport`.
  Every finding is logged once per scan with owner and key or kind, never a
  value. The one write is the `orphaned` flag on a catalog row, which still
  serves its owner, so a wrong flag breaks nothing, and which a declaration
  clears.
- **A secret whose marker sits only under a stale key** is reported with that
  key as in use by stale data. It is not an orphan until the key is gone.
- **Deletion is a separate operator call** (`dropOrphanedKind`,
  `unsetStaleSettingsKey`: admin, caller required, audited with the operator).
  Each recomputes the verdict at call time and refuses anything not still
  orphaned or stale. `local-auth` kinds are never dropped (D902).

Rejected: **auto-delete** - a verdict computed while an owner is mid-restart or
an agent is unreachable would destroy data, and a deletion nobody asked for is
not recoverable. **A static guard only** - it sees code, not what a hub already
holds in its database, which is where the leftover lived.

## Consequences

The addon list is the hub's own registry, so an owner that lives only on an
agent is judged "not installed" and must be treated as a candidate to verify,
not as proof, until the list spans nodes. A durable-state key an addon opens
lazily is not in its declared set until opened and can be reported stale; the
removal re-asks the addon, which refuses a key it declares by then. The keychain
gained one narrow owner-spanning delete, `releaseRecordRefs`, reserved to
`sqlite-settings` and to `row/records:*` refs.

## Enforcement

`stale-data-audit.spec.ts` (verdicts, keychain link, re-check on delete,
local-auth), `records-engine-stale.spec.ts` (declared-this-boot, flag, drop,
revival), `base-addon-declared-keys.spec.ts` (declared set, removal with
secrets), `keychain-release-records.spec.ts` (the narrow release).
