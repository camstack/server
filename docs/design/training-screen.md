---
title: The training screen — census and design
covers:
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/**
  - packages/addon-post-analysis/src/pipeline-analytics/training-export/**
  - packages/addon-training/src/page/frames/**
---

# The training screen — census and design

> **Superseded for admin Training UI (2026-10-10).** The `/addon/training`
> redesign — Frames corpus grid (KPI, work-state filters, pagination,
> annotation overlay; no Collections tab), Jobs as DataTable + Add-job
> dialog (one base model by default; multi-arch advanced → sequential
> `startJobBatch`), Providers as a multi-entry hub — is specified in
> (planning repo: superpowers/specs/2026-10-10-training-admin-redesign-design.md)
> and planned in
> (planning repo: superpowers/plans/2026-10-10-training-admin-redesign.md).
> Architecture: [`docs/architecture/cloud-training.md`](../architecture/cloud-training.md)
> (D824). **Dataset freeze / versioning is removed end to end** — do not
> implement or revive freeze UI, version stores, or `datasetVersionId` on
> plan/start from anything below.
>
> This file remains a **historical census** of the Retrain curation path
> (Library → Retrain / viewer Library). Status below (STEP 0…3) still
> describes that curation surface; cloud Jobs / Providers / Frames on the
> Training addon follow the redesign spec, not the freeze/version notes
> that appear later in this document.

> Status (curation census): **census closed, design proposed, STEP 0 SHIPPED**
> (2026-09-16) — see § 6. Viewer Library → Retrain MVP SHIPPED (Step 3,
> 2026-10-10). Date: 2026-09-16. ADR number reserved for the architectural
> decision: **D509** (to be written only when the operator approves the
> design — see § Steps).

The request is: *a training screen, on viewer and admin UI, to work an
event and correct a frame to send to the train engine.* This document
first answers the question that comes first: **what already exists.**

The short and surprising answer: **almost the whole backend exists, is complete, is
live on the hub, and has been used zero times.** A complete admin screen
also exists. What is missing is not the part one imagines is missing.

---

## 0. What is MEASURED and what is READ

Separated in full, because the rest of the document leans on it.

### Measured on the hub (read-only, 2026-09-16)

| Question | Command | Answer |
| --- | --- | --- |
| Do the retrain methods exist on the live hub? | `pipelineAnalytics.listRetrainStaging {"limit":50}` | **yes** — answers `[]` (not 404) |
| How many tracks in staging, across the fleet? | same | **0** |
| How much would the export of the marked tracks weigh? | `pipelineAnalytics.getTrainingExportSummary {}` | `trackCount: 0, fileCount: 0, byteCount: 0` |
| How many rows in the retrain dataset? | `pipelineAnalytics.countUnstampedEventMedia {}` | `retrainFrames: { present: false, rows: 0 }` |
| Where does `eventMedia` point today? | `storage.listLocations {}` | `eventMedia:ssd` → `/media-fast/eventMedia` (host: `/mnt/mixed/camstack/media`) |
| Do the retrain blobs exist on disk? | `ls /mnt/mixed/camstack/media/eventMedia/retrain` | **does not exist** — no `retrain/` prefix |
| Is the Retrain page really deployed? | grep on the bundle in `addons/@camstack/addon-admin-ui/dist` | **yes** — `listRetrainStaging`, `proposeRetrainAnnotations`, `saveRetrainAnnotations` appear in the `Events-*.js` chunk |
| Do registered custom models exist? | `customModelRegistry.listModels` | **`[]`** — no fine-tuned model has ever come back in |

**Measured conclusion: the chain is built and has never been walked.** Not
one frame selected, not one annotation, not one model coming back.

### Read in the code / in the history

Everything else in this document. Where a claim comes from
(planning repo: sessions/sessions.md) it is marked *(history)*. <!-- drift-ok: moved to the private planning repo -->

---

## 1. The data path, from marking to export

```
  viewer / admin                hub (addon-post-analysis)              disk
  ──────────────                ─────────────────────────              ─────
  [★ Mark for training]
    setTrackFlags               retrainStatus: none → staging      (the track
    auth: protected             ↳ retention PIN on the track        stays alive)
                                ↳ budget 500 tracks/camera
          │
          ▼
  [Library → Retrain]           listRetrainStaging   (admin)
    worklist                    ↳ frameCount / annotationCount
          │
          ▼
  [frame picker]                listRetrainFrames    (index rows only)
                                ↳ candidates = ONLY whole, undrawn frames
                                  (keyFrame, fullFrame, first/last, snapshot,
                                   keyFrameSmall). Never crop, never fullFrameBoxed.
          │
          ▼
  [select]                      selectRetrainFrames  ── COPY-ON-SELECT ──▶ eventMedia
                                ↳ the bytes become the dataset's property     retrain/<dev>/<track>/<hash>.jpg
                                ↳ named refusals: source-missing /            + row in
                                  unreadable-image / write-failed             pipeline-analytics:retrain-frames
          │
          ▼
  [canvas]                      getRetrainFrameImage (base64 + w/h in the
                                 SAME response — a canvas that guesses
                                 the dimensions draws every box crooked)
          │
          ├── [Propose]         proposeRetrainAnnotations
          │                     ↳ pipelineRunner.runStatelessStep on the COPY
          │                     ↳ package = rfdetr-package @0.35 on the ZONE crop;
          │                       without a zone it REFUSES (no-zone), does not widen
          │                     ↳ every box comes back source:'assist' + model + score
          │
          ▼
  [save]                        saveRetrainAnnotations  ─────▶ pipeline-analytics:retrain-annotations
                                ↳ replaces the WHOLE set of the frame
                                ↳ 3 separate tiers: macroClass (closed set) /
                                  label / subLabel; a macro in label is REFUSED
                                ↳ one row per SUBJECT, not per frame
          │
          ▼
  [Complete track]              completeRetrainTrack → retrainStatus: trained
                                ↳ refuses if no copy was taken
                                ↳ 'trained' is EVICTABLE again (D81): the
                                  dataset no longer depends on the track's media
          │
          ▼
  [download]                    getRetrainExportUrl  →  GET /addon/<id>/retrain-export?deviceIds=…
        ✗ NO BUTTON             tar: annotations.json + frames/<dev>/<track>/<leaf>.jpg
                                ↳ for every subject: canonical full-frame bbox +
                                  derived { letterbox, zoneCrop, subjectCrop },
                                  DERIVED at export, never stored (D52)

                                (in parallel, another archive, another purpose)
                                getTrainingExportUrl → /addon/<id>/training-export
        ✗ NO BUTTON             tar: VERBATIM media of the 'staging' tracks,
                                manifest WITHOUT boxes. Selection 'staging', never
                                'trained' (a sweep may delete a trained one
                                halfway through the export).
          │
          ▼
        ┌───────────────────────────────────────────────────────┐
        │  THE TRAIN ENGINE DOES NOT EXIST. The archive ends up │
        │  in the operator's browser and the repo no longer     │
        │  follows it.                                          │
        └───────────────────────────────────────────────────────┘
```

### What is COMPLETE (server)

- **Lifecycle** `none → staging → trained` (D81), with the retention pin on
  `staging` only, per-camera budget (`MAX_STAGING_TRACKS_PER_DEVICE` = 500),
  `trained` terminal for the generic toggle and a distinct error for every
  refusal (`TrackAlreadyTrainedError`, `StagingBudgetExceededError`).
- **Copy-on-select** (D86), with the order that is the contract: it answers
  from the index of the copies BEFORE touching the source, so a track that
  retention swept away does not make an annotation from last week unopenable.
- **3-tier taxonomy** with a guard at WRITE time (`checkTierSeparation`),
  because a mixed taxonomy cannot be unmixed by reading it.
- **Per-model geometry derived at export** (`retrain-geometry.ts`):
  `letterbox` / `zone-crop` / `subject-crop`, pure and total, `null` instead of a
  clamped box (a clamped box is a WRONG label).
- **Assist** via `runStatelessStep`, with the `no-zone` refusal instead
  of silent widening.
- **Two tar data-planes**, admin-only, built entry-by-entry with a 25 ms
  yield between files, manifest first, `HEAD` that answers the question at zero
  cost.
- **13 cap methods** in `pipelineAnalytics`, all implemented in
  `pipeline-analytics/index.ts:5496-5613` and all in the generated router.

This is finished and carefully done work. It must not be redone.

### What is INCOMPLETE

**I1 — The export has no button. Anywhere.**
`usePipelineAnalyticsGetTrainingExportSummary`, `…GetTrainingExportUrl`,
`…GetRetrainExportUrl` exist generated in
`packages/ui-library/src/generated/system-hooks.ts` (lines 1830, 1833, 1869) and have **zero
call sites** in the whole repo. `pages/Retrain.tsx` imports ten retrain hooks and
does not import these. It is the **only break in the end-to-end chain**: the
dataset can be built and cannot be taken away, except by composing the URL by
hand.

**I2 — "Back to staging" is a dead control.**
`pages/Retrain.tsx:337-341` shows the button when `selectedTrack !== null`,
but `selectedTrack` can only be chosen from the worklist, which is `listRetrainStaging`
— **staging only**. A `trained` track is not selectable, so
`restageRetrainTrack` always answers `not-trained`. Worse: `onComplete` does
`setSelectedTrack(null)` (`:298`) and the track disappears from the UI for ever —
there is no way to review what was annotated. A leftover that describes the right
design and does not execute it: exactly what `CLAUDE.md` says to delete when
one finds it.

**I3 — The box is drawn, not corrected.**
`lib/retrain-boxes.ts` exports `displayedImageRect`, `pointerToNorm`,
`dragToBox`, `boxStyle`, `boxAtPoint`, `isDrawnBox`. **There is no move, no
resize, no handles.** `RetrainCanvas.tsx` has no resize branch.
"Redrawing the box" today means deleting it and doing it again from
scratch — acceptable once, unsustainable on a frame with six subjects.

**I4 — The assist model is hard-wired.**
`pages/Retrain.tsx:203` → `{ kind: 'objects', modelId: 'yolo26n', minScore: 0.3 }`,
literal, and no `nodeId`. The cap accepts both as parameters. Result:
the assist proposes with a model that may not be the one actually running on
that camera, at a threshold that is not the camera's, on a node that is
"wherever it happens" — and the proposal exists precisely to compare against what the
system concluded.

**I5 — The page shows a PROPOSAL, not the DECISION.**
This is the conceptual hole, not a cosmetic one. The canvas opens empty; the only
way to see boxes is to press *Propose*, which **re-runs a model now**.
The boxes that the system really drew on that track — those that
produced the event, the notification, the best shot — are never loaded. So
a "false positive" marked today is the false positive of a re-run, not
the one the operator saw in the notification. If the re-run does not
reproduce it (different model, different threshold, different crop), the phantom to
unlearn **is not annotatable at all**.
The data is there (`pipelineAnalytics.getObjectEvents` carries the bboxes of the object
events), but it is device+time, not frame: the input cap that says *"the boxes that
the pipeline concluded on THIS frame"* is missing.

**I6 — `retrainStatus` is not visible.**
No staging/trained badge in the admin feed nor in the viewer. An operator does not know,
looking at an event, whether it has already been worked. In the viewer only the
"Mark for training" filter chip exists.

**I7 — The dataset lives on a disposable volume.**
`RETRAIN_MEDIA_LOCATION = 'eventMedia'`, by declaration in
`retrain-frame-store.ts:53`. The retrain rows **do not go through**
`locationForOwnerKind` (they are not `media` rows), so the D197 exemption that
sent the gallery to `galleryMedia` **does not cover them**. *(history,
`sessions.md:26939`)*: the previous retrain corpus was destroyed by the wipe of the
recordings volume of 2026-08-17, and D197 names the residue explicitly without
closing it — *"quella tabella non ha alcun cap e metterla su appdata è una
decisione di dimensionamento"* [that table has no cap at all and putting it on
appdata is a sizing decision]. Today `eventMedia` points to SSD (`/media-fast`),
so the risk has changed shape but is not closed: it is still a footage-class
location, and the occupancy of `eventMedia` is measured on the `events/` subtree
(D327) — `retrain/` **is counted by nobody**.
The relocate engine, it must be said, does know the retrain rows
(`media-relocate-engine.ts:102`), so an orderly migration carries them along.
It is the wipe, not the migration, that is the danger.

**I8 — mAP and ground truth exist and are orphaned.**
`addon-benchmark/src/runner/accuracy.ts` implements IoU, per-class AP and
`computeAccuracy` → `{mAP50, precision, recall}`. **Nobody populates
`groundTruth`**, and its `GroundTruthAnnotation` has no link to
`RetrainAnnotation`. The "post-fine-tune regression test" that D86 promises is
realised inside the retrain (`kind: 'model_error'`), not here.

### What is MISSING altogether

**M1 — The train engine.** It does not exist and **is a declared non-goal**:
`docs/design/model-studio-design.md:152` — *"Non-goals: Training models (import
only)"*. Model Studio converts and quantises (ONNX → OpenVINO fp16/int8, CoreML) and
imports from the plus catalog and the plugin catalog; it does not train. `torch` is in
`requirements.txt` only as an ONNX→CoreML bridge. The plus catalog is used read-only:
no image upload.

**M2 — The consumer of the archive.** No script, no container, no
doc says what to do with it. Zero occurrences of `camstack-training-`/`camstack-retrain-`
outside the code that generates them. No occurrence of `ultralytics`, `roboflow`,
`label-studio` in the whole repo.
*Terminological trap to keep in mind when reading the roadmap: there "train"
almost always means **npm release train**.*

**M3 — The return of the model.** `customModelRegistry` has **a single cap method**,
`listModels`. Registration, upload and distribution are `customAction`s of
model-studio (`registerCustomModel`, `beginModelUpload/append/commit`,
`distributeModel`). The way back in exists, but it is manual, is not documented
as a continuation of the retrain, and has never been walked (empty registry,
measured).

**M4 — The bridge to INT8 calibration.** `calibrationRef` → `calibDir`
exists (`model-studio-actions.ts:260`, `convert.py:36`), and **nothing populates it**.
The question *"COCO di default o upload dell'operatore?"* [COCO by default or operator upload?] has been open since June
(`model-studio-design.md:143`). The retrain-export is exactly a
representative set of this fleet: it is the natural candidate, and nobody has
connected them.

**M5 — Any retrain surface in the viewer.** Zero. The viewer has only the
★ toggle (`TrackFlagButtons.tsx:342-352`, gated `isAdmin`) and the filter chip.
`retrainStatus` does not appear in `camstack/src` outside the test fixtures.

---

## 2. Today's UI surfaces

### Admin UI — complete and reachable

`nav-items.ts:112` → **Library** entry (`/events`, `adminOnly`) → `pages/Events.tsx:32-43`
three tabs: *Feed* / **Retrain** / *Debug*. `/retrain` is a legacy redirect. The gate
is the route, not the tab.

`pages/Retrain.tsx` (451 lines) + `components/retrain/` (616) + `lib/retrain-boxes.ts`
(132, pure and tested without a DOM). The worklist → picker → copy → canvas →
propose → save → complete flow is all there, with client validation mirroring
the server's and the editor always re-seeded from the server (so a deleted
box does not reappear). Test: `pages/__tests__/Events.spec.tsx` drives the whole
flow through the real components *(history, `sessions.md:19773`)*.

Defects already listed: I1 (no export), I2 (dead restage), I3 (no
resize), I4 (hard-wired model), I5 (no decision loaded), I6 (no
badge). In addition: **no zoom** and **no keyboard shortcut** — on a
distant subject the box is drawn by eye.

### Viewer — no surface

Only the marker. The viewer **feeds** the queue that the admin UI works, and does not
work it. It is the state that the operator's request wants to change.

### `@camstack/ui-library` — web-only, and that is not a detail

- `peerDependencies`: `react-dom`, `konva`, `react-konva`, `tailwindcss >=4`.
- `exports`: `.`, `./theme`, `./tailwind/*`. **No `react-native` entrypoint.**
- The primitives are DOM JSX with Tailwind `className`, not `StyleSheet`.
- The four canvases (`MaskShapeCanvas` 1205 lines, `PrivacyMaskSettings`,
  `MotionZonesSettings`, `SceneMonitorEditor`) are **Konva**, i.e. DOM canvases:
  in React Native they do not exist.
- It is **host-provided** (D15): two copies = two Reacts.

The viewer declares it in `package.json:60` but in `camstack/src` the only
occurrence is **a comment**. All the real imports are in `camstack/embed/`,
which is web/Vite.

**So: no piece of the admin canvas is reusable in the viewer as it is.**

### But the viewer already has all the RN bricks

And this changes the cost of the project:

| File (`camstack/src/components/camera/…`) | Technology | What it gives |
| --- | --- | --- |
| `ZoneDrawOverlay.tsx` (347) | `react-native-svg` + RN responder | **rect or polygon** drawing on live, normalised 0..1 |
| `CustomZoneDrawOverlay.tsx` (386) | `react-native-svg` | polygon on a **letterboxed** snapshot, vertex drag |
| `polygon-draw.ts` (136) | pure TS, tested | `fitContain`, `toNormalizedPolygon`, `toFrameLocal` |
| `theater/zone-filter.ts` (360) | pure TS | **`dragToRect`**, `ZoneRect`, `isShapeUsable` |
| `theater/detail/BoundingBoxOverlay.tsx` (97) | absolute Views + `containRect` | read-only box on a `contain` frame |
| `theater/detail/ZoomableImage.tsx` (370) | `react-native-gesture-handler` | **pinch/pan** on the frame |

A box editor for the viewer does not have to be written from scratch: only the multi-box
with selection and resize handles is missing. Which is, incidentally, **exactly what is missing
from the web version too** (I3).

---

## 3. The requested correction actions, one by one

| Action | Cap method | Persistence | Reaches the export | Verdict |
| --- | --- | --- | --- | --- |
| Correct the **class** | `saveRetrainAnnotations` (`macroClass` + `label` + `subLabel`) | yes, 3 separate columns with a guard at write | yes, all three in the manifest | **complete** |
| **Redraw** the box | `saveRetrainAnnotations` (`bbox`) | yes, normalised full-frame | yes, + 3 derived geometries | **backend complete, UI no**: one can only delete and redraw (I3) |
| **Discard** the frame | `deselectRetrainFrame` | yes — removes annotations, then row, then blob | n/a (leaves the dataset) | **complete** |
| **False positive** | `saveRetrainAnnotations` with `kind: 'model_error'` + `assistModelId` + `assistScore` | yes | yes — taught by **omission** (no YOLO positive; no “NOT class” label), with the row saying that the omission was intended | **complete** in Training Frames (pipeline drafts + `E` / Mark as model error). Hard negative = frame `complete` with zero `subject` boxes. |
| **False negative / missing object** | `saveRetrainAnnotations` with `kind: 'subject'` | yes | yes | **complete** (it is drawing a new box) |
| Discard the whole **track** | `setTrackFlags { markForTrain: false }` | yes (`staging → none`) | yes, leaves the selection | **complete** |
| **Review** a finished track | `restageRetrainTrack` | yes | yes | **unreachable from the UI** (I2) |

The data model is richer than the request: it also holds the sub-identity
(`subLabel`: *Marco*, not just *postman*) and the per-box provenance
(operator/assist + model + score), which is what makes an omission readable
as "intended" and not as "frame abandoned".

---

## 4. What is missing for the screen the operator describes

Ordered by how much it costs **not** to have it.

### Missing cap methods

1. **`listRetrainTracks`** — or `listRetrainStaging` with `status?: RetrainStatus[]`.
   Without it, `restageRetrainTrack` stays unreachable and a completed track is
   invisible for ever. Extending the existing one is preferable: one more method
   that answers the same question with a different filter is a second
   authority.
2. **The boxes the pipeline CONCLUDED on a frame.** A `detections` (or
   `pipelineBoxes`) in the output of `listRetrainFrames` per copied frame, or a
   field in `getRetrainFrameImage`. Without this the screen does not correct an
   event: it corrects a re-run (I5). **It is the most serious hole.**
3. **The assist default must come from the server.** The model and the threshold that
   really run on that camera, plus the node that hosts them, in the response of
   `listRetrainFrames` — not a constant in the .tsx (I4).

### Missing fields

4. `retrainStatus` **in the event list** (viewer + admin), for the badge (I6).
   The field is already on `TrackSchema`; it only needs to be shown.
5. A counter of the per-camera **staging budget** (500) in the worklist: today the
   refusal arrives only at the moment of the mark.

### Missing UI pieces

6. **Export button** — `getRetrainExportUrl` + `getTrainingExportSummary`
   as a zero-cost question before moving bytes (I1).
7. **Box move + resize** with handles, in a single implementation (I3).
8. **Zoom/pan on the frame** during annotation (in the viewer `ZoomableImage`
   already exists; on the web no).
9. **A viewer screen that does not exist** (M5).

### Things that must NOT be built now

10. A train engine (M1). It is a declared non-goal and it is not what is needed to
    "work an event".
11. A YOLO/COCO format. The retrain-export carries the canonical box **plus** the three
    derived geometries: a converter to YOLO is 30 lines outside CamStack and
    does not need to live here. If one day it is needed, it will be one more
    derivation in the same place (`retrain-geometry.ts`), never a second copy in DB
    (D52).

---

## 5. The proposed design

### The principle

> **What is DECIDABLE has a single implementation; what is PAINTED has one
> per surface.**

The box maths, the taxonomy validation, the annotation state machine
(what is dirty, what is savable, what a proposal does to what is
already on screen) are decidable and are already written twice halfway: in
`lib/retrain-boxes.ts` (web, 132 pure and tested lines) and in
`polygon-draw.ts` + `zone-filter.ts` (RN, 496 pure and tested lines). The DOM
canvas and the `react-native-svg` canvas instead are paint, and there is no honest way to
share them.

### The shape

```
  packages/retrain-core/                    ← NEW, pure TS, zero dependencies
    src/
      boxes.ts        displayedImageRect, pointerToNorm, dragToBox, boxAtPoint,
                      + moveBox, resizeBox, handleAtPoint, HANDLE_KINDS   ← I3
      zoom.ts         zoom/pan ⟷ normalised transformation                ← UI-8
      annotations.ts  EditableAnnotation, pure reducer:
                      draw / select / delete / retag / applyProposals /
                      seedFromServer / isDirty / isValid
      taxonomy.ts     RETRAIN_MACRO_CLASSES + checkTierSeparation
                      (today duplicated between cap and addon: here it becomes ONE)
    __tests__/        everything testable without a DOM and without RN

         ┌────────────────────────┴────────────────────────┐
         ▼                                                  ▼
  addon-admin-ui                                      camstack/src
    RetrainCanvas.tsx      (DOM, already written)       RetrainCanvas.native.tsx
    RetrainAnnotationEditor  (already written)            (react-native-svg,
    RetrainFramePicker       (already written)             from ZoneDrawOverlay)
    RetrainStagingList       (already written)           RetrainEditorSheet
    → loses ~130 lines, gains resize                     ZoomableImage (exists)
```

The two renderers call the **same** pure functions and the same caps. Neither
surface has a rule that the other does not have.

### Where the core lives, and why not elsewhere

`@camstack/retrain-core` is a new package, published on npm like the others,
**because the viewer is a standalone repo in CI**. The viewer already depends on
`@camstack/types ^1.2.200` and `@camstack/sdk ^1.2.21` and aliases them to the sources in
`tsconfig.json:11-16` for local development: the exact same mechanism, already
proven, already in CI. (The viewer's `CLAUDE.md` warns that a type *not* declared
in its `package.json` passes locally and dies in CI — so the package must be
declared there, not just aliased.)

**Discarded alternatives:**

- **`@camstack/ui-library`** — it is web-only by construction (react-dom, Konva,
  Tailwind) and **host-provided** (D15): the viewer cannot receive it without
  dragging in a second React. Putting pure TS in it would work only
  with a second entrypoint, i.e. with a second identity of the package.
- **`@camstack/types`** — it is the wire contract. A UI reducer in there
  confuses "what the network carries" with "how the screen behaves", and the
  next person would not know which of the two is changing.
- **Just duplicate** — it is the current state, and it has already cost: `RETRAIN_MACRO_CLASSES`
  exists twice (cap + addon) held together by a hand-written type assert
  (`MacroClassesAgree`). A third copy in RN would be the fourth authority
  on the same list.

### The most serious alternative that I discarded: a single web UI, framed

The viewer already owns a **web** app with dispatch on `?mode=` (`embed/src/EmbedApp.tsx`:
grid / player / recording / events), served by the hub under
`/viewer/camstack/embed/index.html`, loaded in a WebView on native and in an iframe on
web. A `?mode=retrain` would give **a single implementation** reachable from
both surfaces.

I discarded it, and it is worth saying why — if the operator prefers it, it is a
defensible choice:

- **The canvas would be the THIRD copy, not the first.** The admin UI already has its
  page complete and deployed; the embed cannot import it (`addon-admin-ui` is
  not a package the embed consumes). Either the admin page is thrown away, or it is duplicated.
- **No precedent:** the admin UI does not frame the embed anywhere
  (verified). It would be a first time on an admin-only surface.
- **The shipping chain gets longer:** `sync:embed` → `build:orchestrator` →
  `camstack deploy addon-pipeline-orchestrator` → submodule pin. A fix to a
  resize handle would go through there.
- **Annotation is touch-intensive.** Pinch/pan inside a WebView inside a
  ScrollView is the kind of problem this repo has already paid for.

The shared core costs more in setup (a new package, a publish) and less
for every later change. The embed costs less right away and taxes every iteration.

### Auth

All the curation methods are `auth: 'admin'`, deliberately: *"marcare una
traccia è curation che fai mentre la guardi; costruire il training set su cui si
fanno il fine-tune i modelli della flotta no"* [marking a track is curation you do
while looking at it; building the training set on which the fleet's models are
fine-tuned is not]. The viewer is an authenticated non-admin surface, and **already today** hides the ★ toggle from non-admins
(`TrackFlagButtons.tsx:341`). The viewer screen follows the same rule: visible
only to admins, `useCapabilityPresence` to know whether the cap is there (never
`(data ?? [])`, D315), and no change to the existing auth levels.

---

## 6. The plan, in order

Each step is shippable on its own and leaves the system better than it found it.
The first three do not touch the viewer and do not require the new package.

**Step 0 — DONE** (2026-09-16).
Close the end-to-end chain on the surface that already exists:
- **Export dataset** button in the admin Retrain page, with
  `getTrainingExportSummary` as a zero-cost question first ("2,314 files,
  1.8 GB") and `getRetrainExportUrl` for the annotated archive (I1);
- **delete or make work** "Back to staging" (I2) — if made to work,
  it needs the filter by status (§4.1), so for now **deleting it** is the honest
  move and must be done right away: a dead control reads as verified;
- `modelId` / `minScore` / `nodeId` of the assist read from the server instead of
  hard-wired (I4).
Cost: small, all inside `addon-admin-ui` + one widened cap response.
Effect: from today the operator can mark, annotate **and take the dataset away**.

All three closed. Two things are worth more than the account, because they contradict
this document:

- **I4 was worse than written above.** Measured on the hub: 101's detection
  runs on `<agent-host>` / `coreml:all`, whose elected detector
  is `yolov9m-320`. The `yolo26n` hard-wired in the `.tsx` is the step's *catalog*
  default and **no accelerator enabled on that node runs it**. The old call, without `nodeId`, landed wherever it happened and
  asked a node for a model it might not serve — it was not "a hard-wired
  default", it was an impossible request with an indeterminate node.
- **§4.3 assumed that `resolvePipeline` was enough.** It is not: for 101 it carries
  neither `modelId` nor `settings`. The three levels must be collapsed with
  `resolveEffectiveStepModel`, the sole owner of that decision. And the
  step declares `defaultConfidence` with separate **per-class** thresholds, not a
  single `minScore` as written here.

What remains **unproven**, for lack of data on the fleet: no archive
downloaded (0 tracks in staging), no `proposeRetrainAnnotations` executed,
page never opened in a browser.

**Step 1 — the boxes the pipeline really drew** (I5). **DONE** (2026-10-08,
D790): `RetrainFrame.pipelineBoxes`, drafts on the canvas.
`listRetrainFrames` returns, for each copied frame, the boxes that produced
the event. The canvas opens **with the decision already on top**, in grey, each box
one click away from becoming a confirmed `subject` or a `model_error`. It is the step that
turns the screen from a "generic annotator" into an "event corrector", which is
the request.

**Step 2 — `packages/retrain-core`** (new), containing only pure TS and its tests. <!-- drift-ok: proposed package, not yet created -->
**Admin half DONE** (2026-10-08): move / resize with handles, zoom and pan,
keyboard and undo, in `addon-admin-ui/src/lib/retrain-{boxes,zoom,history,shortcuts}.ts`.
The box maths stays in the admin UI's `lib/` for now; extracting the shared
`retrain-core` package is deferred to the viewer step (Step 3), its first
second consumer.
`retrain-boxes.ts` moves into it, gaining `moveBox` / `resizeBox` /
`handleAtPoint` (I3) and the zoom. The admin UI becomes its first consumer: at the
end of the step the web page **behaves exactly as before, plus the resize**.
Red verified first: a core function is broken and the page's tests
must turn red.

**Step 3 — the viewer screen** (MVP SHIPPED in the viewer repo, 2026-10-10).
Admin-only **Library → Retrain** (`?section=retrain`), sibling of Review —
staging worklist, copy-on-select, drag-box annotate, save, complete track.
`retrain-core` extraction and admin parity (collections, assist, resize/undo/
zoom, export) remain deferred. Admin curation stays on `/retrain`.

**Step 4 — the `retrainStatus` badge** in the feed (viewer + admin) and the budget
counter in the worklist (I6, §4.5). Small, very visible.

**Step 5 — the D509 decision and the return of the model.** Only here is it decided whether
the retrain-export feeds `calibDir` for INT8 (M4) and whether the fine-tuned
model comes back in through `registerCustomModel` (M3). It is a product decision,
not a code one, and it blocks nothing above.

**Outside the plan, but to be told to the operator:** the dataset lives on `eventMedia`, a
footage-class volume, not counted by occupancy and already destroyed once
(I7). Before anyone spends hours annotating, it is worth deciding whether the retrain
copies go on `galleryMedia` or on a location of their own. It is a
sizing decision — the same one that D197 left open in writing — and must be taken
**before** the manual work, not after.

---

## 7. What I could not verify

- **The real behaviour of the Retrain page in a browser.** It is deployed
  (measured in the bundle) but I did not open it: the constraint was read-only on the hub
  and I did not do a UI session. All the I2/I3/I4/I5 defects come from reading
  the source, not from use.
- **Whether `proposeRetrainAnnotations` works on today's fleet.** It is a
  mutation and I did not invoke it. I do not know which node would pick up a call
  without `nodeId`, nor whether `yolo26n` is servable there. With zero tracks in staging there
  was no frame to try it on anyway.
- **Whether the two tar data-planes really respond.** I downloaded nothing (with
  `trackCount: 0` I would have got an empty archive, which does not prove the path).
  `HEAD /addon/<id>/training-export` would be the zero-cost proof: I did not do
  it because it needs the resolved addonId and the data plane's auth, and I did not want to
  touch surfaces that were not requested.
- **The cost of the new package in the publish chain.** I know the viewer
  consumes `@camstack/types` and `@camstack/sdk` from npm with a local alias, but I did not
  verify how much it weighs to add a fourth package to the release train nor whether
  `publish only affected` handles it without friction.
- **Whether the operator ever opened the page.** Zero staging and zero blobs say
  that he never *completed* anything; they do not say that he did not look at it.
- **Why the previous retrain corpus disappeared** beyond what is written in
  `sessions.md` — I did not redo that investigation, I cited it.
