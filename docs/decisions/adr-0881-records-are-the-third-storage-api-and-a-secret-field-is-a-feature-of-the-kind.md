---
id: D881
title: Records are the third storage API, owner-scoped and index-served, and a secret field is a feature of the kind
status: accepted (rule 6, adoption as a boot guard with `adoptRecords` and the persisted `adopted_at`, and rule 7's drop of the phase-0 tables by name, superseded by D900 — the migration is closed; the rest stands)
date: 2026-10-18
supersedes:
applies-to:
  - packages/types/src/records/**
  - packages/types/src/capabilities/records.cap.ts
  - packages/types/src/capabilities/record-entries.cap.ts
  - packages/system/src/builtins/sqlite-storage/records/**
  - packages/system/src/builtins/record-entries/**
  - scripts/check-records-index-served.ts
  - scripts/check-records-no-unindexed-where.ts
---

## Context

157 tables, 120 of them relational, were declared by ~40 owners one `declareCollection` at a time.
Each carries its own typed columns, its own indexes, its own retention loop and its own idea of
where a credential lives; the live census (`docs/design/records-api-plan.md`) found nine tables
nothing reads, eight hand-written rings, and credentials in plain rows (D879, D880). Moving
everything into one JSON table is the obvious answer and has three failure shapes, each paid for
once already in this repo: a JSON field filter that no expression index matches character for
character is silently a full scan (`share_view_tokens`); a scheduled aggregate that finds its rows
through an index and then reads the row behind every entry held the synchronous settings thread for
4-7 s (D447); and a shared table is one dropped `kind_id` predicate away from deleting across owners.

## Decision

**`ctx.records` is the third storage API**, next to `ctx.settings` (operator intent, D870) and
device-history (numbers over time, D850): an addon's own facts and documents, kept as records of a
declared KIND in one shared `records` table per database file (`camstack.db`, `events.db`). Rules:

1. **A kind is declared next to its owner** (`defineRecordKinds`): database, class, write trigger,
   named partial expression indexes, retention (an engine TTL, a ring bound, the owner's own
   sweep, or none with a reason) and `deviceRemoval`. The engine creates the indexes when the owner
   declares its kinds - never on a write - and a re-declaration is additive: a changed index is a
   new name.
2. **The owner is the transport-stamped caller**, never a field of an input; a kind is readable and
   writable by its owner only, from any process or node of that addon.
3. **An unindexed filter does not compile.** `where` accepts declared index fields only (equality
   on the leading fields of one index, at most one range after them); the predicate, the index and
   the ordering are rendered by the one `fieldExprFor`; every index path is named with `INDEXED BY`,
   so a plan SQLite cannot honour is an error and not a scan; `kind_id` is a literal in every
   statement. Paging is a keyset cursor; there is no offset and no scan.
4. **A secret field is a feature of the kind.** A schema field marked `.meta({ secret: true })` is
   stored as a keychain marker bound to the row's own ref (`secret://<owner>/row/records:<kind>/<id>/<path>`),
   written to the keychain first, redacted on every read, resolved only on request, kept when the
   redaction token comes back, removed with the row; a locked keychain is an explicit
   `records/secret-unavailable`, never an empty password. The engine independently refuses a
   plaintext string or a foreign marker at a secret path.
5. **Entries are one generic surface.** `defineEntryKind` makes a kind an entry; the `record-entries`
   capability lists, adds, edits and deletes any entry kind for its owner, with password fields
   derived from the schema's JSON descriptor.
6. **Adoption is a boot guard, not migration code.** A kind that names the legacy table it `adoptsFrom`
   is reported adoption-pending while it is empty and that table still has rows; `ctx.records.declare`
   then refuses to start the addon. `storageAdmin.adoptRecords` writes rows as the declared owner
   (idempotent, secrets as bound markers).
7. **Phase 0.** The nine dead tables are removed from code; the engine may drop them by name through
   `storageAdmin.dropCollection` and `scripts/hub/drop-dead-tables.ts` does (dry run by default, a <!-- drift-ok -->
   table with rows is refused unless named with its count). No boot-time purge.

### A live flaw fixed with it: the caller stamp could be supplied over the mount

`keychain`, `device-history` and `records` decide WHOSE data a call touches from `callerAddonId` in the
input. The runtime router (`packages/system/src/kernel/cap-router-builder.ts`, and the generated
mount) parses object input with `.loose()`, so an admin session could add `callerAddonId: "other-addon"`
and act as that addon - on the keychain and device-history since before records. The mount now strips
the key for the caps in `CALLER_STAMPED_CAPABILITIES`; the stamp is set only by the transport
(`stampCallerAddonId`) or stated by a hub in-process caller. An audit of every provider that reads
`callerAddonId` added `integrations` (`getSettings` resolves the owner's secrets for the stamped
addon; `setSettings` reads it as `operatorWrite`) and `device-manager` (`persistConfig`'s
`operatorWrite`, `listAll`'s fleet-read attribution). The list is now keychain, device-history,
records, integrations, device-manager; a new provider that reads the stamp must join it.

### Hardening after review

- A refused row write restores the keychain value it replaced (a stale `ifRev` no longer destroys a
  stored secret); a `patch` that leaves an array of secret elements untouched keeps them; a `patch`
  cannot give a secret kind an expiry.
- The boot guard asks a PERSISTED fact: `_record_kinds.adopted_at`, set when the last
  `adoptRecords` batch is sent with `complete: true`. A kind adopted and then emptied boots; a
  partial copy does not. `scripts/hub/records-adopt.ts` is the script the refusal names. <!-- drift-ok -->
- `listKinds({ counts: false })` is a catalog read; the entries service uses it for lookups.

### Where this differs from the plan, and why

- **D872's package manifest and installer do not exist in the repository yet**, so a kind is declared
  by its owner at addon boot (`ctx.records.declare`). The reconciler is the same engine function the
  installer will call; the only place DDL runs is still that declaration, never a write.
- **The redaction token is the existing `__camstack_redacted__`** (`REDACTED_SECRET`, one authority
  with the config forms), not the plan's `__redacted__`.
- **`at` is `required | none`** (not optional) and `put` is a full replace whose omitted secret
  field is removed; `patch` is the merge. A kind with secret fields cannot use an engine TTL or row
  bound (its keychain values would be orphaned): its retention is `owner` or `none`.
- **A ring is trimmed within 1 %** (once per bound/100 writes) rather than on every write, because
  counting a 20 000-row ring per write is the cost the bound exists to avoid.
- **The orphan lifecycle (14 days, snapshot, scheduled drop) is not built**: the catalog has the
  `state` column and nothing sets it. It ships with D872's registry rules.
- **System -> Data and the generic entries UI are follow-ups**: `storageAdmin.listKinds` and the
  `record-entries` capability carry everything they need.

## Consequences

- A framework change: `@camstack/types` and `@camstack/system` (a new capability, a new builtin, a
  changed `storage-admin` cap), so it is live only in a `@camstack/server` closure installed on the
  hub; one hub restart. Nothing adopts records yet, so the closure changes no behaviour until
  phase 2.
- The `records`, `_record_kinds` and `_record_sequences` tables are created by the first declaration
  and are never droppable through `dropCollection`. `events.db` appears when the first kind
  declares `database: 'events'`.
- Hub in-process builtins reach the isolated engine with a STATED caller (as for the keychain).
  That path is exercised by specs but has not been run against the isolated `sqlite-settings`
  runner; the first hub-main adopter (phase 4) must verify it on the dev hub.
- The probe, not the plan text, is the D447 evidence: `EXPLAIN QUERY PLAN` prints `USING INDEX` even
  when the row behind the entry is read.

## Enforcement

`scripts/check-records-index-served.ts` runs every declared kind through the engine with a spy on
`prepare` and judges each statement (no scan, no sort, `kind_id` literal, count and aggregate that
never read the table row, on opcodes); `scripts/check-records-no-unindexed-where.ts` reads every
literal `where` against the package's declared indexes and forbids SQL on the records tables outside
the engine; `scripts/check-durable-state-declared.ts` requires `class`, `writeTrigger` and
`retention` on every kind. Specs: `records-engine`, `records-provider`, `records-access`,
`records-probe`, `entries-service`, `check-records-guards`, `drop-dead-tables`, each disarmed once.
