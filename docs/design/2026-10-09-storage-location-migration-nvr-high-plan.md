---
title: Storage migration example — NVR array → high; old high → low / artifacts / HomeKit
last-verified: 2026-10-09
status: planned, not executed
covers:
  - packages/types/src/capabilities/storage-migration.cap.ts
  - packages/system/src/builtins/storage-orchestrator/storage-migration-coordinator.ts
---

# Storage migration example — NVR array → high; old high → low / artifacts / HomeKit

**Status: plan only.** Nothing in this document was applied to the live cluster.
It is an operator runbook example for a topology change that this hub already
has the machinery for (`storageMigration`, location `mode`, drain progress).

Related prior art (already executed on this cluster):

- [`2026-08-26-low-events-storage-migration-to-ssd.md`](./2026-08-26-low-events-storage-migration-to-ssd.md)
- [`2026-08-29-non-blocking-storage-migration.md`](./2026-08-29-non-blocking-storage-migration.md)

Rules that bind every step: D385–D389 (one typed `mode`, drain pace, occupancy
of the class subtree, never two locations of one type on one physical root),
and never open the live SQLite files with `fs` / a second connection (D679).

---

## 1. Live snapshot (2026-10-09, hub)

From `storage.listLocations` (read-only):

| Location id | Type | Mode | Path | Owned (approx) | Volume |
| --- | --- | --- | --- | ---: | --- |
| `recordings:recordings-high-4tb` | `recordings` (high/mid) | active | `/recordings-2` | **3.70 TB** / 4.00 TB | Current high HDD |
| `recordingsLow:ssd` | `recordingsLow` | active | `/media-fast/recordingsLow` | 1.40 TB | Shared SSD (~2 TB) |
| `eventMedia:ssd` | `eventMedia` | active | `/media-fast/eventMedia` | 0.61 TB | Same SSD |
| `artifacts:default` | `artifacts` | active | `/media-fast/artifacts` | (occupancy unknown) | Same SSD |
| `homekitClips:default` | `homekitClips` | active | `/recordings/recordings` | ~empty | Separate ~2 TB volume |
| `backups:default` / `backups:smb` | backups | active | `/data/backups`, SMB | — | out of scope |

**Operator target**

1. The **four NVR-array disks** become the **high** (`recordings`) pool.
2. The disk behind **`recordings:recordings-high-4tb` (`/recordings-2`)** is
   repurposed for **`recordingsLow` + `artifacts` + `homekitClips`** (and only
   those — see §1.1).

### 1.1 Open product decision — `eventMedia`

Today `eventMedia` shares the SSD with low/artifacts. The operator ask did **not**
name event media. Default recommendation: **leave `eventMedia:ssd` on the
SSD** (latency-sensitive stills/crops). If the goal is to free the entire SSD,
treat `eventMedia` as a third migration class in Phase B (same machinery).

---

## 2. Options compared

### A — "Clear all" / wipe UI

| | |
| --- | --- |
| What exists | Per-camera delete of recorded footage on the Recordings storage UI (`StorageSection` confirm). Analytics wipes (`pipelineAnalytics.wipeAllAnalytics`, embeddings wipe). Migration **cleanup** (`storageMigration.cleanupStart`) reclaims orphans / ghost ledger / optional debug media — **not** a disk format. |
| What does **not** exist | A single button that empties a storage location or formats a block device. |
| Verdict | **Insufficient** for this topology change. Useful only as a final tidy (`cleanupStart`) after a real migration. |

### B — Format disks + clean the DB

| | |
| --- | --- |
| Effect | Destroys live high footage (~3.7 TB) and any DB pointers that still name the old roots; recording gap for every camera until writers re-attach. |
| DB reality | High/mid footage is path-derived (recorder index); `eventMedia` rows **do** carry `locationId` and must be relocated in the safe order (blob → stamp → delete). Blind SQLite edits while CamStack runs are forbidden (D679). |
| Verdict | **Only** if the operator accepts total loss of high archive and a maintenance window. Not the default. |

### C — Drain / migrate with the product (recommended)

| | |
| --- | --- |
| Mechanisms | `storage.upsertLocation` + `mode: drain\|active\|disabled`; `storage.listDrainProgress`; **`storageMigration.plan` / `start` / `status`** with `mode: "nonBlocking"` (repoint write path first, drain archive while live — see 2026-08-29 doc); `storageMigration.drain` for class-level drains; pause leases via orchestrator/recorder/analytics when a blocking cutover is chosen. |
| Effect | New high disks accept **new** writes immediately after repoint; old high empties at drain pace; then the freed disk is given new location ids for low / artifacts / HomeKit. |
| Verdict | **Recommended.** Matches what already shipped for the SSD low/events move. |

---

## 3. Recommended procedure (checklist — do not run yet)

Host prep (Unraid) is outside CamStack: assemble the four NVR disks, one
filesystem mount per location root (or one mount per disk), **distinct physical
roots** — two `recordings` locations must never share a root (D389).

### Phase A — Move **high** onto the NVR array

1. **Inventory** — `storage.listLocations`, `storage.listDrainProgress`, note
   `recordings:recordings-high-4tb` owned bytes and free space on each new disk.
2. **Create** four (or N) `recordings` locations pointing at the new mounts,
   `mode: active`, via Data → Storage (or `storage.upsertLocation`). Do **not**
   delete the old high yet.
3. **Plan** — `storageMigration.plan` with
   `destinations.recordings = <one primary new location id>` (or the id the
   coordinator treats as the new default — confirm in UI findings),
   `sources.recordings = recordings:recordings-high-4tb`,
   `mode: "nonBlocking"`. Resolve every `findings[]` before start
   (`sharesDeviceWithSource`, `blockingOnly`, …).
4. **Start** — `storageMigration.start` with the same payload. Prefer
   non-blocking so recording continues on the new disks while the archive
   drains.
5. **Watch** — `storageMigration.status` / movers / residue; Cluster → Data
   migration panel. Optionally set the old location `mode: drain` if the plan
   did not already freeze it (`storage.listDrainProgress` until
   `drained: true`).
6. **Verify high** — a camera that was writing high now creates segments under
   a new root; old root owned bytes fall; no ENOSPC on the new pool.

### Phase B — Repurpose the old high disk for low / artifacts / HomeKit

Only when Phase A residue for `recordings` from
`recordings:recordings-high-4tb` is empty (or accepted loss).

1. **Disable / remove** the old `recordings:…` location once drained
   (`mode: disabled`, then delete when the UI allows — never while writers
   still resolve it).
2. **Host** — if the filesystem layout must change (single disk → multiple class
   subtrees), create the subtrees **before** registering locations, e.g.
   `/recordings-2/low`, `/recordings-2/artifacts`, `/recordings-2/homekit`
   (names illustrative). Occupancy is per class subtree (D327).
3. **Register** new locations:
   - `recordingsLow:…` → old-disk low subtree  
   - `artifacts:…` → old-disk artifacts subtree  
   - `homekitClips:…` → old-disk HomeKit subtree  
   Each a **different type**, so sharing one disk is allowed; do not place two
   `recordingsLow` roots on the same physical path.
4. **Migrate classes that the coordinator supports** —
   `storageMigration` destinations today include
   `recordings | recordingsLow | eventMedia | backups | galleryMedia`.
   - **`recordingsLow`**: plan/start nonBlocking from `recordingsLow:ssd` → new
     low location on the old high disk (if that is the intent).
   - **`artifacts` / `homekitClips`**: **not** in the migration destinations
     schema as of this plan — treat as manual: pause HomeKit export if needed,
   copy/move trees, `upsertLocation` + set default, then
   `storageMigration.cleanupStart` for orphans. Confirm in code before the
   day of the cutover whether a mover was added for those types.
5. **SSD aftermath** — once low (and optionally artifacts) leave `/media-fast`,
   the SSD keeps `eventMedia` (recommended) or is drained too.

### Phase C — Hygiene

- `storageMigration.cleanupStart` (orphans / ghost ledger).
- Do **not** format `/recordings-2` until CamStack shows the old recordings
  location gone and no process holds files there (`lsof` / Unraid).
- Refresh occupancy; confirm placement / a sample camera for each class.

---

## 4. What NOT to do

- Format or `rm -rf` a live location root while the location is `active`.
- Hand-edit SQLite / open the live DB with `sqlite3` or `fs` while CamStack runs.
- Put two locations of the **same type** on one physical root.
- Use `config.readOnly` or invent a second mode field — only `StorageLocation.mode`
  via the storage-location-mode path (D385).
- Assume "Clear all" empties a disk — it does not.
- Run a **blocking** migration of ~3.7 TB high without accepting many hours of
  paused recording (use `nonBlocking` unless a finding forces otherwise).

---

## 5. How to verify

| Check | Expect |
| --- | --- |
| `storage.listLocations` | New `recordings:*` active on NVR mounts; old high disabled or absent |
| `storage.listDrainProgress` | No stuck drain with rising `bytesRemaining` |
| `storageMigration.status` / residue | Phase `done`; residue 0 for moved classes |
| Live segment path | New high file under NVR root for an ACTIVE camera |
| Low / HomeKit / artifacts | Writes under the repurposed disk subtrees after Phase B |
| Pipeline / recorder | No prolonged pause unless a blocking job was chosen |

---

## 6. Direct answers

| Question | Answer |
| --- | --- |
| Clear all? | **No** disk-wide clear-all. Per-camera delete and migration cleanup only. |
| Format + DB clean? | **Only** if destroying the high archive is acceptable. Not recommended. |
| Drain old high, add 4 disks, then repurpose? | **Yes — that is Phase A then Phase B.** Prefer `storageMigration` nonBlocking over a naked `mode: drain` alone so defaults and DB stamps stay consistent. |
