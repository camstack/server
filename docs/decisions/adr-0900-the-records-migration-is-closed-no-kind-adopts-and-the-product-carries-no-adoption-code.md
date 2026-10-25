---
id: D900
title: The records migration is closed — no kind adopts a legacy table, and the product carries no adoption code
status: accepted
date: 2026-10-22
supersedes:
applies-to:
  - packages/types/src/records/record-kind.ts
  - packages/types/src/capabilities/storage-admin.cap.ts
  - packages/system/src/builtins/sqlite-storage/records/records-provider.ts
---

## Context

D881 rule 6 made adoption a boot guard: a kind named the legacy table it
`adoptsFrom`, the engine reported it adoption-pending while the kind was empty
and the table still held rows, `ctx.records.declare` refused to start the addon,
and `storageAdmin.adoptRecords` (driven by `scripts/hub/records-adopt.ts` and <!-- drift-ok -->
sixty-odd per-table mappers) copied the rows and set `_record_kinds.adopted_at`.
Around it grew `readLegacyCollection`, `isAdoptedLegacyTable`, the phase-6
declare gate with its `CAMSTACK_RECORDS_DECLARE_PHASE6` override, the offline
`scripts/ops/split-databases` tools (split, rehome, gallery and phase-5 adopt) <!-- drift-ok -->
and a set of one-shot repair scripts.

By 2026-10-20 every kind was adopted on both operator hubs, the gallery was
rehomed into `events.db`, every legacy table was dropped offline and the files
were vacuumed. No other install ever ran a pre-records build that needs a
programmatic path: the operator ruled (records-api-plan, 2026-10-20) that the
migration-only APIs and scripts go in one change.

The removal has one trap. `RecordKindDeclarationSchema` is `.strict()`, and
every catalog row the migration wrote stores its declaration WITH `adoptsFrom`;
an orphaned kind is never redeclared, and an addon built before the removal
still sends the key. Dropping the field from the schema would have made the
engine refuse its own catalog on both hubs at boot.

## Decision

No kind declares `adoptsFrom` and nothing reads it: the field is gone from the
kind spec and the builders, the schema still ACCEPTS it (read-compat for old
catalog rows and old addon bundles) and the records provider drops it before
the catalog stores a declaration. `DeclareKindResult.adoptionPending` stays on
the wire as `null` only, because an addon built before the removal reads an
absent field as pending. `storageAdmin` keeps `listTables`, `listKinds`,
`readRecords` (the System → Data page) and `dropCollection` (the D870 drop);
`adoptRecords`, `readLegacyCollection` and `isAdoptedLegacyTable` are gone. The
legacy names the guards police are a frozen list, `RETIRED_LEGACY_TABLES`,
which never grows.

## Consequences

- A hub whose catalog still carries `adoptsFrom` boots; the first
  redeclaration of each kind is `updated` once and rewrites the row without it.
- A future storage-layout change cannot reuse adoption: per D853 it ships
  without migration code and the operator converts a hub offline, by hand.
- The `adopted_at` column stays in `_record_kinds` (unread) so an older build
  can still open a file this one created.
- Kept on purpose, and open: the settings-store fallbacks of the
  notification-center and pipeline-analytics stores (`legacyCollectionKind`,
  `durableLegacyKind`, the `legacyStore` branches). Every runtime has
  `ctx.records`, so production never takes them; ~840 post-analysis specs build
  a centre without records and read their fake settings store, and moving them
  onto `makeInMemoryRecords` is its own change. The D870 device-store migration
  (`migrate-device-store.ts`, `assertLegacyBlobsMigrated`, the D877 update
  pre-flight, `dropCollection`) is a different migration and is untouched.

## Enforcement

- `packages/types/src/capabilities/__tests__/storage-admin.cap.spec.ts` pins
  the four storage-admin methods.
- `records-provider.spec.ts` (D900 cases): a retired `adoptsFrom` over a full
  legacy table in either file declares with `adoptionPending: null`, the catalog
  stores it without the key, and a migration-era catalog row still loads.
- `scripts/__tests__/records-no-adoption.spec.ts`: no record kind in the tree <!-- drift-ok: deleted 2026-10-23, the key left the schema -->
  declares `adoptsFrom`.
- `scripts/check-no-legacy-table-access.ts`, `pa-boot-declare.spec.ts` and <!-- drift-ok: deleted 2026-10-22 (D901) -->
  `nc-boot-reads-no-legacy-table.spec.ts` read `RETIRED_LEGACY_TABLES`.
