---
id: D643
title: A gallery sample names the alignment that cut it, photo samples are re-derived from their originals, and old detected samples leave only once ten new ones stand
status: accepted
date: 2026-09-26
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/face-alignment-version.ts
  - packages/addon-post-analysis/src/pipeline-analytics/face-photo-reenrol-pass.ts
  - packages/addon-post-analysis/src/pipeline-analytics/face-photo-choice.ts
  - packages/addon-post-analysis/src/pipeline-analytics/face-gallery-prune.ts
  - packages/addon-post-analysis/src/pipeline-analytics/face-alignment-jobs.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/identity-store.ts
  - packages/addon-pipeline/src/detection-pipeline/registry/model-catalogs.ts
  - packages/addon-pipeline/src/detection-pipeline/registry/step-definitions.ts
  - packages/addon-pipeline/src/pipeline-runner/stateless-step.ts
---

## Context

The SCRFD fix of 2026-09-26 (anchor centres at `x·stride`, input
`(x − 127.5) / 128`) moved every landmark the face aligner warps on. The
aligned 112×112 template is what `identity_samples.mediaId` stores, so all 527
enrolled samples on the hub (4 identities, 9 photo, 518 detected) were cut by
the OLD alignment, and nothing on a row said so. The read-only measurement the
same day (planning repo: superpowers/specs/2026-09-26-scrfd-gallery-shift.md) in the <!-- drift-ok: the measurement lives in the main checkout, not in this tree -->
main checkout) found:

- a new-aligned camera face against the old gallery auto-matches about 10
  points less often (79 → 69 %); most of the drop lands in the suggestion band,
  wrong-identity assigns do not rise, and the OLD samples are what bound the
  drop;
- once both sides are new-aligned, separation is better than today (d′ 1.42 →
  1.53);
- a detected sample keeps only its template — the source frame is gone — so it
  cannot be re-derived; a photo sample keeps the original (`sourceMediaId`,
  D201), and re-running the photo through the fixed path was unambiguous for
  9/9 (IoU 0.53–0.83, new-vs-stored cosine 0.63–0.86).

The obvious alternatives each fail:

- **Replace the old samples at once.** Detected ones cannot be re-derived, and
  dropping them costs the match rate they still carry.
- **Partition matching by alignment.** It throws away the same old samples,
  for the same loss.
- **Stamp a detected sample from the time it is enrolled.** The faces buffer
  keeps faces for days; a face captured before the deploy and assigned after it
  would be stamped new, and the prune below counts exactly that stamp before
  deleting.
- **Delete `scrypted-yolov9t-face` from the catalog and stop there.** Its graph
  emits `[1, 5, 2100]`, which the step's `scrfd` postprocessor cannot parse, so
  it returned `[]` with no log line. But `resolveModelForFormat` passes an id the
  catalog does not know through UNCHANGED, as an operator's custom model, so a
  saved pin would keep naming a model no node can load.

## Decision

Every identity sample written from now on carries `alignment: 'scrfd-v2'`. An
unstamped row is v1. A DETECTED sample is stamped from its face's CAPTURE time
(`SCRFD_V2_ALIGNMENT_SINCE_MS`, after the last node took the fix), never from
its enrol time. A PHOTO sample is stamped at enrol, and it also keeps the face's
box in the original (`sourceBbox`). The stamp is audit-only: matching reads
every sample.

Photo samples are re-derived through the real photo analyze path by
`embedding.reenrolPhotos`. The action takes `dryRun`, which chooses and reports
each pick but writes nothing. An automatic pass on the re-embed timer then
finishes the job, but only after it is ARMED. Nothing is armed after a deploy.
The first real admin run with no `maxSamples` that completes arms it. A dry run
or a budgeted canary does not. The arm lives in memory, and the timer stops
scanning once the photo samples have converged. The face is
chosen by IoU with `sourceBbox` when the row has one, otherwise by the highest
cosine to the old vector. The pick must clear a cosine floor of 0.5. The sample is REFUSED, and the
refusal is logged, when any of these holds:

- a second face comes within 0.1 of the pick's cosine;
- a second face overlaps the box;
- the model does not match.

A face that analysis marked non-enrollable still counts as a rival. The new sample is added first, and the old
one is removed only after the add has landed. A write that throws is read back:
a row that landed anyway is kept, and a template blob is reclaimed only when no
row names it. A failed step leaves the old
sample untouched (D49). The source photograph is never deleted.

Old DETECTED samples are pruned per identity once it has ten v2 DETECTED
samples. This runs hourly and after every detected enrol. The plan executes
only where a second read agrees, it never leaves an identity empty, and it
never touches a photo sample.

The prune reads through a projected query served by the covering index
`idx_sample_identity_prune` (D447). Removing a sample detaches every buffered
face that names it and clears the crop that left with it. The face keeps its
assignment. `IdentityStore.removeSample` never counts out a row that is already
gone.

A catalog model that is removed is listed in `RETIRED_MODEL_IDS`. A pin to it
resolves to the step's format default, and a stateless step pinned to it is
refused by name (D54).

## Consequences

- The photo pass runs on its own after `addon-post-analysis` is deployed. It
  waits for a model re-embed pass and refuses a sample whose model is not the
  cluster's, so a model flip must converge first.
- A face captured between the deploy and the cutoff (12:08Z–12:30Z on
  2026-09-26) is stamped v1. That only delays the prune.
- `sourceBbox` exists only on photo samples written from now on. The nine live
  photo samples are chosen by cosine this once; the photo samples they are
  replaced with carry a box, so the next re-enrol chooses by IoU.
- Recalibrating the match threshold stays LAST and is not part of this record.
  It needs a gallery that is mostly v2.
- Removing a detected sample goes through `FaceGalleryProvider.removeSample`,
  the operator's Remove path. That path now detaches the buffered faces that
  name the sample. A photo sample is never removed that way, because that path
  deletes `sourceMediaId`.
- A process crash between writing a template and `addSample` leaves one
  identity-owned blob that no row names. The `template written` log line
  carries its media id.

## Enforcement

Tests pin each gate, and each was disarmed once to confirm its spec fails:

- `face-photo-reenrol-pass.spec.ts`: IoU, floor, ambiguity, the stamp's
  idempotence, D49 on add and on analyze.
- `face-gallery-prune.spec.ts`: the threshold, photo samples, the last sample,
  the confirm read.
- `face-alignment-version.spec.ts`, plus the stamp specs in
  `identity-store.spec.ts`, `face-gallery-provider.spec.ts` and
  `photo-enrollment.spec.ts`.
- `face-alignment-jobs.spec.ts`: the auto trigger converges.
- `retired-face-model.spec.ts`: a retired pin falls back.
- Fix round 1 (also disarmed once each):
  - the dry run, the arm and convergence;
  - the REAL old-photo-sample removal, which keeps the source photo;
  - detaching buffered faces, and the single decrement;
  - the read-back after a write that throws;
  - non-enrollable rivals;
  - the covering index, checked with `EXPLAIN` on the real engine
    (`identity-prune-plan-over-real-sqlite.spec.ts`);
  - the retired servability refusal (`stateless-step.spec.ts`).

No guard stops a future catalog removal that skips `RETIRED_MODEL_IDS`. That is
review only.
