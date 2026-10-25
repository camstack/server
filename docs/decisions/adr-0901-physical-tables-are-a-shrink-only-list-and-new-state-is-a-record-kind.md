---
id: D901
title: Physical tables are a shrink-only list — new state is a record kind, a new table needs an ADR
status: accepted
date: 2026-10-22
supersedes:
  - D183
applies-to:
  - scripts/check-physical-tables-ratchet.ts
  - scripts/lib/parse-storage.ts
---

## Context

The records migration (D881 → D900) moved every addon's facts and documents
from hand-declared settings-store tables into `ctx.records`: one engine-owned
table family per file, indexes and retention declared per kind, a secret field
a feature of the kind. It took two months and an offline drop of 38 legacy and
37 duplicate vector tables on the operator hubs (prod `camstack.db` 627 → 32 MB).

Nothing stopped the next `declareCollection` from landing the day after. The
storage map (`docs/reference/storage.md`) DESCRIBES every table the code can
create; it has never refused one. The guards that policed the migration
(`check-no-legacy-table-access`, `check-retired-collections-are-dead`,
`RETIRED_LEGACY_TABLES`) only knew the OLD names, and they were deleted with the
migration's last code on 2026-10-22.

D183 dropped a deleted feature's tables at every boot (`RETIRED_COLLECTIONS`).
That purge is deleted too: it was not role-gated, so one wrong entry dropped a
live hub table at every boot, and every table it ever listed is gone from the
operator hubs.

## Decision

The set of physical SQLite tables the code can create — the canonical KV list,
every `declareCollection`, every raw `CREATE TABLE`, as the storage-map parser
reads them — is a committed list in `scripts/check-physical-tables-ratchet.ts`
(`ALLOWED_TABLES`, plus `ALLOWED_UNRESOLVED_SITES` for the call sites whose
name is computed). The list only shrinks. New state goes to `ctx.records`; a
new physical table is admitted only by an ADR that says why it cannot be a
record kind, and its list entry lands in that change. A table the code stops
creating leaves the list in the same change, and the operator drops it
offline (`DROP TABLE` plus its `_collection_declarations` row in the same
file) — there is no boot purge.

## Consequences

- Moving a system table to records (the queue in `docs/roadmap.md`) shrinks <!-- drift-ok: moved to the private planning repo -->
  the list; the guard fails until the line is deleted, so the list stays exact.
- A table reached through a computed name from a NEW call site fails too, so
  a new table cannot slip past the parser; the fix is a literal or a same-file
  constant.
- Dropping a removed table is an operator act per hub, written in the change
  that removed it. A restored old backup can bring a dead table back; it is
  inert (nothing declares or reads it) until the operator drops it.

## Enforcement

`scripts/check-physical-tables-ratchet.ts`, wired into the on-demand Checks
workflow; its rule cases (and, under `CAMSTACK_REAL_TREE_SPECS=1`, the real
tree) in `scripts/__tests__/check-physical-tables-ratchet.spec.ts`.
`--print` shows what the parser sees now.
