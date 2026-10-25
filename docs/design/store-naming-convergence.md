---
title: Store naming convergence — four conventions, one door, and a guard nobody runs
status: audit executed in part — Phases 0 and 1 shipped 2026-08-19; Phases 2-6 planned
date: 2026-08-19
last-verified: 2026-08-26
covers:
  - packages/system/src/builtins/device-manager/device-row-store.ts
  - packages/system/src/builtins/sqlite-storage/sqlite-settings-backend.ts
  - packages/system/src/kernel/config-manager.ts
  - packages/system/src/kernel/moleculer/addon-context-factory.ts
  - packages/types/src/capabilities/settings-store.cap.ts
  - packages/types/src/interfaces/storage.ts
  - scripts/check-collection-namespacing.ts
  - scripts/lib/parse-storage.ts
---

# Store naming convergence

> **This page is a dated AUDIT and a PLAN, not a description of the current
> code.** Every row count, table name and schema in it was measured on
> **2026-08-19** against a read-only evidence copy of the database (see the
> status box below); phases 0 and 1 shipped that day and phases 2–6 are still
> unbuilt. It therefore carries `covers:` rather than `applies-to:` — it cites
> specific facts out of those files, it does not vouch that they were re-read on
> `last-verified` (D145), and a plan phase that has not been built cannot be
> verified against code at all.
>
> **Checked 2026-09-15, without re-measuring:** the two structures the audit
> turns on are still there — `readDeviceStore` still resolves to
> `addon-device-settings` hub-local and `<addonId>:addon-devices` forked (§3.1),
> and `ALLOWED_BARE` in `scripts/check-collection-namespacing.ts` still carries
> its single `viewer-settings-snapshots` entry with
> `viewer-settings-legacy-adoption.ts` alive beside it, so the §6 Phase 1 rename
> is still mid-adoption. Phase 2's mechanism has advanced without its items:
> `RETIRED_COLLECTIONS` gained a third entry on 2026-09-01 (the co-moving group
> entity), none of the removals §6 Phase 2 lists.

> **STATUS, 2026-08-19: the audit is executed in part.** Phase 0 (CI re-enabled)
> and Phase 1 (both red guards fixed) shipped the same day; §6 carries what
> landed and what did not. The operator's question that started it, verbatim: *"possiamo cogliere il momento
> per unificare un po' le strutture? Ogni addon usa lo stesso naming etc?"*
>
> The short answer is **no, four conventions coexist — but the naming is not the
> expensive problem this audit found.** Two things outrank it, both measured
> below: the CI workflow that enforces every guard in `scripts/` is
> `disabled_manually` on GitHub and has not run since **2026-04-18** (§0), and
> the same logical API (`ctx.settings.readDeviceStore`) writes **two different
> tables depending on whether the addon is forked or hub-local** (§3.1).
>
> Every row count, table name and schema in this document was measured on
> 2026-08-19 against the **evidence copy** of the incident,
> `/mnt/cache/appdata/camstack/db-incident-20260819/camstack-recovered.db`, in
> `mode=ro`. The production database was NOT opened — that is what caused
> yesterday's corruption. **The copy was taken at 17:57, which is BEFORE the
> device-manager flatten cutover the same evening**, so it still shows
> `device-manager.deviceMeta` / `.deviceMetadata` / `.deviceIndex` in
> `addon-settings` and does NOT yet show `device-manager:devices`. Every figure
> below is read with that offset in mind and says so where it matters.

**What this document is NOT.** It does not re-measure per-table blob shapes,
predicates or index plans — that is
[`2026-08-03-storage-table-map.md`](./2026-08-03-storage-table-map.md), and its
§3 is still the reference. It does not re-litigate the JSON-blob-vs-rows
question — that is
[`durable-store-convergence.md`](./durable-store-convergence.md), which condemns
the shared blob with a measured failure, and D182, which applied the verdict to
the fleet. This document asks one question those two did not: **what is a
collection called, who decided, and what stops the next one being wrong.**

---

## 0. The finding that reorders the whole plan

**No guard in `scripts/` is enforced on `main` today.**

```
$ gh workflow list --all
Release — CamStack (Docker + Electron)   active
Publish Packages                         active
Prebuild shm-ring                        active
CI                                       disabled_manually       ← 54 guards
$ gh run list --workflow=ci.yml --limit 1
success   2026-04-18T20:58:29Z
```

`ci.yml` itself opens with the warning that this already happened once:

> *Dormant from 2026-04-18 to 2026-07-31 — the workflow was `disabled_manually`
> in the GitHub UI, so three months of commits landed on main with nothing
> checking them. Everything below assumes that can happen again […]*

It happened again. And it is not theoretical — **two guards are RED on `main`
right now**, both about the subject of this audit:

| Guard | State on `main` | What it says |
| --- | --- | --- |
| `check-collection-namespacing.ts` | **RED** | `"viewer-settings-snapshots"` in `packages/addon-post-analysis/src/pipeline-analytics/viewer-settings-actions.ts` — an addon took a bare name | <!-- drift-ok: deleted with D894 -->
| `check-durable-state-declared.ts` | **RED** | `"device-manager:devices"` — `class="registry"` is not one of `ledger \| mirror \| ephemeral \| config \| audit` (D182, landed yesterday) |

The namespacing guard landed **2026-08-03**. The violation landed
**2026-08-17**. Fourteen days, one guard, zero signal.

**What re-enabling it actually exposed, 2026-08-19.** The two guards above were
not the whole debt — they were the two this document happened to be about. With
CI back on, the `Repository guards` step failed on **eight**, and six had
nothing to do with storage naming. All eight are now green (`41 ✔`, step
passing); the breakdown is worth recording because only two of the eight were
real violations:

| Guard | What it actually was |
| --- | --- |
| `check-collection-namespacing` | **a real violation** — §3.9 |
| `check-durable-state-declared` | **a real violation** — an invented sixth class |
| `check-age-keyed-retention` | **a real gap** — seven collections nobody had decided the retention model of |
| `check-nc-text-catalog` | **a real drift** — plural variants disagreeing on their placeholder set |
| `check-core-router-classification` | **the guard's own bug** — it counted `protectedProcedure` in a docblock explaining that the router no longer uses it |
| `check-single-recorded-surface` | **the guard's own bug** — pinned to a directory deleted months ago; it CRASHED with ENOENT rather than reporting, taking the whole step down every run |
| `check-single-copy-layout` | **intended drift** — D129 moved `NODE_PATH`/`FRAMEWORK_DIR` from baked constants to fallback-only exports, so the textual count rose while the live resolution paths fell. Re-pinned |
| `check-method-tiers` | **intended** — five methods added during the blackout, each tier confirmed against its `*.cap.ts` |

**Two of the eight were guards reporting themselves.** That is the cost of the
blackout that nobody counts: a guard that breaks while nothing runs it is
indistinguishable from a guard that found something, and the crash one had been
silently voiding *every other guard in the step* for as long as it ran.

**Consequence for this document:** the deliverable "propose a guard" is the
cheapest and least valuable item on the list, because *the guard that would have
prevented the drift already exists and is already correct*. Writing a second one
while the harness is off is the "leftover that describes the right design"
failure CLAUDE.md names. **Re-enabling CI is item 0 of the plan and everything
else is downstream of it.**

---

## 1. How a table name comes to exist — five routes, not one

You cannot judge a name without knowing which door made it. There are five, and
only two of them are under a developer's direct control.

| # | Route | Produces | Who chooses the name |
| --- | --- | --- | --- |
| 1 | `CANONICAL_KV_COLLECTIONS` — a fixed array in `SqliteSettingsBackend.CANONICAL_KV_COLLECTIONS`, materialised at every boot | 9 bare tables, `(id TEXT PK, data TEXT NOT NULL)` | the kernel, once, in one array |
| 2 | `SqliteSettingsBackend.requireDeclared()` auto-create — a scoped read/write of a canonical collection creates `<prefix>:<canonical>` **on demand** | 61 `…:addon-settings` + 7 `…:addon-devices` | **nobody** — the prefix is whatever string the caller passed as `namespace` |
| 3 | `declareCollection` with a hand-written prefixed literal (`'pipeline-analytics:tracks'`) | 47 typed domain tables | the addon author, by typing the prefix into the string |
| 4 | `declareCollection` with a bare literal (`'users'`, `'core_blocks'`) | 15 kernel tables + 1 addon violation | the kernel author (and one addon that slipped) |
| 5 | `sqlite-vec` internals — `${registryTable}` interpolation in `vector-index-vec.ts` | 13 `vec_*` tables | the sqlite-vec extension |

Route 2 is the one that matters and is the least understood. `requireDeclared`
does **not** check the prefix against anything:

```ts
const colonIdx = scoped.indexOf(':')
if (colonIdx > 0) {
  const baseCollection = scoped.slice(colonIdx + 1)
  if (SqliteSettingsBackend.CANONICAL_KV_COLLECTIONS.includes(baseCollection)) {
    this.getDb().exec(`CREATE TABLE IF NOT EXISTS "${scoped}" …`)
```

**Any string before the colon materialises a table.** That is the whole
explanation for `addon-pipeline:addon-devices` (a package name, not an addon id)
and for the five `core-block-<uuid>:addon-settings` — nobody wrote either name
down anywhere.

And the capability's own docblock is honest about the door
(`settings-store.cap.ts`, `settingsStoreCapability` docblock):

> *Scoping is the CALLER's, and it is opt-in. The table is
> `namespace ? \`${namespace}:${collection}\` : collection` — nothing consults
> the identity of the caller. […] Making the door enforce it is tracked
> separately — it renames tables, so it needs a migration.*

That sentence is the crux of this whole audit and §4 answers it.

---

## 2. The inventory

**154 tables** on the evidence copy. They break down as:

| Group | Tables | Route | Where the detail is |
| --- | ---: | --- | --- |
| Canonical KV, bare | 9 | 1 | §2.1 |
| `<prefix>:addon-settings` | 61 (37 empty) | 2 | §2.2 |
| `<prefix>:addon-devices` | 7 (4 empty) | 2 | §2.2 |
| Declared domain collections | 62 | 3 + 4 | §2.3 |
| `vec_*` sqlite-vec internals | 13 | 5 | leave alone |
| `sqlite_sequence` | 1 | SQLite | leave alone |
| `lost_and_found` | 1 | `.recover` artefact | §3.6 |

### 2.1 The 9 canonical KV collections — kernel-owned, bare kebab

| Table | Rows | Owner | Live? | Verdict |
| --- | ---: | --- | --- | --- |
| `system-settings` | 26 | `SqliteSettingsBackend.getSystemSetting` / `setSystemSetting` | **yes** | **kernel-legittima** |
| `addon-settings` | 24 | `config-manager.ts` `getAddonConfig` + `SqliteSettingsBackend.getAllAddon` | **yes** | **kernel-legittima**. The 24 rows on this copy still include the three device-manager blob keys purged the same evening by D182 |
| `addon-device-settings` | **5787** | `SqliteSettingsBackend.getAddonDeviceSettings` / `setAddonDeviceSetting`, reached only via `ConfigManager.createSettingsView` | **yes** | **kernel-legittima** — but see §3.1, it is HALF a mechanism |
| `device-runtime-state` | 912 | `SqliteSettingsBackend.getDeviceRuntimeState` / `writeDeviceRuntimeState` | **yes** | **kernel-legittima** (D131) |
| `alerts` | 500 | `packages/system/src/builtins/alerts/alerts.addon.ts` (`ALERTS_COLLECTION`) | **yes** | **kernel-legittima**, but see §3.5 — it is a builtin addon squatting a canonical slot |
| `sections` | 0 | `addon-context-factory.ts` `getSection`/`setSection` | mechanism live, never used | **grandfathered** — keep, it costs 4 KB and the accessor is public API |
| `provider-settings` | 0 | `SqliteSettingsBackend.getProviderSettings` / `setProviderSetting` | **NO — zero production callers** | **residuo da rimuovere** (§3.4) |
| `device-settings` | 0 | `SqliteSettingsBackend.getDeviceSettings` / `setDeviceSetting` | **NO — zero production callers** | **residuo da rimuovere** (§3.4) |
| `addon-devices` (unscoped) | 0 | created by route 1 only; every write goes to the SCOPED variant | **NO** | **residuo da rimuovere** (§3.2) |

> **None of these nine carries a `@durable` annotation.** `buildStorageMap`
> (`scripts/lib/parse-storage.ts`) filters the canonical list out of the
> declared surface, and `check-durable-state-declared.ts` only walks the
> declared surface. So the classification debt that
> `durable-store-convergence.md` recorded as *"44 → 0, the whole declared
> surface"* is zero **over the declared surface only** — the three largest live
> kernel KV tables (`addon-device-settings` 5787, `device-runtime-state` 912,
> `alerts` 500) have never had a class assigned. This is a real hole in an index
> that reads as complete, and it is cheap to close.

### 2.2 The 68 auto-created scoped variants — nobody's, by construction

61 `…:addon-settings` (37 empty) + 7 `…:addon-devices` (4 empty). They are
declared in **no source file**; `storage.md §2` says so outright. The
interesting rows:

| Table | Rows | Reading |
| --- | ---: | --- |
| `recorder:addon-settings` | 1 row, `root`, **201,833 bytes** | the "lavoro 2" blob another agent is flattening |
| `stream-broker:addon-settings` | 1 row, `root`, **33,155 bytes** | same |
| `detection-pipeline:addon-devices` | 266 (only **1** non-`{}`) | 265 empty-object rows — a write-on-touch path |
| `pipeline-orchestrator:addon-devices` | 63 (only **10** non-`{}`) | same |
| `pipeline-analytics:addon-devices` | 3 | genuine per-device overrides |
| `osd-manager:addon-devices` | 1 | genuine |
| `motion-wasm:addon-devices`, `snapshot:addon-devices` | 0 | never written |
| `addon-pipeline:addon-devices` | 0 | **residuo** — prefix is a PACKAGE name (§3.3) |
| 5 × `core-block-<uuid>:addon-settings` | 0 each | **residuo** — `core_blocks` itself is 0 rows (§3.3) |
| 37 empty `<addon>:addon-settings` | 0 | cosmetic; 4 KB each; created by an addon that wrote once and was rolled back, or by boot-time touch |

### 2.3 The declared domain collections — 62 on disk, 63 in source

(The one extra in source is `device-manager:devices`, declared yesterday by D182
and therefore absent from a copy taken before the cutover. 47 are scoped,
16 are bare.)

Ownership is already generated in `docs/reference/storage.md §3` and I am not
restating it — that is the rule. What the generated map does **not** say, and
what this audit adds, is the convention each one follows and the verdict:

| Owner family | Count | Table convention | Column convention | Verdict |
| --- | ---: | --- | --- | --- |
| `pipeline-analytics:*` (post-analysis) | 19 | scoped kebab | **camelCase** | **conforme** |
| `notification-center:*` (post-analysis) | 13 | scoped kebab | **camelCase** | **conforme** |
| `ai:*` | 6 | scoped kebab | **camelCase** | **conforme** |
| `pipeline-orchestrator:*` | 3 | scoped kebab | camelCase | **conforme** |
| `recorder:segment-hours` | 1 | scoped kebab | camelCase | **conforme** |
| `notifiers:notification-targets` | 1 | scoped kebab | KV blob | **conforme** but INVISIBLE to every tool (§3.7) |
| `provider-homeassistant:ha-notification-targets` | 1 | scoped kebab | KV blob | same |
| `device-manager:devices` | 1 | scoped kebab | camelCase | **conforme** (D182, not on this copy) |
| `auth-webauthn:user_passkeys`, `…:user_passkey_prefs` | 2 | scoped **snake** | camelCase | **da rinominare** — the only two of their kind (§3.8) |
| `local-auth`: `users`, `api_keys`, `scoped_tokens`, `oauth_sessions`, `user_totp` | 5 | bare **snake** | **camelCase** | **kernel-legittima** |
| `integration-registry`: `integrations`, `integration_settings` | 2 | bare **snake** | **snake_case** | **kernel-legittima**, column outlier |
| `integration-registry`: `devices`, `device_settings_kv` | 2 | bare snake | snake_case | **residuo — già in rimozione** (D183, another agent) |
| `storage-orchestrator`: `storage_locations` | 1 | bare snake | **snake_case** | **kernel-legittima**, column outlier |
| `backup-orchestrator`: `backup_schedules`, `backup_destination_policies` | 2 | bare snake | **snake_case** | **kernel-legittima**, column outlier |
| `core-blocks`: `core_blocks` | 1 | bare snake | camelCase | **kernel-legittima** |
| `share-token.service.ts`: `share_view_tokens` | 1 | bare snake | KV blob | **kernel-legittima** |
| `cluster-node-history-store.ts` | 1 | bare **kebab** | camelCase | **kernel-legittima**, table-name outlier |
| `viewer-settings-snapshots` | 1 | bare kebab, **declared by an ADDON** | camelCase | **da rinominare — guard RED** (§3.9) |

**The column split is the finding nobody asked about and it is bigger than the
table split.** Column names appear in every `filter.where`, every `orderBy` and
every `set()` in the codebase; a table name appears once per store. And the
split is not addon-vs-kernel — it is *authoring lineage*:

```
users        ("passwordHash","allowedProviders","createdAt","updatedAt")   camelCase
api_keys     ("tokenHash","tokenPrefix","lastUsedAt")                      camelCase
core_blocks  ("updatedAt","placement","block")                             camelCase
cluster-node-history ("lastActive","descriptor")                           camelCase
                                        ── vs ──
integrations       ("addon_id","created_at","updated_at")                  snake_case
storage_locations  ("display_name","provider_id","is_default","is_system") snake_case
backup_schedules   ("location_ids","retention_count","last_run_at")        snake_case
device_settings_kv ("device_id","value_type")                              snake_case
```

**camelCase is the overwhelming majority: 49 of the 63 declared collections use
it, 7 are KV blobs with a single `data` column and no column names at all, and
only 7 are snake_case.** The snake_case column families are exactly four files — `integration-registry.ts`,
`location-store.ts`, `schedule-store.ts`, `destination-policy.ts` — and two of
their six tables are already being deleted.

---

## 3. The anomalies, one at a time

### 3.1 `device-settings` vs `addon-device-settings` vs `<addon>:addon-devices` — the one that is actually dangerous

This is the operator's question and the answer is worse than a naming mismatch.
**`ctx.settings.readDeviceStore(deviceId)` writes two different tables, with two
different row granularities, depending on where the addon runs.**

| Caller | View built by | Table | Key | Granularity |
| --- | --- | --- | --- | --- |
| **hub-local builtin** (device-manager, snapshot, doorbell…) | `ConfigManager.createSettingsView` → `getAddonDevice` → `SqliteSettingsBackend.getAddonDeviceSettings` | **`addon-device-settings`** (bare, canonical) | `"<addonId>:<deviceId>.<key>"` | **one row per key** |
| **forked addon** (detection-pipeline, orchestrator, osd-manager…) | `addon-context-factory.ts` `readDeviceStore` → `readBlob('addon-devices', String(deviceId), addonId)` | **`<addonId>:addon-devices`** (auto-created) | `"<deviceId>"` | **one JSON blob per device** |

The evidence copy proves both are live and both are used by the same API:

```
addon-device-settings  5787 rows   →  5617 keyed "device-manager:<id>.<key>"
                                      168  keyed "__device-state:<id>.<cap>"   (pre-D131 legacy)
detection-pipeline:addon-devices  266 rows  →  keyed "<deviceId>", value {}
```

Three consequences, in order of cost:

1. **Moving an addon between hub-local and forked silently relocates its
   per-device config**, with no migration and no error — the new home simply
   reads empty. `storage.md §2` already names this trap ("the setting saved but
   the addon never saw it") without naming its cause. This is the cause.
2. The two shapes have **opposite write characteristics**: per-key rows are
   contention-free; the blob is a read-modify-write, which is the exact shape
   that lost camera 101's night on 2026-08-14 (`export-store.ts`, quoted at
   length in `durable-store-convergence.md §2.1`). The forked half of a device
   store is on the losing shape.
3. `device-settings` (bare, canonical, **0 rows**) is a *third* name for the
   same concept whose only accessors —
   `SqliteSettingsBackend.getDeviceSettings` / `setDeviceSetting`
   — have **zero production callers**. Verified: every
   `getDeviceSettings` hit in the workspace belongs to the unrelated
   `addonSettings` capability. Same for `provider-settings` and
   `getProviderSettings` / `setProviderSetting`.

**Verdicts.** `addon-device-settings` and `<addon>:addon-devices`: both *vivi*,
both *conformi to their own route*, and the pair is a **duplicato da unificare**
— but that is a data-shape decision (D182's "a fleet is rows, not a blob",
applied to the per-device store), not a rename, and it is out of scope for a
naming pass. `device-settings` and `provider-settings`: **residui da
rimuovere**, together with the four dead accessor methods.

### 3.2 `addon-devices` (unscoped, 0 rows)

Every writer of `addon-devices` in the workspace passes `addonId` as the
namespace (`addon-context-factory.ts`, `readDeviceStore` / `writeDeviceStore` / `clearDeviceStore`). The bare table exists for
exactly one reason: it is item 4 of `CANONICAL_KV_COLLECTIONS`, so `initialize()`
`CREATE TABLE IF NOT EXISTS`-es it on every boot of every node. Nothing has ever
written it on this installation.

**Verdict: residuo da rimuovere** — delete the entry from the canonical array
*and* add the table to `RETIRED_COLLECTIONS`. Note the ordering trap: removing it
from the canonical array **also removes it from the route-2 allowlist**, so
`requireDeclared` would start throwing for `<addonId>:addon-devices`. The entry
must be replaced by an explicit scoped-variant allowlist, not just deleted (§4.3).

### 3.3 `addon-pipeline:addon-devices` and the five `core-block-<uuid>:addon-settings`

Both are route-2 tables whose prefix nobody chose.

- **`addon-pipeline:addon-devices`** — `addon-pipeline` is a *package* name. Its
  `package.json` declares six addons (`pipeline-runner`, `detection-pipeline`,
  `motion-wasm`, `audio-analyzer`, `stream-broker`, `recorder`) and **none of
  them has the id `addon-pipeline`**. Some caller passed the package name where
  an addon id was expected, once, and a table exists forever. 0 rows, `(id, data)`
  shape. **Verdict: residuo da rimuovere.**
- **The five `core-block-<uuid>:addon-settings`** — this one is *correct
  behaviour*, and that is the problem. A core block is materialised with
  `addonId = core-block-<uuid>` (`block-package.ts`, `CORE_BLOCK_ADDON_PREFIX` in `core-blocks.cap.ts`), so the context factory's `writeAddonStore` produces
  a table per block. All five are empty and `core_blocks` itself holds **0
  rows** — the blocks were deleted and their tables were not, because **nothing
  in the delete path drops a route-2 table**.

  **Is one-table-per-UUID the right design? No.** A block's settings are one row,
  and a table costs a `sqlite_master` entry, a page, and a permanent schema
  footprint that grows with operator activity and never shrinks. The alternative
  is one row in the block's own declared collection keyed by block id — which is
  exactly what `core_blocks` already is (`id, name, enabled, placement,
  updatedAt, block`). **Verdict: duplicato da unificare** — settings belong as a
  column on the `core_blocks` row, and the five orphans are **residui da
  rimuovere**. This is the only structural consolidation in the whole audit.

### 3.4 `provider-settings`, `sections`

`provider-settings` (0 rows, dead accessors) — **residuo da rimuovere**, same
treatment as `device-settings`.

`sections` (0 rows) — different: its accessors `ctx.settings.getSection` /
`setSection` are **public addon API** and reachable
(`addon-context-factory.ts`). An unused public API is not a residue.
**Verdict: grandfathered, keep.**

### 3.5 `alerts` (500 rows) — a builtin addon in a kernel slot

`alerts` is owned by `packages/system/src/builtins/alerts/alerts.addon.ts` (`ALERTS_COLLECTION`),
which declares `const ALERTS_COLLECTION = 'alerts'` — and it is *also* item 9 of
`CANONICAL_KV_COLLECTIONS`. The 500 rows are real (`liveness:no-footage:<deviceId>`,
category `system.liveness-failed`).

It is in the namespacing guard's `CANONICAL_SHARED` allowlist, so the guard
passes it — correctly, by that guard's rule. But the fact remains that an addon
named `alerts` owns a bare table named `alerts`, and the reason it is legitimate
is *not* "it is kernel state" (it is not — it is one builtin's data) but "it was
put in the canonical array". **Verdict: grandfathered** — 500 live rows, a rename
buys a migration and nothing else. Worth one sentence in the canonical array
saying *why* it is there, so the next reader does not conclude the array is a
free-for-all.

### 3.6 `lost_and_found` (18,738 rows), `vec_*` (13 tables), `sqlite_sequence`

- **`vec_*` + `vec_indexes`** — sqlite-vec internals, created by
  `${registryTable}` interpolation in `vector-index-vec.ts`. `vec_indexes` holds
  one row: `object-clip|512|cosine`. **Verdict: kernel-legittima, do not touch.**
  They should, however, be *named* in the storage map as a known non-domain
  group so they stop being re-discovered every census.
- **`lost_and_found`** — the `.recover` artefact from yesterday's incident: 33
  untyped columns, 18,738 rows spanning 798 distinct `rootpgno`. Nothing declares
  it, so `requireDeclared` refuses every access to it; it is inert. **Verdict:
  residuo da rimuovere — but NOT via code.** It must not go into
  `RETIRED_COLLECTIONS`: that list's own contract says *"only add a table whose
  declaring code you have DELETED in the same change"*, and there is no declaring
  code. It is a one-off operator `DROP TABLE lost_and_found`, at container stop.
  **Owner: the operator, not an addon.** **DONE 2026-08-19** — dropped inside
  the lavoro-2 cutover window, nothing salvaged from it.

### 3.7 `notifiers:notification-targets` + `provider-homeassistant:ha-notification-targets` — correct, and invisible

Both names are perfectly conformant. Both are **absent from
`docs/reference/storage.md`**, absent from the durable catalogue, and **skipped
by the namespacing guard**.

The cause is one line. Both go through a narrow port whose signature is
positional, and the call passes a *field*:

```ts
// target-store.ts — the name is right here …
export const TARGETS_COLLECTION = 'notifiers:notification-targets'
// … but the call site passes `this.collection`, an expression the parser
// cannot resolve, so parseDeclarations marks it `resolved: false`.
```

and `check-collection-namespacing.ts` opens its loop with:

```ts
if (!decl.resolved) continue
```

**Any addon that routes `declareCollection` through a port field bypasses the
naming guard entirely.** That is a hole in the guard, not in these two stores.
**Verdict on the two tables: conformi. Verdict on the guard: da estendere (§5).**

### 3.8 `auth-webauthn:user_passkeys` / `user_passkey_prefs` — the only scoped-snake pair

Correctly scoped, wrong case in the local part. 1 row and 0 rows respectively.
The prefix is right, the columns are camelCase like everyone else's
(`credentialId`, `publicKey`, `lastUsedAt`), and only the collection name is
snake. It is a straight copy of the `local-auth` naming next door, carried across
the kernel/addon boundary where it stopped applying.

**Verdict: da rinominare** → `auth-webauthn:passkeys` and
`auth-webauthn:passkey-prefs`. Cost: 1 row to move. This is the single cheapest
conformance win in the inventory and the only rename I recommend on a live table.

### 3.9 `viewer-settings-snapshots` — the live guard violation

Declared by `packages/addon-post-analysis/src/pipeline-analytics/viewer-settings-actions.ts` <!-- drift-ok: deleted with D894 -->
(`ViewerSettingsSnapshotStore.declare`) with a bare name, holding **1 row**, typed columns (`name`, `ownerUserId`,
`ownerUsername`, `createdAt`, `updatedAt`, `blob`), one index on `ownerUserId`.

It is the reason `check-collection-namespacing.ts` is red. **Verdict: da
rinominare** → `pipeline-analytics:viewer-settings-snapshots`, matching the
seventeen sibling collections in the same directory. Cost: 1 row.

### 3.10 Fossil names in the type system

`packages/types/src/interfaces/storage.ts` declares `SettingsCollection`:

```ts
export type SettingsCollection =
  | 'system-settings' | 'addon-settings' | 'provider-settings' | 'device-settings'
  | 'detection-events' | 'audio-levels' | 'track-trails' | 'recording-segments'
  | 'recording-thumbnails' | 'recording-policies' | 'recording-storage-config'
  | 'recording-cleanup-queue' | 'known-faces'
  | (string & {})          // ← makes the whole union decorative
```

**Nine of those thirteen names have never existed as tables** on this
installation and grep finds no writer for any of them. Two more
(`provider-settings`, `device-settings`) are the dead pair from §3.4. And the
`(string & {})` escape means the union constrains nothing, so a reader takes it
as a catalogue when it is a memory. **Verdict: residuo da rimuovere** — collapse
to `type SettingsCollection = string` or delete the alias, in the same change
that removes the dead accessors.

---

## 4. The convention, as a rule

Stated as three rules, because the evidence says table name, prefix and column
case are three separate questions with three different answers.

### R1 — Table names

> **Kebab-case everywhere. A collection owned by an addon is
> `<addonId>:<kebab-case-name>`, where `<addonId>` is the id from the package
> manifest — never a package name, never a class name, never a UUID. A
> collection owned by the kernel is a bare kebab-case name. Ownership is carried
> by the PREFIX (present or absent), never by the case.**

**Decided by the operator on 2026-08-19, against this document's original
recommendation.** The audit proposed a split — kernel `snake_case`, addon
`kebab-case` — on the grounds that it renames 3 tables instead of 13 and that
the split is already what the code does. The operator chose uniformity: kebab is
the dominant convention across the whole store surface (44 of 63 declared
collections, and every one of the 68 auto-created scoped tables), and a rule with
an exception class is a rule people misapply.

The argument the split was resting on is recorded here anyway, because it is the
argument for the SEQUENCING in §6 rather than against the rule:

- The bare/scoped distinction already carries the ownership signal on its own,
  and `check-collection-namespacing.ts` already enforces it. Case is therefore a
  *second, redundant* signal — which is why the renames it implies buy
  consistency and nothing operational, and why none of them is urgent.
- The kernel snake tables include the credential store. A `declareCollection`
  that reaches DDL with a different column list REBUILDS the table, and
  `auth-schema.ts`'s `USERS_COLLECTION` docblock says in its own words that a
  rebuild on `users` wipes every account and leaves only the configured admin.
  Uniformity is worth having; it is not worth a lost account, so the credential
  tables go LAST and each one gets its own authorised window.

**What R1 renames — the complete list, 13 tables.** Two are done (§6 Phase 1 and
Phase 3); eleven remain and are Phase 6.

| Current | Becomes | Rows | Owner | Phase |
| --- | --- | ---: | --- | --- |
| `viewer-settings-snapshots` | `pipeline-analytics:viewer-settings-snapshots` | 1 | post-analysis | **1 — DONE** |
| `auth-webauthn:user_passkeys` | `auth-webauthn:passkeys` | 1 | addon-auth | 3 |
| `auth-webauthn:user_passkey_prefs` | `auth-webauthn:passkey-prefs` | 0 | addon-auth | 3 |
| `core_blocks` | `core-blocks` | 0 | system/core-blocks | 6a |
| `backup_schedules` | `backup-schedules` | 1 | system/backup-orchestrator | 6a |
| `backup_destination_policies` | `backup-destination-policies` | 1 | system/backup-orchestrator | 6a |
| `storage_locations` | `storage-locations` | 4 | system/storage-orchestrator | 6b |
| `integration_settings` | `integration-settings` | 10 | system/integration-registry | 6b |
| `integrations` | `integrations` | 14 | system/integration-registry | — *already kebab-legal* |
| `oauth_sessions` | `oauth-sessions` | 10 | system/local-auth | 6c |
| `user_totp` | `user-totp` | 1 | system/local-auth | 6d |
| `scoped_tokens` | `scoped-tokens` | 26 | system/local-auth | 6d |
| `api_keys` | `api-keys` | 0 | system/local-auth | 6d |
| `users` | `users` | 2 | system/local-auth | — *already kebab-legal* |

`integrations` and `users` are single words: they satisfy kebab-case as they
stand and are **not** renamed. That is worth stating explicitly, because "kebab
everywhere" reads as "everything moves" and two of the scariest tables in the
list do not move at all.

`alerts` and `cluster-node-history` were the two kernel kebab outliers under the
old rule. Under this rule they are simply **conformant** — nothing to
grandfather, and the §3.5 note about `alerts` reduces to a comment explaining why
a builtin's table sits in the canonical array.

### R1b — every rename is reversible, per table

The property that makes Phase 6 executable one window at a time: **the old name
stays readable by the old code.** A rename here is not an `ALTER TABLE` in a
migration script that the running binary knows nothing about — it is a code
change that ships with the binary, so:

- **Roll forward** = deploy the new binary, which declares the new name and
  drains the old one (the §6 Phase 1 shape: declare successor, copy, verify,
  retire — gated, idempotent, loud).
- **Roll back** = redeploy the previous binary. It declares the OLD name, which
  still exists and still holds its rows until the drain has verified the copy.
  Nothing has been dropped at that point; the drop is a separate, later commit
  through `RETIRED_COLLECTIONS`.
- **The window between them is safe in both directions** because the drain never
  deletes on a fallible read and never deletes a row the successor has not been
  re-read to hold.

Consequence for the plan: **rollback granularity is one table.** A window that
renames three tables and goes wrong rolls back three; a window that renames one
rolls back one. That is why Phase 6 is sub-divided by blast radius rather than
batched for convenience.

### R2 — Column names

> **Columns are camelCase in every collection, kernel and addon alike. There is
> no ownership signal in a column name.**

49 of the 63 declared collections already are. The four snake_case files are one
lineage, and two of their six tables are already being deleted by another agent.
**But this rule renames NOTHING today** — a column rename is the most dangerous
operation in this store: `declareCollection` is additive only when SQLite can
`ALTER TABLE … ADD COLUMN`, and *"a new column list that reaches DDL differently
counts as non-additive and the next boot REBUILDS the collection, discarding
every row"*. R2 is a rule for **new** columns and for any collection that is
being rewritten for another reason anyway. `integrations` (14 rows),
`integration_settings` (10), `storage_locations` (4), `backup_schedules` (1),
`backup_destination_policies` (1) stay snake_case until something else forces
them open.

### R3 — Route-2 prefixes

> **The `namespace` argument on a canonical collection MUST be a live addon id.
> A prefix that is not in the installed-addon set does not materialise a
> table — the write fails loudly.**

This is the rule that would have prevented `addon-pipeline:addon-devices` and,
more importantly, it is the rule that turns the five orphaned
`core-block-<uuid>:addon-settings` from "invisible garbage" into "an error at
the moment of the mistake". It has a cost that must be stated: core blocks are
*deliberately* not in the installed-addon set (`core-blocks.cap.ts` and `server/backend/src/core/addon/integration-visibility.ts` both say so), so R3 needs an explicit second
predicate for them — or, better, §3.3's consolidation removes the need entirely.

**What R1–R3 deliberately do NOT do:** they do not make the door derive the
namespace from the caller's identity. The cap docblock has wanted that since it
was written, and it remains the right end state, but it renames the nineteen
`pipeline-analytics:*` tables that hold most of the 354 MB — 63 MB of `tracks`,
63 MB of `media`, 19 MB of `motion-events` — and this repo has just spent two days recovering from a database
incident. **Not now, and not smuggled into a naming pass.**

---

## 5. The guard

The guard exists. What it needs is three changes and a switch flipped.

### 5.1 The switch (item 0)

Re-enable the `CI` workflow on GitHub (`gh workflow enable ci.yml`). Nothing
below matters until this is done, and two guards are red the moment it is —
which is the correct outcome and the reason to do the fixes in §6 Phase 1 first.

### 5.2 Extend `scripts/check-collection-namespacing.ts` — three changes

**(a) Stop silently skipping unresolved declarations.** Today:

```ts
if (!decl.resolved) continue    // ← the §3.7 hole
```

The comment justifies it with *"an unresolved name is reported by the storage
map, not here"* — but the storage map reports it into §4 "Not statically
knowable", which nothing fails on. Change the behaviour to: **an unresolved
declaration inside `packages/addon-*` is a violation unless the file also
declares a same-file `const` whose value is a conformant name.** Both §3.7 cases
do have exactly that constant (`TARGETS_COLLECTION`), so both go green without
a code change and the hole closes. A file with neither a resolvable call nor a
conformant constant is genuinely unauditable and should say so.

**(b) Check the prefix against the manifest, not just for a colon.** The guard
today accepts any `x:y`. Read the `camstack.addons[].id` set out of each
`packages/addon-*/package.json` (the same source `check-addon-entries.ts`
already parses) and require the prefix to be one of the ids that package
declares. This is what catches `addon-pipeline:addon-devices` and any future
package-name-for-addon-id slip. It also catches the reverse mistake — addon A
declaring `addon-b:something`.

**(c) Add a kebab check on the local part.** `^[a-z0-9]+(-[a-z0-9]+)*$` on the
substring after the colon, modelled byte-for-byte on
`scripts/check-cap-name-kebab.ts`, which is the precedent in this repo for a
naming guard and already has the right docblock shape. This is what catches
`auth-webauthn:user_passkeys`.

### 5.3 A second guard for the kernel side — `check-kernel-collection-kebab.ts`

`packages/system` and `server/backend` are deliberately unscanned today. R1 now
covers them, so it needs a check or it is a paragraph:

- Scan `packages/system/src` + `server/backend/src` for `declareCollection`.
- Every resolved bare name must match `^[a-z0-9]+(-[a-z0-9]+)*$`.
- **It must also fail on a name containing `:`** — a kernel table is bare by
  definition, and the inverse mistake (kernel code taking an addon namespace) is
  currently unchecked in both directions.
- A `PENDING_RENAME` list holding the Phase-6 tables that have not moved yet,
  each with the phase that moves it. **It shrinks and is never appended to** —
  the same discipline `check-durable-state-declared.ts` applies to its
  shrink-only backlog, and the reason that one reached zero. The guard should
  print the remaining count so the rename programme has a number nobody has to
  go looking for.

Ship this guard in the SAME commit as Phase 6a, not before: a guard that is red
on eleven tables from the day it lands is a guard people learn to scroll past,
which `ci.yml`'s own preamble names as the thing every step here must not be.

### 5.4 Where the checks hook

`declareCollection` has a single runtime choke point —
`SqliteSettingsBackend.declareCollection` (`SqliteSettingsBackend.declareCollection`) —
and R3 belongs *there*, not in a script: it is a fact about the installed addon
set that only exists at runtime. Concretely: `requireDeclared`'s auto-create
branch gains a predicate over the live addon-id set, throws with the
offending prefix in the message, and **logs the refusal** (a branch that drops
work silently is the rule this repo has written down twice).

R1 and R2 are static and belong in `scripts/` + `ci.yml`, per that file's own
rule: *"every guard in `scripts/` runs here"*.

---

## 6. The plan, ordered, with costs

Each row states its **ship vehicle**, which is not the same for all of them:
`packages/system` and `server/backend` changes ride the **train** (a published
`@camstack/server`); `packages/addon-*` changes ship with **`camstack deploy`**;
a table rename needs an offline **migration** at container stop.

### Phase 0 — turn the harness back on. **DONE, 2026-08-19.**

| Item | Vehicle | State |
| --- | --- | --- |
| `gh workflow enable ci.yml` | GitHub | **DONE** — enabled by the operator |

It went red immediately on the two violations in §0. That was the point.

### Phase 1 — make main green. **DONE, 2026-08-19.**

| # | Item | Cost | Vehicle | State |
| --- | --- | --- | --- | --- |
| 1.1 | `viewer-settings-snapshots` → `pipeline-analytics:viewer-settings-snapshots` | 1 row | `camstack deploy packages/addon-post-analysis` | **DONE** |
| 1.2 | `device-manager:devices` — a class from the five that exist | 0 rows | train | **DONE** |

**1.1, and the pattern every later rename reuses.** There is no rename on the
settings-store cap and no way to run a migration script for one row without a
container-stop window, so the OWNER adopts the rows at boot — the same shape and
the same ordering `device-manager` used for the fleet (D182) and `recorder` used
for its root keys (`retire-root-keys.ts`):

1. declare the successor under the new name, with a **fresh index name** —
   SQLite index names are global, and `CREATE INDEX IF NOT EXISTS` on a name the
   old table still owns is a silent no-op that would have left the successor
   unindexed;
2. declare the predecessor with its **original column list and no indexes** — a
   different column list would count as non-additive and REBUILD the table,
   destroying the rows the module exists to rescue;
3. copy, skipping ids the successor already holds (the legacy copy is older by
   construction);
4. **re-read the successor** and delete only the legacy rows it is confirmed to
   hold — never on the write having returned;
5. log the counts once, at `warn`.

`viewer-settings-legacy-adoption.ts` (deleted in the records plan's phase 0, D881, once the bare
table was drained; the pinned verification-read case was confirmed RED with the re-read replaced
by an optimistic set).

Reading the old table requires declaring it, and declaring a bare name is the
violation — so the guard's own escape hatch, `ALLOWED_BARE`, carries one entry
naming that file and the condition for removing it. It is the read side of a
rename in progress, not a pin.

**1.2.** The annotation shipped as `class=registry`, which is not one of
`ledger | mirror | ephemeral | config | audit`. It is now `ledger`, not
`config`: nothing else in the system holds a device's numeric id —
`allocateDeviceId` mints it and every other store keys on it — so `config`'s
rule (*"already durable everywhere"*) is false here, and it is the same false
premise that made the dead `devices` table look harmless until D183. `ledger`'s
rule (*must not be pruned against a fallible read*) is the rule the fleet
actually needs (D49).

### Phase 2 — pure removal. ~2 h. Risk: low. No renames, no migrations.

Everything here reuses the mechanism that **landed **
`RETIRED_COLLECTIONS` + `purgeRetiredCollections`
(`packages/system/src/builtins/sqlite-storage/retired-collections.ts`), which <!-- drift-ok: deleted 2026-10-22 (D901) -->
today carries `devices` and `device_settings_kv`. **Do not invent a second
one**, and coordinate: that file and `integration-registry.ts` are the cleanup
agent's; add entries only once its commits are in the tree. Its contract is
already exactly right for this: idempotent, per-node, `warn` when a drop
destroyed rows, never blocks boot, and *"only add a table whose declaring code
you have DELETED in the same change"*.

| # | Item | Rows destroyed | Risk | Vehicle |
| --- | --- | ---: | --- | --- |
| 2.1 | Delete `getProviderSettings` / `setProviderSetting` / `getDeviceSettings` / `setDeviceSetting` from `SqliteSettingsBackend`; drop `provider-settings`, `device-settings` from `CANONICAL_KV_COLLECTIONS`; add both to `RETIRED_COLLECTIONS` | **0** | low | train |
| 2.2 | Drop `addon-devices` (unscoped) from `CANONICAL_KV_COLLECTIONS` + `RETIRED_COLLECTIONS` — **and add the explicit route-2 allowlist first** (§3.2), or every forked addon's device store starts throwing | **0** | **medium — ordering trap** | train |
| 2.3 | `addon-pipeline:addon-devices` → `RETIRED_COLLECTIONS` | 0 | low | train |
| 2.4 | Collapse `SettingsCollection` (§3.10) | 0 | none | train |
| 2.5 | The 37 empty `<addon>:addon-settings` and 4 empty `<addon>:addon-devices` | 0 | **do NOT** — they are route-2 tables that the owning addon recreates on its next write. Dropping them is churn no test catches | — |

2.2 is the only one in this phase that can break a running hub, and it breaks it
in the loudest possible way (`requireDeclared` throws). Worth doing, worth doing
carefully, worth its own commit.

### Phase 3 — the two credential-adjacent addon renames. ~1 h. Risk: low (1 row).

| # | Item | Rows | Vehicle |
| --- | --- | ---: | --- |
| 3.1 | `auth-webauthn:user_passkeys` → `auth-webauthn:passkeys` | 1 | deploy, Phase-1 adoption pattern |
| 3.2 | `auth-webauthn:user_passkey_prefs` → `auth-webauthn:passkey-prefs` | 0 | deploy, same |

A passkey is a **credential**: losing that one row locks a real login method out
of a real account. Small does not mean safe. These two are addon-side, so they
ship by `camstack deploy` and use the Phase-1 adoption pattern rather than an
offline script — but they still want a cold backup of the DB triple taken first,
by the D182 procedure, because the cost of being wrong is not proportional to
the row count.

### Phase 4 — the guards. ~3 h. Risk: none (guards only).

| # | Item | Vehicle |
| --- | --- | --- |
| 4.1 | `check-collection-namespacing.ts` (a)+(b)+(c) per §5.2 | CI |
| 4.2 | New `check-kernel-collection-kebab.ts` per §5.3 — ships WITH Phase 6a, not before | CI |
| 4.3 | `@durable` on the 9 canonical KV collections; extend `parse-storage.ts` to stop filtering them out of §3a | train + docs |

4.3 is the item with the best value-per-hour in the document: it is comments and
a parser tweak, it closes a hole in an index that currently reads as complete,
and it puts a class on `addon-device-settings` (5787 rows),
`device-runtime-state` (912) and `alerts` (500) — three live kernel tables that
have never had one.

### Phase 5 — the runtime predicate and the core-block consolidation. Separate decision.

| # | Item | Risk | Vehicle |
| --- | --- | --- | --- |
| 5.1 | R3 in `requireDeclared` — refuse a namespace that is not a live addon id, loudly | **medium** — a false negative on the addon-id set at boot breaks every route-2 write | train |
| 5.2 | Core-block settings become a column on the `core_blocks` row; the 5 orphan tables to `RETIRED_COLLECTIONS`; block deletion drops nothing because there is nothing to drop | low (0 rows today) | train |

5.2 should come **before** 5.1, not after: it removes the one legitimate reason a
non-addon namespace exists, so 5.1 stops needing a second predicate and becomes a
one-line check instead of a two-branch one.

### Phase 6 — the eleven kernel renames. **One authorised window per sub-phase.**

This is the work R1 creates, and it is the largest item in the document. It is
NOT a batch. **Each sub-phase is executed only when the operator authorises that
specific window**, and each one is independently reversible per §R1b: redeploy
the previous train and the old table is still there, still populated, because
the drop is always a separate later commit.

Ordered by **blast radius of being wrong**, ascending. Credentials are last, and
they are last by two steps rather than one.

| Sub-phase | Tables | Rows | If it goes wrong | Vehicle |
| --- | --- | ---: | --- | --- |
| **6a** | `core_blocks` → `core-blocks`, `backup_schedules` → `backup-schedules`, `backup_destination_policies` → `backup-destination-policies` | 0, 1, 1 | a backup schedule reverts to defaults; a core block re-materialises | train |
| **6b** | `storage_locations` → `storage-locations`, `integration_settings` → `integration-settings` | 4, 10 | the orchestrator runs on seed defaults and an integration loses its config — recoverable, visible immediately | train |
| **6c** | `oauth_sessions` → `oauth-sessions` | 10 | every OAuth session is invalidated: users re-authorise. Annoying, not destructive — and this is the rehearsal for 6d on a table where the failure mode is "log in again" | train |
| **6d** | `scoped_tokens` → `scoped-tokens`, `user_totp` → `user-totp`, `api_keys` → `api-keys` | 26, 1, 0 | **a lost credential.** 26 scoped tokens is every integration's API access; `user_totp` is a second factor a user cannot re-derive without their enrolment flow | train |

**`users` and `integrations` are NOT in this table.** Both are single words, both
already satisfy kebab-case, and neither is touched by R1 at all. The two tables
whose loss would be worst are the two that never move.

**Per-window procedure, every sub-phase, no exceptions.** This is the D182
cutover procedure with the rename substituted for the flatten:

1. Operator authorises this specific sub-phase.
2. Ship the train containing the rename + the Phase-1 adoption module for each
   table in it. **Do not** ship two sub-phases in one train.
3. Container stop → **cold** backup of the `db`/`-wal`/`-shm` triple into a dated
   directory (never `VACUUM INTO`, never `sqlite3` against the live file, always
   `/mnt/cache` — the three lessons of the 2026-08-19 incident).
4. Restart on the new train. The adoption runs at boot and logs `found` /
   `written` / `retired` / `kept` per table.
5. **Verify by reading the SUCCESSOR through the running code**, not by counting
   rows in SQLite: the question is "does the feature still work", and for 6d
   that means an actual login with the second factor and an actual API call with
   a scoped token.
6. Only after a clean boot on a LATER day, a separate commit adds the emptied
   predecessors to `RETIRED_COLLECTIONS`. The gap between step 5 and step 6 is
   the rollback window and it should be measured in days, not minutes.

**Estimated cost:** ~2 h of code per sub-phase plus a stop window each; four
windows. The honest framing for the operator is that this buys **consistency and
a guard that can be green**, and buys nothing operational — which is exactly why
it is sequenced last and why no sub-phase should ever be bundled with work that
does have an operational reason to ship.

### The 2026-08-19 stop window — **DONE**

Both items rode the recorder/stream-broker "lavoro 2" cutover,
which is the right way to spend a downtime: one stop, everything that needs one.

| Item | Outcome |
| --- | --- |
| `lost_and_found` (18,738 rows) | **DROPPED** in the same window. Not through `RETIRED_COLLECTIONS` — that list is for tables whose declaring code was deleted, and this one never had any |
| Cold backup of the DB triple | **DONE**, `db-backup-pre-flatten2-20260819/`, before anything else |
| (rode along) `recorder:addon-settings` / `stream-broker:addon-settings` `root` blobs | 201,833 → ~1.4 KB and 33,155 → ~0.4 KB; §2.2's two fat rows are gone |

So §2.2's table is already historical on those two rows, and §3.6's
`lost_and_found` verdict is executed. The measurement in §2 stands as the
2026-08-19 17:57 snapshot it says it is.

### Explicitly NOT in the plan

| Not doing | Why |
| --- | --- |
| Renaming any kernel snake_case table | R1 makes snake_case the kernel marker; 11 tables, one of which (`users`) is wiped by a bad `declareCollection` |
| Renaming any snake_case **column** | `ALTER TABLE` is the only safe route and a mis-declared column list REBUILDS the table. R2 governs new columns only |
| Making the door derive the namespace from the caller | Renames the 19 `pipeline-analytics:*` tables holding most of the 354 MB. The right end state, the wrong week |
| Unifying `addon-device-settings` with `<addon>:addon-devices` | A data-shape decision (D182 applied to per-device config), not a naming one. Deserves its own audit |
| Dropping the 37 empty scoped tables | Recreated on next write; churn no test catches |
| Anything at all to `vec_*` | sqlite-vec's own internals |
| `lost_and_found` | Operator `DROP TABLE`, at container stop, not code (§3.6) — **DONE 2026-08-19** |

---

## 7. The operator's decisions, 2026-08-19

All four questions were answered the same day. Recorded here because two of them
went against this document's recommendation, and a reader six months from now
should see the reasoning that was overruled rather than assume it was never
considered.

| # | Question | Recommended | **Decided** | Consequence |
| --- | --- | --- | --- | --- |
| 1 | Re-enable CI? | yes, then fix | **yes — enabled immediately** | Phase 0 done; Phase 1 done the same day |
| 2 | Kernel-snake / addon-kebab, or one case everywhere? | keep the split (3 renames) | **kebab everywhere** | R1 rewritten; **Phase 6 created** — 11 more renames, four authorised windows, credentials last |
| 3 | F2 + the explicit route-2 allowlist? | ship the allowlist | **approved**, dedicated commit + deploy | Phase 2 stands; blocked on the cleanup agent's `RETIRED_COLLECTIONS` commits, which have since landed |
| 4 | Drop `lost_and_found`? | yes, by hand, at a stop | **approved**, nothing to salvage | **DONE** the same evening, inside the lavoro-2 cutover window |

On (2): the split was recommended because it renames 3 tables instead of 13 and
because it is already what the code does. The operator's counter is the stronger
one for a rule that has to survive people: kebab is the dominant convention
across the whole surface, and a rule with an exception class is a rule that gets
misapplied. The cost is real and is not hidden — it is Phase 6, it is four stop
windows, and three of those tables are credentials. It is sequenced last for
exactly that reason, and nothing in Phases 1-5 depends on it.
