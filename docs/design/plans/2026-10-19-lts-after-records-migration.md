---
title: LTS P4–P5 and records phase 5 — sequencing after records A+B
status: proposed (2026-10-19)
---

# LTS and event ledgers — after records A+B

This is a **sequencing overlay**, not a replacement for the master LTS plan or
the records plan. It orders three large moves that must not interleave with
unfinished records work on the same tables.

**Do not edit** the coordinator master plan (`data_raw_tables_ui_a7c7a9e5.plan.md`).
Mechanism, tests, ADRs, and runbooks stay in the sources below.

## Prerequisite — records A+B complete first

**Nothing in this document runs until records track A+B is done:**

| Track | Scope | Authority |
| --- | --- | --- |
| **A** | Records **phases 2, 3, 4, and 6** — config documents, DurableLedger mirrors, hub-main builtins, authentication (when phase 6 is in scope for the environment) | `docs/design/records-api-plan.md` §4.2 |
| **B** | **Generic entries** — broker/integration entry kinds and UI census items that must land before event ledgers share `events.db` with high-volume kinds | `docs/design/entries-census.md`, operator decisions in `records-api-plan.md` |

Phase **0–1** (`ctx.records` primitive, dead-table drops) is assumed **built**
([D881](../decisions/adr-0881-records-are-the-third-storage-api-and-a-secret-field-is-a-feature-of-the-kind.md)).
Phase **2** config migration is **done** on `.50` and prod (`records-phase-2-migration.md`).

LTS **Stage A** (P0–P3: owned files, backups, device-history addon) from the master
LTS plan must also be **released on the hub** before Stage B below — otherwise P4
has nowhere to write and P5 has no `events.db` worker.

## Ordered sequence (strict)

Run **one step at a time**; each step ends with verify + adopt/copy as in
`records-api-plan.md` §4.1 and the LTS plan §8 hold rules where they apply.

### 1. LTS P4 — numeric series → `history.db`

**Source:** (planning repo: superpowers/plans/2026-10-15-lts-device-history-and-events-db.md) §8 **P4**, §7 “Leaves both files”.

| Leaves `camstack.db` | Becomes |
| --- | --- |
| `pipeline-analytics:stats-5m-v2` | device-history series (`recordBuckets`) |
| `pipeline-orchestrator:stats-5m-v2` | device-history series (node stress) |
| `metrics:node-load-samples`, `metrics:node-memory-samples` | device-history points (`record`) |

**Audio:** level-only rows stop going to `pipeline-analytics:audio-events`; levels
become a history series. **Class/detection rows stay** in `audio-events` until step 3.
Live `audio-metrics` and the NC sample feed are unchanged (master plan §8 P4).

**Exit criteria:** both `LtsAggregator` / legacy `stats-5m` paths gone;
`check-history-single-mechanism` green; `readLongTermSeries` reads device-history;
offline split script rehearsal can convert level rows (P7 in master plan).

### 2. LTS P5 — `events.db` split

**Source:** same LTS plan §7, §8 **P5**.

- Declare `database: 'events'` for every collection in §7 (tracks, media, event
  ledgers, vectors, NC notification history, cursors, etc.).
- `vector-store` served from the **events** worker; placement guard enforces file
  agreement.
- **Still in settings** until records phase 5: tables that phase 5 will **replace**
  with `ctx.records` kinds remain declared as collections until adopt — but their
  **files** are already `events.db` after this step.

**Exit criteria:** fresh engine creates listed tables only in `events.db`; old-layout
fixture refuses with `CollectionPlacementError`; retrain `transact` families stay
same-file atomic.

**Operator window:** this step (with P7 split script on prod) is the **offline**
cutover described in LTS §9 — hub hold, `.50` rehearsed first.

### 3. Records phase 5 — event ledgers → `records` with `database: 'events'`, then early-drop

**Source:** `docs/design/records-api-plan.md` §4.2 **phase 5**, §1 (`database` hint),
dependencies paragraph at §4.2 end.

| Constraint | Why |
| --- | --- |
| **After LTS P4** | ~2.7 M event rows drop to ~0.6 M once level rows are not in `audio-events` |
| **With / immediately after LTS P5** | High-volume kinds **must** use `database: 'events'` — retention deletes must not run on the settings thread (D447) |
| **Not before records A+B** | Config, durable mirrors, hub-main, and entries must already read `ctx.records` so manifests do not re-declare legacy tables on the hub |

**Scope (≈24 tables):** motion/audio/sensor events, faces, plates, identities +
identity-samples, vehicles + vehicle-samples, track-aliases/purity/relations/tapes,
birth-decision ledger, debug-note-archive, ops-log, retrain × 4 — see phase 5 row
in `records-api-plan.md`. **`tracks` and `media` stay tables** (§0).

**Procedure:** stop `pipeline-analytics` → deploy kinds with `adoptsFrom` →
`records-adopt` copy/verify → start → 10 min live check (§4.1).

**Early-drop:** on the hub, remove legacy `declareCollection` / `@durable` paths
for adopted kinds so D872 **orphan** + operator-approved early-drop can drop the
old tables once verify passes — same pattern as phase 2/3 (`nc-config-legacy-declare`,
`record-kinds` legacy handles). Do **not** early-drop until byte verify succeeds;
auth/keychain tables never auto-drop.

## What this document deliberately excludes

- LTS **P6–P8** (admin History UI, split script cutover, hold lift) — still required
  for prod parity; schedule **around** records phase 5 copy window.
- Records **phase 6–7** (auth, optional `object-events` fold) — separate gates in
  `records-api-plan.md`.
- The **data_raw** UI master plan — untouched.

## Reference map

| Topic | Document |
| --- | --- |
| Full LTS architecture, P0–P9 | (planning repo: superpowers/plans/2026-10-15-lts-device-history-and-events-db.md) |
| Records phases, phase 5 table list, risks | `docs/design/records-api-plan.md` |
| Phase 2 adopt runbook (pattern) | `docs/design/records-phase-2-migration.md` |
| Per-file threads, backup cadence | `docs/architecture/storage-files.md`, D851–D852 |
