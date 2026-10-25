---
title: records - an addon's own facts and documents (ctx.records)
last-verified: 2026-10-22
applies-to:
  - packages/system/src/builtins/sqlite-storage/records/records-engine.ts
  - packages/system/src/builtins/sqlite-storage/records/records-plan.ts
  - packages/types/src/records/records-access.ts
covers:
  - packages/types/src/records/**
  - packages/types/src/capabilities/records.cap.ts
  - packages/types/src/capabilities/record-entries.cap.ts
  - packages/system/src/builtins/sqlite-storage/records/**
  - packages/system/src/builtins/record-entries/**
  - packages/system/src/kernel/moleculer/records-api-transport.ts
  - scripts/lib/parse-records.ts
---

# records

Three storage APIs sit over the same door ([D44](../decisions/adr-0044.md)), one per kind of data
([D881](../decisions/adr-0881-records-are-the-third-storage-api-and-a-secret-field-is-a-feature-of-the-kind.md)):

| API | Holds |
| --- | --- |
| `ctx.settings.*` ([D870](../decisions/adr-0870-one-store-per-kind-of-setting-for-every-process-and-per-camera-state-is-a-key-of-the-camera.md)) | operator intent: per-device, addon-level, sections |
| **`ctx.records`** | an addon's own facts and documents: ledgers, audit rows, config documents, mirrors, entries |
| device-history ([D850](device-history.md)) | numbers over time, with rollups - never records |

A table that needs scans, heavy projections, scheduled aggregates over ~100 k rows or more than two
secondary keys stays its own table (`docs/design/records-api-plan.md` §0). Bytes are never record
fields: files plus `ctx.peerBytes` ([D613](../decisions/adr-0613.md)).

## The shape

One physical table per database file that hosts kinds (`camstack.db`, `events.db`; never `history.db`):

```
records(rid, kind_id, id, device_id, at, expires_at, rev, updated_at, data JSONB, UNIQUE(kind_id, id))
_record_kinds(kind_id, owner, kind, database, manifest_hash, declaration, state, orphaned_at)
_record_sequences(kind_id, next)
```

Built-in indexes: `(kind_id, device_id, at)`, `(kind_id, at)`, `(expires_at) WHERE NOT NULL`. A kind's
own indexes are partial expression indexes `rx_<kindId>_<name> ... WHERE kind_id = <literal>`. The
tables are created by the FIRST declaration, so a hub that declares no kind grows none.
`storage-admin` is read-only: no API drops a table.

## Declaring a kind

```ts
export const kinds = defineRecordKinds({
  'motion-event': {
    schema: z.object({ source: z.string(), score: z.number() }),
    database: 'events',           // high volume never sits on the settings thread
    class: 'ledger',              // replaces the @durable annotation
    writeTrigger: 'one row per motion episode, keyed per (deviceId, source)',
    device: 'required', at: 'required',
    indexes: [{ name: 'source', fields: ['source'] }],   // a LITERAL: the guards read it
    retention: { owner: 'device-window', reason: 'swept with the track window' },
    deviceRemoval: 'delete',
    maxDataBytes: 4096,
  },
})
// in the addon's onInitialize:
await this.ctx.records.declare(kinds)
const motion = this.ctx.records.kind(kinds['motion-event'])
```

`declare` reconciles with the engine: it inserts the catalog row and creates the declared indexes.
A re-declaration is additive: a new index name is created, a changed index, `device`, `at`,
`database` or the removal of a secret path is refused (`records/declaration-refused`). A package keeps
its kinds in a module with no side effects (the guards import it).

`transactFamily: '<name>'` groups kinds that must agree through one `transact` (a gallery entry and
its samples, the four retrain ledgers). A family lives in ONE file: `declare` refuses a family whose
kinds name two databases, inside one declaration or against a kind of the same owner declared before
(`records-provider.ts`). Moving a family's kind to the other file is an offline operator step,
never the engine (the rehome tool of the records migration is gone, D900).

`ctx.records.transact(ops)` applies several writes in ONE SQLite transaction: build each op with the
kind handle (`txPut`, `txPatch`, `txDelete`, which validate and handle secrets exactly as `put` /
`patch` / `delete`) and pass them together. All of them land or none does. Before a row moves the
engine checks the scope and refuses by name with `records/transact-refused`: `cross-file` (the kinds
sit in two database files), `no-family` (more than one kind and one declares no `transactFamily`) or
`cross-family` (two families). A transaction over a single kind needs no family. Files on disk are
not part of it: write the blob first and the row after, delete the row first and the blob after.

Retention is one of `{ ttlMs, from: 'at'|'write' }` (engine TTL, swept every 10 minutes off the boot
path), `{ maxRows } / { maxRowsPerDevice }` (a ring, trimmed within 1 %), `{ owner, reason }` (the
owner sweeps with `deleteWhere`) or `{ none }`. A kind in `settings` may not bound itself above
50 000 rows.

## Operations

Every result is three-way: a row, `null`, or the call THROWS (a typed `records/<code>` error;
`asRecordsError` rebuilds the class across a wire). All calls are scoped to the caller's own kinds.

| Op | Notes |
| --- | --- |
| `get`, `getMany` (<= 1000) | primary-key reads |
| `put`, `putMany` (<= 1000, <= 4 MiB) | full replace; `ifRev` compare-and-set (`0` = must not exist); `RevConflictError` |
| `patch` | ONE statement, RFC 7396 merge (`null` removes a field); never reads on a kind without secrets |
| `delete`, `deleteMany` | answer what they removed |
| `transact` | put / patch / delete over kinds of one file and one `transactFamily`, one transaction; results in op order |
| `query` | by `deviceId` + `atFrom`/`atTo` (half-open), or by a declared index through `where`; `limit` <= 1000; opaque keyset `cursor`, no offset |
| `count`, `histogram`, `aggregate` | index-served only; aggregates read ONE index that holds every field they name |
| `deleteWhere` | needs a predicate; 5 000 rows per statement, yielding between batches |
| `deleteDevice` | the D865 hook body: every kind declared `deviceRemoval: 'delete'` |
| `allocateId` | monotonic integer per kind |

`where` names declared index fields only: equality on the LEADING fields of one index (any order), at
most one range on the next field, `in` for count / aggregate / delete only. A where query returns in
the index's order; its cursor holds the index values after the equality prefix, so a row lacking an
ordering field cannot be paged (the engine says so). `order: 'id'` cannot be combined with a window.
There is no `scan`, no offset, no raw SQL.

## Secrets

A schema field marked `.meta({ secret: true })` (nested objects, and arrays whose elements carry a
declared id key: `secretArrayKeys: { headers: 'name' }`) is a keychain value:

1. **write** - the facade classifies each secret leaf (`classifySecretWrite`: a non-empty string sets,
   the redaction token / `''` / a marker keeps, `SECRET_CLEAR` removes), puts each new value in the
   keychain under `secret://<owner>/row/records:<kind>/<id>/<path>` FIRST, then writes the row with
   the marker. A locked keychain refuses the whole write. The engine independently refuses a plain
   string at a secret path and a marker that is not the row's own ref.
2. **read** - every read shows `REDACTED_SECRET`. `getResolved` / `query(..., { resolveSecrets: true })`
   resolve a page in ONE keychain call and THROW when the keychain cannot serve a value.
3. **release** - a write that drops a marker, a `patch` with `null`, a `delete`, `deleteWhere` and
   `deleteDevice` return the refs they released and the facade deletes the keychain values.

A kind with secret fields cannot use an engine TTL or row bound. Nothing logs a value; an error names
the kind, id and field.

## Entries

`defineEntryKind(name, { title, schema })` makes a kind an entry (a `name` field plus the kind's own).
Its declaration carries the JSON Schema of the body with `secret: true` on each credential field. The
hub-only `record-entries` builtin serves the `record-entries` capability (`listEntryKinds`,
`listEntries`, `putEntry`, `deleteEntry`, all admin) by acting for each entry's owner through
`ctx.records.forOwner` (hub in-process builtins only) over the engine's catalog
(`storageAdmin.listKinds`). The generic UI is a follow-up; the capability is complete without it.

## The migration is closed (D900)

The kinds of phases 2-6 were filled by a one-time migration: a kind named the legacy table it
`adoptsFrom`, a boot guard refused to start the addon until `storageAdmin.adoptRecords` had copied
it, and offline tools split and rehomed the files. That migration finished on the operator hubs on
2026-10-20 and its code is gone ([D900](../decisions/adr-0900-the-records-migration-is-closed-no-kind-adopts-and-the-product-carries-no-adoption-code.md)).
The key and `DeclareKindResult.adoptionPending` are out of the schema: a declaration an addon
sends is strict (an unknown key is refused), a catalog row read back at init drops keys this engine
does not know (`StoredRecordKindDeclarationSchema`), and `declareKind` rewrites a stored row whose
text differs from the declaration even when the hash agrees, so the catalog holds what was
declared. A future layout change ships without migration code (D853).

**A kind has no settings-store fallback.** A store whose kind is not bound yet
(a hub-main store constructed before the records provider is wired) is
unavailable: it writes nothing and answers its reads as unanswered, it never
`declareCollection`s the old table. `cluster-node-history`, `oauth_sessions` and
the three `backup_*` tables lost their fallback paths that way
([D902](../decisions/adr-0902-five-system-tables-are-records-only-and-device-runtime-state-stays-a-settings-door-table.md));
`device-runtime-state` is a settings-door collection, not a records candidate.

`storageAdmin.readRecords` reads any owner's kind, redacted, for diagnosis;
`storageAdmin.listKinds` feeds System -> Data.

## Guards

| Guard | Proves |
| --- | --- |
| `check-records-index-served` | every statement a declared kind promises is index-served: no scan, no sort, `kind_id` literal, counts and aggregates never read the row (opcodes) |
| `check-records-no-unindexed-where` | a literal `where` names a declared index field; no SQL on the records tables outside the engine |
| `check-durable-state-declared` | every kind says `class`, `writeTrigger`, `retention` |
| `check-physical-tables-ratchet` | the physical tables the code can create are a committed, shrink-only list (D901): new state is a record kind, a new table needs an ADR |

## Shipping

Types, system and the generated routers change, so none of it is live until a `@camstack/server`
closure containing them is installed on the hub (`camstack-server-change`); one hub restart. An
addon's own kinds ship with the addon (`camstack deploy`).

## Not built yet

The orphan lifecycle (a kind no installed package declares is marked orphaned, dropped after 14
days with a verified snapshot) and the D872 install-time reconciler.
