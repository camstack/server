---
id: D744
title: Every mirror artefact carries a generated revision, and a copy is proven current by hashing it
status: accepted
date: 2026-10-07
supersedes:
applies-to:
  - packages/system/src/download/model-downloader.ts
  - packages/system/src/download/model-download-service.ts
  - packages/system/src/download/hosted-model-revisions.ts
  - packages/addon-pipeline/src/audio-analyzer/audio-pipeline.ts
  - scripts/check-hosted-model-revisions.ts
---

## Context

D743 added `ModelFormatEntry.revision` and set it by hand on the eight YOLOv9
CoreML entries. Three gaps were left.

- The YOLO26 @320/@256 CoreML packages, replaced in place under D742 to stop
  an abort on load, had no revision. A node holding the crashing copy kept it.
- Nobody knows every artefact that was ever replaced in place. The mirror's
  history was squashed on 2026-10-06, and this repository's history starts on
  2026-10-04. Since the squash, the mirror tree shows exactly two in-place
  replacements: the eight reduced YOLO26 CoreML packages and the eight YOLOv9
  CoreML packages. Both changed `weight.bin`. Before the squash nothing can be
  checked.
- Three download paths ignored the revision. `ModelDownloadService`, which
  serves the CLIP encoder, had its own copy of the download loop. The audio
  analyzer fetched YAMNet with `existsSync` plus `downloadFile` from a URL
  built by hand. Both kept any file already on disk.

The obvious fix was to hand-set a revision on every entry. It was rejected
for two reasons. Under D743 a copy with no record is stale, so giving every
format a revision would make every node download every model it holds again,
several GB per node and again for every distributed copy. And a hand-kept
value goes stale exactly when someone replaces a file and forgets it.

## Decision

Every catalog format hosted on the CamStack mirror has a revision: the sha256
(the mirror's `lfs.oid`) of its weight file. For a Core ML package that is
`weight.bin`, for an OpenVINO IR the `.bin` sibling, otherwise the file
itself (`revisionWeightUrl`). The revisions are generated from the mirror's
tree API into `packages/system/src/download/hosted-model-revisions.ts`, keyed
by path. `resolveFormatRevision` is the one rule: an inline `revision` wins
(for an artefact off the mirror), otherwise the table, otherwise none. A
hosted format never sets one inline.

A copy that has no record, or a different one, is not stale until it has been
hashed. `ensureModel` hashes its weight file. If that matches the revision, it
writes the record and downloads nothing; otherwise it fetches the new bytes as
D743 describes. `isModelDownloaded` stays synchronous and never hashes. The
detection provider runs `adoptModelRevisions` over the catalog in the
background when it starts, so a listing does not report present models as
missing.

Every model download path goes through `ensureModel` / `isModelDownloaded`.
`ModelDownloadService` is now a catalog-bound wrapper over them, and the shared
directory download lists the Hugging Face tree when a bundle declares no
files. YAMNet is fetched from its catalog entry, which now declares its labels
file.

## Consequences

- No node downloads a model again because it got a revision. A copy whose
  bytes match is recorded after one local hash, at provider start or on its
  next `ensureModel`. That includes a copy distributed by a hub (whose tar has
  no record) and the YOLOv9 FP16 copies fetched before D743 shipped. A node
  holding the crashing YOLO26 @320/@256 packages or the FP32 YOLOv9 ones
  fetches the new bytes the next time the model is needed.
- Until it is hashed, a present but unused model reads "not downloaded".
  The startup sweep covers the detection catalog. CLIP models are proven when
  the encoder ensures them.
- A copy whose `weight.bin` is unchanged but whose spec (`model.mlmodel`, the
  IR `.xml`) was replaced would be accepted as current. Every known
  replacement changed the weights. A replacement that changes only the spec
  needs an inline revision, or a new file name.
- The table ships inside `@camstack/system`, which is framework. A revision
  change reaches nodes with a `@camstack/server` release, not with an addon
  deploy.
- After any upload to the mirror, run
  `npx tsx scripts/check-hosted-model-revisions.ts --write` and commit the
  table with the catalog change. Without `--write`, the script reports drift.
- Off the mirror, nothing changed. LLM GGUFs are third-party, are checked by
  their own sha256 after download, and go through addon-ai's own file loop,
  which writes no revision record. A test keeps them free of revisions. Model
  Studio imports (plugin catalog, plus catalog, a URL, a conversion input) write
  operator-owned custom models once, under new names. They have no catalog
  revision, and nothing would replace them in place.
- The legacy `downloadModel` export (`expectedSha256`, fallback URLs) has no
  caller in the repository and was left as it is.

## Enforcement

- `scripts/check-hosted-model-revisions.ts`. Offline, it checks that every
  hosted format has a table entry, that no entry is left without a format, and
  that no hosted format sets an inline revision. Online (read-only, no token),
  it checks that every revision equals the mirror's `lfs.oid`. When the mirror
  cannot be reached it says so and runs only the offline checks (exit 0;
  `--require-network` makes that a failure). It is opt-in and is not wired
  into CI: run it before committing a catalog change that follows an upload.
- `packages/system/__tests__/model-downloader.test.ts` covers the table
  resolution, the inline override, the weight file per format, adoption by
  hash (bundle, IR, single file, older record), a re-fetch on different bytes,
  and an offline sweep.
- `packages/system/__tests__/model-download-service.test.ts`:
  `ModelDownloadService` honours the revision. It re-fetches with siblings,
  keeps the old copy on failure, adopts by hash, and still lists a bundle with
  no files.
- `model-catalogs-hosted-revisions.spec.ts` checks the exact YOLO26 @320/@256
  CoreML revisions and that every hosted detection format resolves one.
  `model-catalogs-yolov9-coreml-fp16.spec.ts` checks that the D743 values are
  unchanged.
- `yamnet-model-files.spec.ts` covers YAMNet, and
  `provider-adopts-model-revisions.spec.ts` the startup sweep. The addon-ai
  `model-ops-download.spec.ts` keeps GGUFs free of revisions.
