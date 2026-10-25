---
id: D197
title: An entity retention declares immortal does not live on the footage volume
status: accepted
date: 2026-08-20
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/store/media-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/media-relocate-engine.ts
---

## Context

D59/D61 built a retention model whose central promise is that some entities
**must outlive the track that produced them**. `RETENTION_EXEMPT_OWNER_KINDS`
names them — `identity`, `vehicle`, `scene` — and every sweep in the addon
honours it: the track cascade never names those kinds, the orphan audit refuses
them before any probe runs (`orphan-audit.ts:114`), the disk-wins reconcile does
not even probe them (`disk-reconcile.ts:18-21`). The exemption has been audited
repeatedly and it holds. `MediaStore.evictBefore`, the one method that ever
broke it, was deleted, and `scripts/check-age-keyed-retention.ts` stops it
coming back.

All of that is software. The bytes were somewhere else.

`eventMedia` is declared `defaultsTo: 'recordings'`, so on a default install
every detection crop — including the enrolled gallery — is written **inside the
footage volume**. Footage is the disposable class by construction: quota-capped
(`recordings:default` carries `maxUsedGb`), evicted by the storage-pressure
sweep, wipeable per camera from the recordings UI, and swapped for another disk
when one fills.

On **2026-08-17** the operator wiped the recordings volume. Measured on the live
hub three days later:

- `/recordings/<dev>/events/` holds `event/`, `face/` and `track/` on every
  camera, and `identity/` on exactly the two cameras where somebody was enrolled
  *after* the wipe. Every device directory has a **birth time of 2026-08-17**.
- 28 of 32 `identity-samples` resolve no `base64`; the four that do were enrolled
  on 2026-08-20. `coverMediaKey` is present and well-formed on all four
  identities and `coverBase64` is absent on all four — **the key was there, the
  blob was not.**
- The `retrain` prefix on the same volume is **empty** — the frame COPIES D81
  created precisely so a dataset would outlive its tracks. So are the scene
  reference photographs.
- The nightly backups cover `addons`, `addons-data`, `tls` — the data volume
  only. Nothing backed the pixels up.

Nothing reported any of it. The disk-wins reconcile skips exempt owner kinds by
design, so **the exemption is exactly what stopped anyone noticing that the
exempt bytes were already gone.** The first symptom was a re-embedding pass,
attempted three days later, discovering it had nothing to re-embed.

The wrong fix was considered first and rejected: hardening another sweep. No
sweep did this. Every sweep was correct.

## Decision

**A media owner kind that is exempt from retention is written to a storage
location that is not the footage volume.** `locationForOwnerKind` derives the
target from `RETENTION_EXEMPT_OWNER_KINDS` — the same declaration the sweeps
read, never a second list — and returns `galleryMedia` for exempt kinds and
`eventMedia` for everything else. `galleryMedia` is declared `defaultRoot:
'data'` and `cardinality: 'single'`: the gallery's blob lives on the same volume
as the row that indexes it, and cannot be split across disks.

An exempt row **names its location** (`locationId: 'galleryMedia'`) instead of
carrying the `NULL` that means "wherever `eventMedia` points today" — a repoint
plus `invalidateRoots()` silently re-aims every `NULL` row, which would put the
gallery straight back on the footage volume.

The event-media relocate engine **skips exempt owner kinds entirely**: moving
event media is a footage operation and the gallery does not follow footage.

`MediaStore.relocateExemptMediaToGallery()` runs at every boot as a reconcile,
not a marked one-shot, and it REPORTS exempt rows whose blob is already gone
rather than collecting them: an identity sample with no pixels still holds a
valid ArcFace vector, so deleting the row would turn "cannot show the face" into
"cannot recognise the person".

## Consequences

- The gallery now consumes appdata rather than the media share. It is bounded by
  operator enrolment at a few KB per sample — 32 samples is ~300 KB — so this is
  not a sizing question, and pretending it was is what put it on the footage
  disk.
- Enrolment and un-assignment now MOVE bytes between volumes. `reown` already
  re-`put`s through `putUnchecked`, so no caller changed; the cost is one extra
  copy of a 112×112 JPEG per operator action.
- An operator relocating event media no longer relocates the gallery, and the
  storage UI shows a location they cannot point at a footage disk.
- **Still exposed, deliberately not fixed here**: `retrain-frames` live under a
  `retrain` prefix on `eventMedia` and were destroyed by the same wipe. They are
  the same class of mistake — D81 copies on a disposable volume — but the
  dataset is unbounded ("nothing caps this table or the disk it consumes") and
  moving it onto appdata needs a size decision, not a one-line derivation. It
  is named here so the next reader does not have to rediscover it.
- The 28 crops are **not recoverable**. The source frames aged out under normal
  retention long before the wipe, the buffered face crop IS the blob that was
  reowned, and the backups do not cover the media volume. The rows keep their
  embeddings and keep matching; they can never be re-embedded onto another
  model. This is the concrete argument for enrolment-from-photo: an operator's
  photograph is an original they can supply again.

## Enforcement

`gallery-media-survives-a-footage-wipe.spec.ts`:

- asserts `locationForOwnerKind` over **every** `OWNER_KINDS` entry in both
  directions against `isRetentionExemptOwnerKind`, so a kind declared exempt
  tomorrow is physically protected the same day and a kind that is not exempt
  cannot quietly claim the gallery volume;
- reproduces the chain — buffer a face crop, enrol it, delete every
  `eventMedia:` blob — and requires the enrolled bytes to still read back. The
  same spec keeps a CONTROL that an *unenrolled* crop DOES die in that wipe, so
  the simulation cannot pass by doing nothing;
- pins that an exempt row stamps `locationId` rather than leaving it `NULL`;
- pins the reconcile: it moves a legacy row, is idempotent, and counts a row
  whose blob is already gone as `missing` while leaving the row standing.

Removing the derivation from `putUnchecked` turns three of those red, including
the chain — verified, not assumed.
