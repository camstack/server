---
id: D341
title: Addon data dirs carry no media — artifacts live in one shared singleton storage class
status: accepted
date: 2026-09-04
supersedes:
applies-to:
  - packages/addon-post-analysis/src/notification-center/artifact-store.ts
  - packages/addon-post-analysis/src/notification-center/artifact-plane.ts
  - packages/addon-post-analysis/src/pipeline-analytics/location-aware-media-storage.ts
  - packages/addon-post-analysis/src/notification-center/__tests__/artifact-store.spec.ts
  - packages/addon-post-analysis/src/notification-center/__tests__/nc-artifact-location-declaration.spec.ts
  - packages/addon-post-analysis/src/pipeline-analytics/__tests__/gallery-media-survives-a-footage-wipe.spec.ts
  - packages/addon-pipeline/src/recorder/addon/export-store.ts
  - packages/addon-pipeline/src/recorder/addon/export-janitor.ts
  - packages/addon-pipeline/src/recorder/addon/__tests__/export-location.spec.ts
---

## Context

On the operator's hub, `addons-data` carried ~9.2 GB that was media, not addon
state: 718 MB of notification artifacts (`pipeline-analytics/nc-artifacts/kept`
— stills, GIFs, timelapse mp4s behind signed links and the viewer's artifact
library), 50 MB of enrolled-gallery crops (`pipeline-analytics/gallery`), and
8.4 GB of operator-exported video clips (`recorder/exports`) — the largest
single thing in `addons-data`. All of it rode every system backup (or needed a
hand-written exclusion, D338), belonged to no storage class (invisible to D327
occupancy, unreachable by relocation), and sat on the constrained appdata nvme
(68%) while a 1.9 TB media disk ran at 10%.

Each had been put there on purpose, at different times, for locally-good
reasons: the artifact store and the export engine predate the storage-location
machinery; the gallery had been a `galleryMedia` location until 2026-08-31
(873b73e2c), when it was pinned to `<dataDir>/gallery` to remove "a second
write target that looked unused" — solving a UI-clutter problem by making the
bytes invisible to every storage surface at once.

The operator's rules, stated 2026-09-04: **"le cartelle addons non devono
trasportare nulla"** [the addons folders must carry nothing] — addon directories carry nothing but addon state; and
for the artifact producers, **one generic class, not one per producer** ("non
un'altra location, a limite rinomina notificationMedia in qualcosa di generico
come artifacts") [not another location; at most rename notificationMedia to something generic like artifacts].

Alternatives rejected:

- **Artifacts as a subtree of `eventMedia`** (the first cut). Correct for
  occupancy and camera wipes, but wrong on the deciding argument: an
  eventMedia DRAIN moves media ROWS, and artifacts have none — every drain of
  that class would strand artifact bytes by construction.
- **A flat dir at a location root.** Exactly the "second convention at a
  shared root" D327 forbids: the occupancy walk would not see it, so a
  drained location holding only artifacts would verify `empty` and be
  deletable with gigabytes still on it.
- **Artifacts as `MediaStore` rows.** Would buy location stamping and the
  relocate mover, but the media path schema is per-owner-kind `.jpg`-only and
  both producers' retention models would have to be re-expressed as a
  retention class. Too much machinery for bytes governed by their own bounds.
- **Exports under a `recordings`-class location.** Footage classes are
  quota-capped, pressure-evicted and per-camera wipeable; an export is
  something the operator DELIBERATELY created. Same shape as the gallery
  lesson (D197): an exemption enforced only in software is void on a volume
  whose contract is disposal.
- **One class per producer** (`notificationMedia` + `recordingExports` — the
  second cut, briefly D344). Rejected by the operator: two locations to
  place, repoint and reason about, for one kind of thing. The accepted trade,
  recorded so the next reader does not "fix" it by splitting them again:
  **notification artifacts and recording exports can no longer sit on
  different disks** — one root serves both tenants, and moving one means
  moving both.
- **Subtree-first exports** (`<root>/exports/<deviceId>/…` — the third cut).
  It made the hub migration a verbatim tree copy and spared the playlist
  writer's join, but it broke the per-camera story: a camera's footprint was
  split across two top-level trees, `du <root>/<dev>` answered half the
  question, and per-device occupancy differed per tenant. Device-first won
  (operator: *"non possiamo unificare la cartella a
  `<root>/<deviceId>/{nc-artifacts,exports}`?"*); the cost is a reshaping
  copy at migration and one shared derivation (`exportTenantDirFor`) that
  every export-side path goes through.
- **The gallery as its own `galleryMedia` class** (the second and third
  cuts). Its declaration justified `defaultRoot: 'data'` with "these images
  survive every retention sweep, so they must also survive a footage wipe, a
  quota eviction and a recordings disk swap". The operator challenged the
  eviction half and was right — the claim was WRONG:
  `StoragePressureManager.sweep()` calls `evict({ locationId, targetBytes })`
  per location, so eviction is scoped to a location's own class and can never
  cross onto a co-hosted class; the only same-disk coupling is scheduling (a
  location that already relieved the disk this tick makes a co-hosted one
  skip its turn — nobody deletes the other's files). What survived of the
  argument was "a recordings disk swap" — physical media, not sweeps — and
  the operator's judgement on that: placement was being used as a substitute
  for backup, which is not what protects curation work. So the gallery is the
  THIRD tenant of `artifacts` ("no vanno nello stesso... rinomina
  notificationMedia in qualcosa di generico come artifacts"), and a separate
  class remains rejected.

## Decision

**Media an addon produces lives in a storage class the orchestrator can see;
the addon data dir holds only addon state. All three artifact producers share
ONE class: `artifacts`, a declared singleton.**

- **One class, THREE tenants, disjoint subtrees** under the one root:
  - `<root>/<deviceId>/nc-artifacts/{,kept/}` — the notification shelf,
    device-first; bucket `0` (`PHOTO_ENROLL_DEVICE_ID`) for artifacts no
    caller can attribute — a guessed camera id is worse than none;
  - `<root>/<deviceId>/exports/<id>.mp4` — the recorder's exports and their
    render/playlist scratch, device-first, every path derived through ONE
    function (`exportTenantDirFor`), never joined a second way;
  - `<root>/gallery/…` — the enrolled gallery, deliberately TOP-LEVEL rather
    than inside the camera buckets: an enrolled sample's lifecycle is not the
    camera's — a camera discard removes `<deviceId>/…` operational artifacts
    and must NEVER remove curation work that merely originated from that
    camera. (The `<deviceId>` level inside `gallery/` is capture provenance
    carried by the rows' relativePaths; bucket `0` for photo enrolment.)
  For the two per-camera tenants, one directory answers "what does this
  camera hold", per-device occupancy is uniform, and a camera discard covers
  both without a special case. The tenants stay separable because each
  consumer ADDRESSES its own subtree — the notification shelf walks only
  `<deviceId>/nc-artifacts/`, the janitor deletes only derived export paths,
  the gallery reads and writes only exact row paths under `gallery/`; none
  enumerates what a bucket or the root holds.
- **Sharing the location is never sharing a sweep.** Each tenant keeps its
  OWN retention and walks ONLY its own subtree: the notification shelf's
  bounds (6 h scratch; 14 d / 2000 / 2 GiB kept, enforced by its own sweep
  over `nc-artifacts` subtrees only); per-export `expiresAt` +
  `deleteAfterDownload` (enforced by the export janitor over derived export
  paths only); and for the gallery **none at all** — enrolled samples
  survive every sweep (`RETENTION_EXEMPT_OWNER_KINDS`), which is the correct
  and load-bearing half of the old declaration. No media-class retention,
  mover or eviction may be mapped to this class — a reviewer must refuse any
  future mapping, for any tenant.
- **Singleton**, declared `cardinality: 'single'` — armed by the existing
  `upsertLocation` refusal and the admin UI's multi-only "Add". The export
  path is derived from (root, deviceId, id) and rows store no path, so a
  plurality of roots is unrepresentable without a schema change; the
  notification shelf has no location picker for the same reason.
- **Declared by BOTH consuming addons, identically.** The registry merges
  duplicate declarations (first declarer wins metadata) and THROWS at kernel
  boot on a cardinality or access conflict — so either addon alone seeds the
  class, and each addon's pinning spec holds its side of the agreement (the
  recorder's spec additionally asserts the two manifests agree).
- **`galleryMedia` is no longer a class — it is the gallery rows' PERMANENT
  `locationId` ref**, mapped by the media-storage wiring to the tenant
  subtree (`storage.resolve('artifacts', 'gallery')`). Rows are deliberately
  never restamped for this move: remapping the ref instead of rewriting
  300+ rows is what makes a missing-count disaster — a boot that reads every
  enrolled sample as gone and lets the sample reconcile delete it —
  unrepresentable, for this move and for any future root move. Rows stamped
  `'addon-data'` (2026-08-31 → 2026-09-04) still resolve via the read-side
  legacy alias to `<dataDir>/gallery` until the boot reconcile has drained
  them onto `'galleryMedia'`; that alias dies when no row in the fleet
  carries it.
- **A root that cannot be resolved REFUSES** — never a fallback to the addon
  dir: the artifact plane refuses to serve (bytes-only notifications, loud
  error); the exports bootstrap is SKIPPED entirely (a janitor whose
  `outPath` throws inside its own try would flip rows to `expired` without
  deleting the file — a permanent leak); the export download answers 503
  (refusal), not 404 (absence).
- **Media classes are not part of the system backup, by design — the
  enrolled gallery INCLUDED, and that was decided, not overlooked.** The case
  for an exception was put to the operator explicitly (50 MB of irreplaceable
  enrolled faces against a ~600 MB archive); the answer, verbatim: *"no
  nessuna eccezione. Rimane li in artifacts."* [no, no exception. It stays there in artifacts.] Media locations are
  operator-managed — autonomous backup today, a remote-media-backup cap as
  the intended future answer — never `DEFAULT_BACKUP_LOCATIONS`. Do not
  re-add `artifacts` or the gallery to the backup set.

## Consequences

- Backups: `addons-data/pipeline-analytics` and `addons-data/recorder/exports`
  converge to empty/gone; D338's `recorder/exports` exclusion becomes
  vestigial (its removal belongs to the backup work's owner).
- Deployment shapes: `defaultRoot: 'media'` seeds `artifacts:default` under
  the media mount every template already declares, falling back to
  `<nodeDataDir>/artifacts` where no media root is set. No new volume, env
  var or template entry; `scripts/check-deployment-templates.ts` unaffected. <!-- drift-ok -->
  Placing the class on another disk is the ordinary flow: mount it and
  repoint the ONE location's `basePath` — accepting that both tenants move
  together.
- Repointing takes effect at the next runner respawn of each consumer (roots
  resolve at serve/onHubReachable time); until then reads and writes stay
  coherently on the old root.
- Export download URLs (`/addon/recorder/exports/<id>.mp4`) are unchanged;
  every `recorder:exports` row keeps resolving across the move because the
  path is derived, never stored.
- The live-hub migration is ordered: **deploy the new code, stop the writers,
  copy both trees into the one root, restart, verify by count and bytes, then
  delete** — emptying the notification shelf's old dir with the old code
  still running makes the hourly `prune(keptIds=[])` destroy every artifact
  index row within the hour.

## Enforcement

`nc-artifact-location-declaration.spec.ts` (post-analysis) and
`export-location.spec.ts` (recorder) pin the two manifest declarations
(singleton, media-rooted, id `artifacts`) and their cardinality agreement —
the registry's boot-time conflict throw is the backstop.
`artifact-store.spec.ts` pins the per-device layout, the `0` bucket, the
cross-bucket bounds, and that neither `sweep()` nor `clear()` can touch the
exports tenant or anything else outside its own subtrees.
`export-location.spec.ts` pins the export derivation
(`<root>/<deviceId>/exports/<id>.mp4`), the null-root refusal, and the
mirror isolation (the janitor's sweep cannot touch an `nc-artifacts/`
sibling).
`gallery-media-survives-a-footage-wipe.spec.ts` pins
`GALLERY_MEDIA_LOCATION === 'galleryMedia'`, `GALLERY_TENANT_SUBPATH ===
'gallery'`, and that the manifest declares `artifacts` and no longer
`galleryMedia`; the two isolation tests cover the third tenant in both
directions (gallery files survive the shelf's `sweep()`/`clear()` and the
janitor's sweep; the gallery itself walks nothing). Every named invariant was broken
deliberately and went red before this record was written (flat layout 13;
`events/` subtree 12; root-wiping `clear()` 2; bucket-wiping `clear()` under
the device-first sibling layout 2; dropped/reordered `exports/` segment 1 and
2+2; cardinality flip/disagreement 1 each; `'addon-data'` constant 1;
null-root refusal removed 1; galleryMedia re-declared 1; gallery tenant
subpath flipped 1; root-wiping `clear()` against all three tenants 2). That neither tenant gains a retention mapping is
review-only: nothing maps `artifacts` to a mover, an evictable provider or a
media collection, and adding one is what a reviewer must refuse. D344 was
briefly this record's exports half and is retired unused.
