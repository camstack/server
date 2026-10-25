---
title: Records / LTS migration handover — wait for parallel WIP, then one release
status: closed (2026-10-22 — migration complete on `.50` and prod; the migration-only APIs and scripts removed with D900)
owner-session: records finish + twenty-tables / H
parallel: dishwasher / device-adoption / Bosch (other agent) — fold into ONE release
---

# Handover — records + LTS cutover (2026-10-20)

> **Closed 2026-10-22.** Every kind is adopted on both operator hubs, the
> gallery lives in `events.db`, all legacy tables were dropped offline and the
> files vacuumed. The migration-only surface of §7 is deleted in one change
> ([D900](../../decisions/adr-0900-the-records-migration-is-closed-no-kind-adopts-and-the-product-carries-no-adoption-code.md)):
> `adoptsFrom`, the boot guard, `storageAdmin.adoptRecords` /
> `readLegacyCollection` / `isAdoptedLegacyTable`, the phase-6 declare gate,
> the adopt / mapper / rehome / split / repair scripts. What is kept and why is
> in D900's Consequences. The rest of this page is the session record as it
> stood; the scripts it names no longer exist.

Read this before continuing. Longer plans stay authoritative; this file is the
**session state** and the release gate.

| Document | Role |
| --- | --- |
| `docs/design/records-api-plan.md` | Target shape (17 logical tables), phases 0–7 |
| `docs/design/plans/2026-10-19-lts-after-records-migration.md` | Sequencing P4 → P5 → phase 5 |
| `docs/design/plans/2026-10-20-records-finish-checklist.md` | Checkbox history of this cutover |
| (planning repo: sessions/sessions.md) | Dated ops notes (top entries 2026-10-20) | <!-- drift-ok: moved to the private planning repo -->
| Personal skill `camstack-homelab-ops` | Hosts, login, Path B fan-out |

---

## 1. Release rule — OBSOLETE (2026-10-21)

The parallel WIP is merged; this rule no longer applies. Kept for the record.

**Do not push / Publish Packages / Path B closure for “records alone” while the
parallel WIP is still open.** The working tree already mixes:

- This track: DurableLedger `deviceId` header, `stats-5m-v2` allowlist, PA
  deploy stamps, docs, offline drop scripts/notes.
- Parallel track (same clone): device-adoption as **collection** (ADR-0886),
  dishwasher options/UI, Bosch/Home Connect pieces, primary-child
  `dishwasher` priority, related codegen/i18n.

**Expectation:** when the parallel agent finishes, **reconcile one dirty tree**,
one `verify:push` GREEN, **one commit train / one Path A (or one Path B)**, then
deploy. Avoid “published records, dishwasher still local”.

Until then: keep iterating locally; hub already has the **ops** side of this
track applied (see §3).

---

## 2. Auth / how to talk to the hubs

- Prefer: `camstack login <host>` (TTY). An **admin user’s login JWT** is enough
  for `hub.mjs` / ops MCP — **`--admin` / `csa_` is no longer required**.
- `whoami` should show `admin: yes`, `kind: jwt`.
- CA: `~/.camstack/<hub-ip>_4443.ca.pem` (prod), `…50_4443.ca.pem` (dev).
- Order: **`.50` before prod** for any further offline SQLite / adopt / DROP.
- Never open a live `.db` while CamStack runs (D679). Offline DROP = stop
  container → sqlite3 / script → start → `/health` 200.

---

## 3. What is already LIVE (prod + `.50`)

### Storage layout

- Three files: `settings` / `events` / `history` (`databaseSnapshot.listDatabases`).
- Records phases **2–6 + gallery (identities/samples/vehicles)** adopted.
- LTS **P5** split done; phase 5 ledgers on events; **H**: orphan
  `pipeline-analytics:stats-5m-v2` + `pipeline-orchestrator:stats-5m-v2`
  **offline DROP** (prod rows **1 137 402** + **225 716**; `.50` empty).
  Live writers use `deviceHistory.recordBuckets` (no `LtsAggregator`;
  `check-history-single-mechanism` green). `metrics:node-*` already gone.

### Post-analysis

- Deployed **`@camstack/addon-post-analysis@1.2.606`** on hub + agents
  (agent-a, Mac Mini, agent-b).
- DurableLedger headers `deviceId` (`deviceIdOf` / body); write-behind `put`
  passes `row`. Hub logs: **0** `deviceId is required` after reload.
- EmbeddingConversion: faces legacy absent (skip); identity-samples 828
  “unusable” with vectors already in `vec_identity_arcface` — expected.

### Census snapshot (prod, evening 2026-10-20)

| Metric | Value |
| --- | --- |
| `listTables` rows | ~152 (includes multi-DB duplicates) |
| Unique table names | ~105 |
| PA nonzero | **tracks / media / object-events only** |
| `stats-5m*` | **absent** |
| PA/NC zero-row shells | ~34 unique names (almost none `declaredThisBoot`) |
| NC still filled (legacy physical) | `outbox` ~522, `artifacts` ~108, `meta` 1 |
| `deviceHistory` | `ready`, ~1588 series |

STAY forever as own tables (plan): tracks, media, object-events (until optional
phase 7), segment-hours, devices, keychain secrets/keys, vec roots.

---

## 4. What is in the TREE but not fully shipped as a registry release

- ~~`STORAGE_ADMIN_MOVED_COLLECTIONS` += `stats-5m-v2` ×2~~ — **reverted
  (operator, 2026-10-20)**: no allowlist growth; old tables are dropped by
  hand, offline, on the operator's hubs only (records-api-plan, operator
  decisions).
- DurableLedger `buildPut` / `resolveRecordDeviceId` / write-behind `row` synced
  across **post-analysis, pipeline, pipeline-orchestrator**.
- Tests/i18n/codegen aligned so **`npm run verify:push` is GREEN** on the mixed
  tree (re-confirm after the parallel agent’s last edits).
- Checklist + sessions updated; this handover file.

**Not committed / not Path A’d** as a single “records finish” release — waiting
on §1.

---

## 5. Target table count (when migration cleanup finishes)

From `records-api-plan.md` §3:

- **17 logical** tables (settings trio, runtime-state, engine catalogs,
  `records`×2 files, devices, keychain×2, tracks/media/object-events,
  segment-hours, vec_indexes + 3 vec0).
- **Physical core** ≈ 18 + ~36 vec shadows (+ engine helpers).
- **`history.db` is outside the 17** (device-history series/rollups).
- Optional **phase 7** → 15 logical if `object-events` + `device-runtime-state`
  fold after N100 measurement.

Today’s ~105 unique names → drop toward that by removing **empty PA/NC shells**
and finishing **NC outbox/artifacts/meta** (and any remaining dual-declared
kinds), not by another DB split.

---

## 6. Open work (ordered)

### A. After parallel WIP lands (same release)

1. Rebase/reconcile dirty tree; `npm run codegen` if caps moved again.
2. `npm run verify:push` GREEN (mandatory).
3. Commit with **named paths** (never `git add -A`).
4. Choose **one** ship channel:
   - Path A if durable registry state: push → Publish Packages
     (`include_dependents=false`; force system/server if caps/types) →
     `applyServerUpdate` hub then every online agent → `camstack deploy` for
     touched addons → verify versions.
   - Path B if still iterating closures: `deploy --closure` `.50` then prod,
     then addon deploys.
5. Never leave published-but-not-applied.

### B. Migration cleanup still on the product (can be same release or +1)

1. **Strip legacy `declareCollection` / empty shells** for adopted PA/NC kinds
   so empty tables do not come back; then DROP orphans **offline, by hand, on
   `.50` then prod** (operator decision 2026-10-20: no allowlist, no D872
   scheduled drop).
   **Code done 2026-10-21:** no boot declares a legacy table on ANY role
   (`pa-boot-declare.ts`: tracks / media / object-events only; spec
   `pa-boot-declare.spec.ts`). The DROP list is §6.D.
2. **NC `outbox` / `artifacts` / `meta` / `track-groups` / `snooze-suppressed`:**
   audit 2026-10-20 — the record kinds exist (`nc-durable-record-kinds.ts`,
   `adoptsFrom`) but are EMPTY; `outbox.ts`, `artifact-index.ts`,
   `nc-group-store.ts` still read and write the legacy tables
   (`declareNcPhase3SettingsStoreLegacyCollections` on every node), and no
   mapper exists. The boot guard misses it (it counts legacy rows in the
   settings file only; four of the five moved to events.db).
   **Operator decision 2026-10-20: move them onto records** like the other
   seven NC ledgers — store rewrite, mapper, offline adopt `.50` → prod,
   byte-verify, DROP by hand.
   **Code done 2026-10-21:** the five stores read and write `ctx.records`
   (data-field indexes, camera on the envelope; D865 removal and
   `listDeviceData` read the envelope); mapper
   `scripts/hub/records-mappers/notification-center-phase3-queried-ledgers.ts`; <!-- drift-ok -->
   the boot guard counts legacy rows in every open file. Offline run: §6.D.
3. **Gallery placement:** `identities` / `vehicles` default to settings while
   their `*-samples` are `database: 'events'`; no kind sets `transactFamily`
   and the reconciler does not enforce it (plan §5 risk 8).
   **Operator decision 2026-10-20: the whole family in events** —
   `database: 'events'` on both, `transactFamily` enforced by the reconciler,
   offline rehome `.50` → prod.
   **Code done 2026-10-21:** both declare `database: 'events'` and a
   `transactFamily` (`identity-gallery`, `vehicle-gallery`; retrain × 4 →
   `retrain`); `declare` refuses a split family. A new pipeline-analytics on a
   hub where identities/vehicles still sit in camstack.db REFUSES to start
   ("lives in settings, declared for events") until rehomed: §6.D step 6.
4. **Agents recreate shells (inferred):** the legacy declares are skipped on
   the hub only (`if (!isHub)`); a forked pipeline-analytics on an agent
   forwards its settings store to the hub. Confirm with `listTables` after an
   agent restart; fix with the shell strip of item 1.
   **Code done 2026-10-21:** the strip of item 1 is role-independent (the
   agent's `ctx.records` already reaches the hub's engine; the legacy declares
   were the only thing an agent still did with these tables).
5. **D PWA:** operator re-login after TLS cert change (viewer/admin).
6. Optional: `VACUUM` on settings after large DROPs (hub stopped); reclaim was
   not automatic (file size stayed ~599 MB right after stats drop).
7. Optional phase 7 measurements — only if operator wants the last two folds.
8. **Drop by hand (no owner any more, D894, 2026-10-21):** the
   `viewer-settings-snapshots` record kind (owner `pipeline-analytics`) — its
   actions and its registration were removed; the rows are D585 snapshots
   nothing reads — and the legacy `pipeline-analytics:viewer-settings-snapshots`
   table wherever it still exists. Offline, `.50` then prod, after the viewer
   build that no longer calls `viewerSettings.*` is out.

### D. Offline operator sequence (`.50` completely, then prod)

What ships: a `@camstack/server` closure (the boot guard across files, the
`transactFamily` check — `packages/system`) and `@camstack/addon-post-analysis`
(stores, kinds, boot declares). Nothing below runs against a live file (D679).

1. **Snapshot, old build running:**
   `npx tsx scripts/hub/records-adopt.ts --server <hub> --snapshot --owner pipeline-analytics --mapper scripts/hub/records-mappers/notification-center-phase3-queried-ledgers.ts`
   (counts + content hash of outbox, artifacts, track-groups, snooze-suppressed, meta).
2. **Stop pipeline-analytics on the hub AND every agent** (`addons.stop`). From
   here nothing may write the legacy NC tables. (Once the new closure is
   applied, an OLD pipeline-analytics refuses to start anyway: the guard now
   sees the 522 outbox rows in events.db.)
3. **Apply the closure** (`applyServerUpdate`, hub, then each agent by `nodeId`).
4. **Deploy the new pipeline-analytics build** (`camstack deploy
   packages/addon-post-analysis`, hub + agents). It will NOT start yet — either
   `AdoptionPendingError` (outbox) or the gallery placement refusal. That is
   the guard, not a fault; the CrashSupervisor marks it failed.
5. **Adopt the five NC kinds:** `records-adopt.ts --copy` (dry run: per-kind
   counts, sample ids), then `--copy --apply --owner-stopped` with the same
   mapper. Any read-back difference exits 1; stop there.
6. **Rehome the gallery, hub STOPPED** (container down, `database-snapshot` of
   camstack.db + events.db taken first):
   `npx tsx scripts/ops/split-databases/rehome-cli.ts <sqlite-settings-dir> --dry-run`
   — expect `identities` and `vehicles` (prod ~ the identity count / vehicle
   count, `eventsKindId: null`); then the same without `--dry-run`. Each kind
   moves in one transaction, verified (count + sha256); the report's
   `contentHash` must equal the dry run's. Re-running reports `kinds: []`.
   Data dirs: prod `/mnt/mixed/camstack/addons-data/sqlite-settings/` (unraid),
   `.50` `/opt/camstack/data/addons-data/sqlite-settings/` (CT200).
7. **Start the hub**; pipeline-analytics boots (all kinds adopted, the family in
   one file). Passive check: NC history/artifacts answer, `hub_logs` clean for
   10 min, `storageAdmin.listKinds` shows identities/vehicles on `events`.
8. **DROP by hand, offline** (hub stopped, after 5 and 6 verified on THIS hub).
   Per table, in the file named: `DROP TABLE IF EXISTS "<t>"; DELETE FROM
   _collection_declarations WHERE name = '<t>';` — the declaration row must go
   with the table, or the router still believes it is declared. Every table is
   a legacy table a records kind adopted from; after this change no boot, on
   any role, declares one, so a dropped table stays dropped. Expect 0 rows in
   all but the five NC tables of step 5 (whose rows now equal the adopted
   count); stop on any other non-zero.

   | File | Tables |
   | --- | --- |
   | `events.db` | `notification-center:outbox`, `notification-center:artifacts`, `notification-center:track-groups`, `notification-center:snooze-suppressed`; `pipeline-analytics:motion-events`, `:audio-events`, `:sensor-events`, `:faces`, `:plates`, `:identity-samples`, `:vehicle-samples`, `:track-aliases`, `:track-purity`, `:track-relations`, `:tracking-tapes`, `:birth-decision-ledger`, `:debug-note-archive`, `:ops-log`, `:retrain-frames`, `:retrain-annotations`, `:retrain-collections`, `:retrain-collection-frames`, `:migrations`, `:sweep-cursors` |
   | `camstack.db` | `notification-center:meta`, `:liveness`, `:device-alerts`, `:system-state`, `:alert-episodes`, `:occupancy`, `:device-prunes`, `:state-summary-stamps`, `:snoozes`, `:rules`, `:rule-ai`, `:summary-rules`, `:timelapse-rules`, `:calendar-events-rules`, `:sequences`, `:texts`; `pipeline-analytics:identities`, `:vehicles`, `:scenes`, `:face-rescore-state`, `:viewer-settings-snapshots`, `:phantom-cells`, `:package-background`, `:stationary-evidence`, `:stationary-objects`, `:scene-latch` |

   (50 tables; `:x` abbreviates the prefix of the row. The list is every
   `adoptsFrom` of `pipelineAnalyticsRecordKinds`, `ncRecordKinds` and
   `ncDurableRecordKinds`; the file is the legacy declaration's `database`, or
   the P5 split list `scripts/ops/split-databases/constants.ts`.) A table <!-- drift-ok -->
   already absent is fine (`IF EXISTS`). Then optionally `VACUUM` (item B.6).
9. Confirm with `storageAdmin.listTables` after an AGENT restart that none of
   them came back (item B.4).

### C. Out of scope for this handover

- Bosch / dishwasher **product** behaviour (parallel agent).
- P6 History UI / LTS↔consumo UI.
- plugin catalog (never touch).

---

## 7. Migration-specific APIs — retired (D900, 2026-10-22)

| Surface | Outcome |
| --- | --- |
| `adoptRecords` / `readLegacyCollection` / `isAdoptedLegacyTable` | **Removed** from `storage-admin.cap.ts` and the engine |
| `adoptsFrom`, the boot guard, `_record_kinds.adopted_at` | No kind declares it; the schema still ACCEPTS it (old catalog rows, old addon bundles) and the provider drops it before storing; `adoptionPending` stays on the wire as `null`; the column stays, unread |
| Phase-6 declare gate + `CAMSTACK_RECORDS_DECLARE_PHASE6` | **Removed**; local-auth, keychain and alert-center declare their kinds directly |
| Scripts: records-adopt, records-mappers, the split-databases tools (split, history-migrate, gallery / phase-5 adopt, rehome), drop-dead-tables, rewrite-stats-5m, prune-liveness-orphans, repair-integration-secret-markers, restore-reconciled-rows, the legacy readers | **Deleted** with their specs |
| `STORAGE_ADMIN_MOVED_COLLECTIONS` | Shrunk to the six D870 names (the D871 / phase-0 leftovers are gone) |
| `storageAdmin.dropCollection` + `migrate-device-store.ts` | **Kept**: the D870 device-store migration, with its live boot guard and the D877 update pre-flight — a different migration, not retired here |
| The NC / PA legacy handles (`legacyCollectionKind`, `durableLegacyKind`, the stores' static `declare`) | **Kept** as the spec harness only (the two declare helpers moved under `notification-center/__tests__/support/`); production never takes them. Moving ~840 specs onto records is open |
| The legacy table names | Frozen in `packages/addon-post-analysis/src/retired-legacy-tables.ts`, read by `check-no-legacy-table-access` and the boot specs | <!-- drift-ok: deleted 2026-10-22 (D901) -->

---

## 8. Useful commands

```bash
# Auth
camstack login <hub-ip>          # admin JWT; no --admin
camstack whoami -s https://<hub-ip>:4443

# Census
export CAMSTACK_HUB_CA_FILE=~/.camstack/<hub-ip>_4443.ca.pem
node scripts/hub/hub.mjs GET storageAdmin.listTables '{}'
node scripts/hub/hub.mjs GET deviceHistory.getStatus '{}'
node scripts/hub/hub.mjs GET databaseSnapshot.listDatabases '{}'

# Gate before any push
npm run verify:push

# Offline DROP pattern (hub STOPPED) — prod data dir
# /mnt/mixed/camstack/addons-data/sqlite-settings/camstack.db  (unraid)
# .50: /opt/camstack/data/addons-data/sqlite-settings/camstack.db (CT200)
```

Addon deploy (session with addons scope is enough):

```bash
node packages/cli/dist/cli.js deploy packages/addon-post-analysis -s https://<hub-ip>:4443
node packages/cli/dist/cli.js deploy packages/addon-post-analysis -s https://<hub-ip>:4443 -n <nodeId>
```

---

## 9. Definition of “migration track done” for the next agent

- [ ] Parallel WIP merged into this tree; single release shipped (§1 / §6.A).
- [ ] Empty PA/NC shells gone and not recreated on boot.
- [ ] NC outbox/artifacts/meta not dual-living as legacy tables (or explicitly
      accepted with a recorded reason).
- [ ] `listTables` unique count explained vs the 17-logical target (dual count
      in sessions: logical vs physical).
- [x] Migration API retirement planned or done (§7) — D900, 2026-10-22.
- [ ] D PWA smoke (operator).
- [x] Checklist Blocco 6/7 boxes match reality; this handover marked
      `status: closed` with date (2026-10-22).

Until then, treat prod as **cutover-stable for data paths** (tracks/media/events
+ history) and the repo as **release-blocked on parallel WIP**.
