# Retrain enrichment for a Coral detector (2026-10-24)

covers:
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/retrain-service.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/retrain-frame-selection.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/retrain-collection-service.ts
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/retrain-service.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/retrain-frame-selection.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/retrain-collection-service.ts
last-verified: 2026-10-24

Candidate frames for a later Coral training run (YOLOv9 ReLU6, full-int8,
320/512), taken from the operator's own tracks on the prod hub `.9`.
Nothing here was trained, uploaded, or marked complete. The generic Coral
models measured the same day stall at realcam recall 0.52–0.65, and the
misses are mostly small subjects (`docs/benchmarks/2026-10-24-coral-plus-catalog-models.md`).

Collection `coral-enrichment-2026-10`
(`f8711894-ffe9-4146-9bf7-996fad57bead`), 972 frames. Corpus KPI after the
run is 973: one prior frame is not a member of this collection.

## Corpus before any write

`pipelineAnalytics.getRetrainCorpusKpi`, read before the first mutation:

| | |
| --- | --- |
| total | 91 |
| unannotated | 0 |
| annotated | 35 |
| complete | 56 |

Class pages (a frame with two classes is counted twice): person 51,
vehicle 10, animal 54, 90 distinct frame ids. Cameras, frames in the KPI:
586:3, 587:5, 104:17, 592:2, 101:9, 102:3, 618:7, 636:2, 637:6, 640:10,
1441:1, 1443:5, 3628:1, 3629:2, 3835:3, 3836:6, 3839:8, 4779:1.
The morning census on the same hub was 89 copies, 88 staged tracks, 143
annotations, animal 73 / person 8 / vehicle 7. The KPI above is the number
this run is differenced against.

## How the frames were chosen

Window: the 30 days the hub still answers for, ending 2026-10-24. The
sample is not a full census. `listRecentTracks` with every camera and a
high limit is the fan-out that materialises `(limit+1)` rows per device
(`RECENT_FANOUT_ROW_BUDGET`); that shape was stopped. The sample that was
kept is one camera per call, `limit` 12, slim rows, ten 3-day windows each
split in half, classes person, vehicle, animal. 1920 calls, 6503 rows,
27 cameras. Busy cameras are flattened by the cap of 12 tracks per half
window, so the sample's night share is not the traffic share. A partial
person scan that was abandoned (it had not reached 30 days) saw night on
14.4% of person tracks over about six days. The quotas below floor night
at 25% on purpose, above that traffic.

Light is the sun at the frame's capture time for the site used by the
corpus (lat 50.8043, lng 6.493). Twilight is ±40 minutes around
sunrise and sunset, and both are counted as dusk. No chroma test was
available on the index row, so an infrared frame at noon stays `day`.

Size is the track envelope (union of the position boxes) divided by the
frame. `small` is under 0.03, `mid` is 0.03–0.12, `large` is 0.12 and
above. An envelope under 0.03 means the subject stayed small for the
whole track. A track that was small at the start and large at the best
shot is not counted small: the only native frame we could keep is the
key frame, which is the best shot.

Deficits against the class-page counts above: person 349, vehicle 290,
animal 146, plus 100 background frames. Camera cap 12% of a 975-frame
set (117). One frame per track. Staged tracks were left alone.

### Recording stills, then key frames

`addRetrainFrameFromRecording` decodes a native still (`RETRAIN_STILL_MAX_WIDTH`
7680). It was tried at the planned instants (first sighting, best shot,
a late frame, at most three, at least 3 seconds apart) and, on a probe,
at the stored key-frame timestamp. Confirmed-track instants came back
`still-unavailable`: no recorded footage covers that instant. Suppressed
births in the last day or two often did have footage. The birth table
(`listBirthDecisions`, 5000 newest rows) only spans about 2026-10-22
09:32Z to 2026-10-24 11:46Z.

The frame that does exist on a confirmed track is the stored `keyFrame`.
`listTrackMedia` then `selectRetrainFrames` with that media id only.
`keyFrameSmall`, scene tiles, and the boxed timeline kinds were not
copied. `sceneFrame` is the clean twin of a tile (about 100–180 KB), not
the capture. Copied widths are 1280, 1920, 2048, 2304, 2560, 3840, 4096
and 4256. The 1280×720 rows are camera 111's capture size; the prior
corpus already has frames at that size from the same camera. Nothing at
960 px was copied.

Background frames are recording stills at a suppressed birth
(`no-detection`, `below-detector-floor`, `scored-below-threshold`,
`suppressed`), one per source track, newest first on the second pass so
they fall inside the footage that is still there. `incompatible-class`
was skipped: a detection existed.

### Proposals, not truth

Every new frame: `proposeRetrainAnnotations` with subject `objects`,
`modelId` `yolov9m-640-int8`, `minScore` 0.25, `nodeId` `hub` (OpenVINO
on that hub). Then `proposeRetrainAnnotationsWithLlm`, profile
`mac-lmstudio-qwen3vl` (local, `allowCloud: false`), classes person,
vehicle, animal. Teacher boxes are kept. An LLM box is added only when
its IoU with every kept box is under 0.5. At most 20 boxes.
`saveRetrainAnnotations` writes that set when it is non-empty. It
replaces the frame's annotations, so it was never called on a frame that
already had some. `setRetrainFrameComplete` was not called. All 881 new
frames have `complete: false`. The 56 complete frames in the KPI are the
same 56 as before.

The 90 distinct prior person/vehicle/animal frames were added to the
collection and not re-annotated. Some of them are already complete.

Hub-main RSS during the copy stayed about 2400–3200 MB and the event-loop
p99 about 7–54 ms (`logs.query`, source `loki-logging`, text
`[mem] hub-main rss=`). The stop lines were 3600 MB and 250 ms, twice in
a row. They were not hit. The run was 12:10–15:49 UTC, outside the
04:20–05:10 Europe/Berlin window. No setting was written, nothing was
deleted, no staged frame was restaged, no training job was started, and
no frame was sent to a cloud profile.

## Corpus after

`getRetrainCorpusKpi` after the run:

| | before | after |
| --- | --- | --- |
| total | 91 | 973 |
| unannotated | 0 | 134 |
| annotated | 35 | 783 |
| complete | 56 | 56 |

New frames (all `complete: false`):

| class | new frames | target for new frames | with the prior class-page count |
| --- | --- | --- | --- |
| person | 347 | 349 | 398 against a floor of 400 |
| vehicle | 290 | 290 | 300 against a floor of 300 |
| animal | 144 | 146 | 198 against a floor of 200 |
| background | 100 | 100 | 100 new; none in the prior class pages |

Of the 347 person frames, 340 are key frames and 7 are recording stills.
Vehicle and animal are key frames only. Backgrounds are recording stills.
Person and animal are two frames short: the remaining tracks had no
`keyFrame` (`no-keyframe` or `source-missing`) and the spare tracks did
not fill the last two.

### Light and size, new frames

Night is the capture-time bucket above.

| class | n | day | dusk | night | night share | small | small share |
| --- | --- | --- | --- | --- | --- | --- | --- |
| person | 347 | 181 | 71 | 95 | 27.4% | 192 | 55.3% |
| vehicle | 290 | 169 | 49 | 72 | 24.8% | 190 | 65.5% |
| animal | 144 | 74 | 31 | 39 | 27.1% | 113 | 78.5% |
| background | 100 | 71 | 5 | 24 | 24.0% | — | — |

The new set is 230/881 night (26.1%).
Person and animal clear 25%. Vehicle is 72/290 (24.8%), short of the
floor by one frame. Backgrounds are 24% night because the births that
still have footage are the newest rows, and those are mostly daytime.
Person small is 192/347 (55.3%) and vehicle small is 190/290 (65.5%),
both above the 30% floor, on the envelope definition above. That makes
the set small-heavy: mid and large subjects are the minority, which is
what the Coral misses need, and it is not a balanced size mix.

### Class × light × size

| class | light | size | frames |
| --- | --- | --- | --- |
| animal | day | large | 1 |
| animal | day | mid | 15 |
| animal | day | small | 58 |
| animal | dusk | large | 1 |
| animal | dusk | mid | 7 |
| animal | dusk | small | 23 |
| animal | night | large | 1 |
| animal | night | mid | 6 |
| animal | night | small | 32 |
| background | day | n/a | 71 |
| background | dusk | n/a | 5 |
| background | night | n/a | 24 |
| person | day | large | 19 |
| person | day | mid | 37 |
| person | day | small | 125 |
| person | dusk | large | 15 |
| person | dusk | mid | 29 |
| person | dusk | small | 27 |
| person | night | large | 14 |
| person | night | mid | 41 |
| person | night | small | 40 |
| vehicle | day | large | 9 |
| vehicle | day | mid | 50 |
| vehicle | day | small | 110 |
| vehicle | dusk | large | 1 |
| vehicle | dusk | mid | 12 |
| vehicle | dusk | small | 36 |
| vehicle | night | large | 21 |
| vehicle | night | mid | 7 |
| vehicle | night | small | 44 |

### Class × camera × light × size

Camera share is of the whole corpus (973), prior frames included. The
largest camera is 101 with 103 frames (10.6%). The cap was 12% (117).

| device | camera | class | light | size | frames |
| --- | --- | --- | --- | --- | --- |
| 103 | Camera porch | animal | day | small | 4 |
| 103 | Camera porch | animal | dusk | small | 1 |
| 103 | Camera porch | animal | night | small | 3 |
| 103 | Camera porch | person | day | mid | 2 |
| 103 | Camera porch | person | day | small | 4 |
| 103 | Camera porch | person | dusk | mid | 2 |
| 103 | Camera porch | person | dusk | small | 1 |
| 103 | Camera porch | person | night | mid | 4 |
| 103 | Camera porch | person | night | small | 3 |
| 103 | Camera porch | vehicle | day | mid | 1 |
| 109 | Camera hallway primo piano | animal | day | mid | 4 |
| 109 | Camera hallway primo piano | animal | dusk | mid | 1 |
| 109 | Camera hallway primo piano | animal | night | mid | 3 |
| 109 | Camera hallway primo piano | background | night | n/a | 1 |
| 109 | Camera hallway primo piano | person | day | mid | 3 |
| 109 | Camera hallway primo piano | person | day | small | 3 |
| 109 | Camera hallway primo piano | person | dusk | mid | 2 |
| 109 | Camera hallway primo piano | person | dusk | small | 3 |
| 109 | Camera hallway primo piano | person | night | mid | 5 |
| 112 | Camera kitchen | animal | day | small | 4 |
| 112 | Camera kitchen | animal | dusk | small | 1 |
| 112 | Camera kitchen | animal | night | small | 3 |
| 112 | Camera kitchen | background | day | n/a | 1 |
| 112 | Camera kitchen | person | day | small | 8 |
| 112 | Camera kitchen | person | dusk | large | 2 |
| 112 | Camera kitchen | person | night | mid | 4 |
| 112 | Camera kitchen | person | night | small | 1 |
| 112 | Camera kitchen | vehicle | night | large | 1 |
| 104 | Camera hall | animal | day | small | 4 |
| 104 | Camera hall | animal | dusk | small | 1 |
| 104 | Camera hall | animal | night | small | 2 |
| 104 | Camera hall | background | day | n/a | 24 |
| 104 | Camera hall | background | dusk | n/a | 4 |
| 104 | Camera hall | person | day | small | 6 |
| 104 | Camera hall | person | dusk | mid | 2 |
| 104 | Camera hall | person | night | mid | 4 |
| 104 | Camera hall | person | night | small | 2 |
| 104 | Camera hall | vehicle | day | mid | 1 |
| 104 | Camera hall | vehicle | day | small | 13 |
| 104 | Camera hall | vehicle | night | small | 1 |
| 107 | Camera camera Carol | animal | day | mid | 2 |
| 107 | Camera camera Carol | animal | day | small | 2 |
| 107 | Camera camera Carol | animal | dusk | small | 2 |
| 107 | Camera camera Carol | animal | night | mid | 1 |
| 107 | Camera camera Carol | animal | night | small | 3 |
| 107 | Camera camera Carol | background | day | n/a | 7 |
| 107 | Camera camera Carol | person | day | small | 6 |
| 107 | Camera camera Carol | person | dusk | mid | 1 |
| 107 | Camera camera Carol | person | dusk | small | 2 |
| 107 | Camera camera Carol | person | night | mid | 3 |
| 107 | Camera camera Carol | person | night | small | 2 |
| 101 | Camera front door | animal | day | small | 4 |
| 101 | Camera front door | animal | dusk | small | 1 |
| 101 | Camera front door | animal | night | small | 3 |
| 101 | Camera front door | background | day | n/a | 10 |
| 101 | Camera front door | background | night | n/a | 12 |
| 101 | Camera front door | person | day | small | 6 |
| 101 | Camera front door | person | dusk | small | 3 |
| 101 | Camera front door | person | night | mid | 1 |
| 101 | Camera front door | person | night | small | 5 |
| 101 | Camera front door | vehicle | day | small | 30 |
| 101 | Camera front door | vehicle | dusk | mid | 1 |
| 101 | Camera front door | vehicle | dusk | small | 12 |
| 101 | Camera front door | vehicle | night | mid | 4 |
| 101 | Camera front door | vehicle | night | small | 2 |
| 102 | Camera parking | animal | day | small | 6 |
| 102 | Camera parking | animal | dusk | small | 2 |
| 102 | Camera parking | animal | night | small | 1 |
| 102 | Camera parking | background | day | n/a | 4 |
| 102 | Camera parking | background | night | n/a | 3 |
| 102 | Camera parking | person | day | small | 6 |
| 102 | Camera parking | person | dusk | small | 3 |
| 102 | Camera parking | person | night | small | 6 |
| 102 | Camera parking | vehicle | day | small | 13 |
| 102 | Camera parking | vehicle | dusk | small | 5 |
| 102 | Camera parking | vehicle | night | mid | 1 |
| 102 | Camera parking | vehicle | night | small | 30 |
| 108 | Camera bedroom | animal | day | mid | 3 |
| 108 | Camera bedroom | animal | day | small | 1 |
| 108 | Camera bedroom | animal | dusk | small | 1 |
| 108 | Camera bedroom | animal | night | mid | 1 |
| 108 | Camera bedroom | animal | night | small | 3 |
| 108 | Camera bedroom | person | day | mid | 3 |
| 108 | Camera bedroom | person | day | small | 2 |
| 108 | Camera bedroom | person | dusk | mid | 2 |
| 108 | Camera bedroom | person | night | small | 7 |
| 636 | Camera garden | animal | day | small | 5 |
| 636 | Camera garden | animal | dusk | small | 3 |
| 636 | Camera garden | person | day | large | 1 |
| 636 | Camera garden | person | day | mid | 5 |
| 636 | Camera garden | person | day | small | 7 |
| 636 | Camera garden | person | dusk | small | 1 |
| 636 | Camera garden | person | night | mid | 1 |
| 637 | Camera cortile | animal | day | small | 4 |
| 637 | Camera cortile | animal | dusk | small | 1 |
| 637 | Camera cortile | animal | night | small | 3 |
| 637 | Camera cortile | person | day | small | 8 |
| 637 | Camera cortile | person | dusk | mid | 1 |
| 637 | Camera cortile | person | dusk | small | 3 |
| 637 | Camera cortile | person | night | mid | 3 |
| 637 | Camera cortile | person | night | small | 1 |
| 637 | Camera cortile | vehicle | day | large | 1 |
| 640 | Baby monitor | person | day | large | 9 |
| 640 | Baby monitor | person | day | mid | 3 |
| 1436 | Camera hallway cantina | person | day | mid | 1 |
| 1436 | Camera hallway cantina | person | day | small | 6 |
| 1436 | Camera hallway cantina | person | dusk | mid | 2 |
| 1436 | Camera hallway cantina | person | night | mid | 3 |
| 1436 | Camera hallway cantina | person | night | small | 3 |
| 1438 | Camera dispensa | person | day | large | 2 |
| 1438 | Camera dispensa | person | day | mid | 3 |
| 1438 | Camera dispensa | person | dusk | large | 3 |
| 1438 | Camera dispensa | person | night | large | 5 |
| 1439 | Camera garage | animal | day | small | 1 |
| 1439 | Camera garage | person | day | small | 11 |
| 1439 | Camera garage | person | dusk | mid | 4 |
| 1439 | Camera garage | person | dusk | small | 1 |
| 1439 | Camera garage | vehicle | day | large | 4 |
| 1439 | Camera garage | vehicle | day | mid | 6 |
| 1439 | Camera garage | vehicle | day | small | 4 |
| 1439 | Camera garage | vehicle | dusk | large | 1 |
| 1439 | Camera garage | vehicle | dusk | mid | 2 |
| 1439 | Camera garage | vehicle | night | large | 1 |
| 1441 | Camera retro casa | animal | night | mid | 1 |
| 1441 | Camera retro casa | background | day | n/a | 2 |
| 1441 | Camera retro casa | background | night | n/a | 7 |
| 1441 | Camera retro casa | person | day | small | 8 |
| 1441 | Camera retro casa | person | dusk | mid | 2 |
| 1441 | Camera retro casa | person | dusk | small | 2 |
| 1441 | Camera retro casa | person | night | large | 1 |
| 1441 | Camera retro casa | person | night | mid | 2 |
| 1441 | Camera retro casa | vehicle | day | large | 2 |
| 1441 | Camera retro casa | vehicle | day | small | 12 |
| 1441 | Camera retro casa | vehicle | night | large | 13 |
| 1441 | Camera retro casa | vehicle | night | mid | 1 |
| 111 | Camera sala da pranzo | animal | day | small | 4 |
| 111 | Camera sala da pranzo | animal | dusk | small | 1 |
| 111 | Camera sala da pranzo | animal | night | small | 3 |
| 111 | Camera sala da pranzo | background | day | n/a | 8 |
| 111 | Camera sala da pranzo | person | day | small | 5 |
| 111 | Camera sala da pranzo | person | dusk | mid | 2 |
| 111 | Camera sala da pranzo | person | dusk | small | 1 |
| 111 | Camera sala da pranzo | person | night | mid | 4 |
| 111 | Camera sala da pranzo | person | night | small | 2 |
| 111 | Camera sala da pranzo | vehicle | night | small | 1 |
| 3628 | Camera laundry | animal | day | mid | 2 |
| 3628 | Camera laundry | animal | day | small | 2 |
| 3628 | Camera laundry | animal | dusk | mid | 2 |
| 3628 | Camera laundry | animal | night | large | 1 |
| 3628 | Camera laundry | person | day | large | 1 |
| 3628 | Camera laundry | person | day | mid | 5 |
| 3628 | Camera laundry | person | dusk | mid | 3 |
| 3628 | Camera laundry | person | dusk | small | 3 |
| 3628 | Camera laundry | person | night | large | 3 |
| 3628 | Camera laundry | person | night | mid | 2 |
| 3629 | Camera porta retro | animal | day | mid | 1 |
| 3629 | Camera porta retro | animal | day | small | 2 |
| 3629 | Camera porta retro | animal | dusk | mid | 1 |
| 3629 | Camera porta retro | animal | dusk | small | 1 |
| 3629 | Camera porta retro | person | day | large | 1 |
| 3629 | Camera porta retro | person | day | mid | 1 |
| 3629 | Camera porta retro | person | dusk | large | 9 |
| 3629 | Camera porta retro | person | dusk | mid | 1 |
| 3629 | Camera porta retro | person | dusk | small | 1 |
| 3629 | Camera porta retro | vehicle | dusk | small | 1 |
| 3825 | Camera stanza caldaia | person | day | large | 2 |
| 3825 | Camera stanza caldaia | person | day | mid | 1 |
| 3829 | Camera esterno garage | animal | day | large | 1 |
| 3829 | Camera esterno garage | animal | day | mid | 1 |
| 3829 | Camera esterno garage | animal | day | small | 1 |
| 3829 | Camera esterno garage | animal | dusk | large | 1 |
| 3829 | Camera esterno garage | animal | dusk | mid | 3 |
| 3829 | Camera esterno garage | animal | dusk | small | 1 |
| 3829 | Camera esterno garage | animal | night | small | 2 |
| 3829 | Camera esterno garage | person | day | small | 9 |
| 3829 | Camera esterno garage | person | dusk | mid | 1 |
| 3829 | Camera esterno garage | person | dusk | small | 1 |
| 3829 | Camera esterno garage | vehicle | day | large | 1 |
| 3829 | Camera esterno garage | vehicle | day | mid | 40 |
| 3829 | Camera esterno garage | vehicle | day | small | 1 |
| 3829 | Camera esterno garage | vehicle | dusk | mid | 6 |
| 3829 | Camera esterno garage | vehicle | night | small | 2 |
| 3830 | Camera garden piccolo | animal | day | mid | 2 |
| 3830 | Camera garden piccolo | animal | dusk | small | 2 |
| 3830 | Camera garden piccolo | person | day | mid | 9 |
| 3830 | Camera garden piccolo | person | day | small | 2 |
| 3830 | Camera garden piccolo | person | night | large | 2 |
| 3831 | Camera mansarda | background | day | n/a | 2 |
| 3831 | Camera mansarda | person | day | large | 1 |
| 3831 | Camera mansarda | person | dusk | large | 1 |
| 3835 | Camera capanno garden | animal | day | small | 6 |
| 3835 | Camera capanno garden | animal | dusk | small | 3 |
| 3835 | Camera capanno garden | background | day | n/a | 8 |
| 3835 | Camera capanno garden | background | dusk | n/a | 1 |
| 3835 | Camera capanno garden | person | day | small | 13 |
| 3835 | Camera capanno garden | person | dusk | small | 1 |
| 3835 | Camera capanno garden | person | night | large | 1 |
| 3835 | Camera capanno garden | vehicle | day | mid | 2 |
| 3835 | Camera capanno garden | vehicle | day | small | 7 |
| 3835 | Camera capanno garden | vehicle | dusk | small | 8 |
| 3835 | Camera capanno garden | vehicle | night | large | 4 |
| 3835 | Camera capanno garden | vehicle | night | small | 2 |
| 3836 | Camera studio | animal | day | small | 4 |
| 3836 | Camera studio | animal | dusk | small | 1 |
| 3836 | Camera studio | animal | night | small | 3 |
| 3836 | Camera studio | background | day | n/a | 1 |
| 3836 | Camera studio | person | day | small | 6 |
| 3836 | Camera studio | person | dusk | mid | 2 |
| 3836 | Camera studio | person | dusk | small | 1 |
| 3836 | Camera studio | person | night | small | 7 |
| 3836 | Camera studio | vehicle | day | large | 1 |
| 3836 | Camera studio | vehicle | night | large | 2 |
| 3838 | Camera stanza utenze | person | day | large | 1 |
| 3839 | Camera hallway piano terra | animal | day | small | 4 |
| 3839 | Camera hallway piano terra | animal | dusk | small | 1 |
| 3839 | Camera hallway piano terra | animal | night | small | 3 |
| 3839 | Camera hallway piano terra | background | day | n/a | 4 |
| 3839 | Camera hallway piano terra | background | night | n/a | 1 |
| 3839 | Camera hallway piano terra | person | day | mid | 1 |
| 3839 | Camera hallway piano terra | person | day | small | 9 |
| 3839 | Camera hallway piano terra | person | dusk | mid | 2 |
| 3839 | Camera hallway piano terra | person | night | mid | 4 |
| 3839 | Camera hallway piano terra | person | night | small | 1 |
| 3839 | Camera hallway piano terra | vehicle | day | small | 30 |
| 3839 | Camera hallway piano terra | vehicle | dusk | mid | 3 |
| 3839 | Camera hallway piano terra | vehicle | dusk | small | 10 |
| 3839 | Camera hallway piano terra | vehicle | night | mid | 1 |
| 3839 | Camera hallway piano terra | vehicle | night | small | 6 |
| 4263 | Campanello | person | day | large | 1 |
| 4263 | Campanello | person | night | large | 2 |
| 4263 | Campanello | person | night | mid | 1 |

Corpus frames per camera after the run (prior + new):

| device | camera | frames | share |
| --- | --- | --- | --- |
| 101 | Camera front door | 103 | 10.6% |
| 3839 | Camera hallway piano terra | 88 | 9.0% |
| 102 | Camera parking | 83 | 8.5% |
| 104 | Camera hall | 81 | 8.3% |
| 3829 | Camera esterno garage | 71 | 7.3% |
| 3835 | Camera capanno garden | 59 | 6.1% |
| 1441 | Camera retro casa | 54 | 5.5% |
| 111 | Camera sala da pranzo | 36 | 3.7% |
| 1439 | Camera garage | 35 | 3.6% |
| 3836 | Camera studio | 34 | 3.5% |
| 107 | Camera camera Carol | 33 | 3.4% |
| 637 | Camera cortile | 31 | 3.2% |
| 112 | Camera kitchen | 30 | 3.1% |
| 108 | Camera bedroom | 30 | 3.1% |
| 109 | Camera hallway primo piano | 28 | 2.9% |
| 103 | Camera porch | 25 | 2.6% |
| 636 | Camera garden | 25 | 2.6% |
| 3628 | Camera laundry | 25 | 2.6% |
| 640 | Baby monitor | 22 | 2.3% |
| 3629 | Camera porta retro | 22 | 2.3% |
| 3830 | Camera garden piccolo | 17 | 1.7% |
| 1436 | Camera hallway cantina | 15 | 1.5% |
| 1438 | Camera dispensa | 13 | 1.3% |
| 3831 | Camera mansarda | 4 | 0.4% |
| 4263 | Campanello | 4 | 0.4% |
| 3825 | Camera stanza caldaia | 3 | 0.3% |
| 3838 | Camera stanza utenze | 1 | 0.1% |
| 4779 |  | 1 | 0.1% |

## Teacher and LLM

Both answered on 856 of 881 frames. The other 25 are 23 LLM timeouts
and 2 `unknown-profile` (early in the run). The teacher answered on all
881 (`yolov9m-640-int8`). The profile stayed on: failures were not four
in a row.

On those 856 frames the teacher proposed 1294 boxes and 982 of
them agree with the LLM (75.9%). Agreement is the same
macro class at IoU ≥ 0.5, or an LLM review of that box's `assist:N` ref
with verdict `confirmed` and no different class. 131 frames are empty
on both sides. Of the frames with at least one teacher box, 463 agree on every teacher box and 261 agree only in part.
Empty-on-both is not folded into the 75.9% box rate.

133 new frames were saved with no boxes (the teacher proposed nothing
the macro list keeps). They stay unannotated. The KPI's 134 unannotated
frames are those plus one that was already outside this count. An
unannotated frame is not trainable until the operator marks it complete
with every subject boxed, or complete with zero subjects.

Of the 100 background frames, 32 are empty on the teacher (and
those 32 are empty on the LLM too). The other 68 have one or more
teacher boxes: a suppressed birth is not yet a hard negative. The
operator decides. Birth reasons on the 100:

| reason | frames |
| --- | --- |
| no-detection | 66 |
| below-detector-floor | 34 |

## Gaps

- Person is 2 frames under the 400 floor (398 with the prior class-page
  count). Animal is 2 under the 200 floor (198). Vehicle meets 300.
  The missing four are tracks whose `keyFrame` was gone
  (`no-keyframe`, `source-missing`) after the spare tracks had been used.
- One native frame per track, not two or three spread over its life.
  `addRetrainFrameFromRecording` refused the first, best, and late
  instants, and a probe at the key-frame timestamp, with
  `no recorded footage covers that instant`. What fills that is footage
  that actually contains the detection: continuous recording, or event
  segments that cover the track. A second stored native kind does not
  exist; `sceneFrame` is the tile twin.
- Vehicle night is 24.8%, 0.2 percentage points under the 25% floor. The sample's
  own vehicle night share was 18%, and the quota had asked for 25%.
  Re-bucketing the key-frame instant (instead of the track's sample
  label) moved it to 24.8%. More night vehicle tracks, with a `keyFrame`
  still on disk, would fill it.
- The 30% small-subject floor is met, but only for tracks that stayed
  small. A small box inside a track that later grew could not be copied,
  because that instant is not in the recording. The traffic that fills
  it is a recording segment at the small instant, or a `keyFrame` taken
  while the subject is still small.
- Backgrounds exist only where a birth in the last ~2.5 days still has
  footage, and 68 of the 100 are not empty under the teacher. Older
  suppressed births returned `still-unavailable`. A longer birth table
  does not help without the recording. IR-versus-day is not separated;
  a daylight infrared scene is counted as day.
- Cameras with no track in the 30-day sample contributed nothing:
  3216, 3219, 3833 (sala feste), 4581, 4878. 4779 is in the prior corpus
  (1 frame) and has no recording capability, so no new still was added.
  4263 (Campanello) and the other named cameras that had a sample row
  and a `keyFrame` are in the tables above.
- The set is small-heavy and night-heavier than raw person traffic
  (14.4% night on the abandoned six-day person scan). That is the
  quota, not the traffic.

## What the operator reviews

Training → Frames, collection `coral-enrichment-2026-10`.

1. Filter to that collection. New frames are not complete. Boxes on them
   are proposals (`source` assist or llm), not verified labels.
2. Prior frames in the same collection may already be complete. Leave
   those unless a box is wrong. They were not re-proposed by this run.
3. For each new frame: accept a box, move it, change its class, or
   delete it. A deleted proposal stays dismissed so it does not come
   back on the next open.
4. Mark the frame complete only when every real subject is boxed.
   A background frame becomes a hard negative only when it is complete
   and has zero subject boxes (an empty YOLO label). Do that for the
   32 empty births if they are truly empty, and for any of the other
   68 whose teacher boxes are false. If a teacher box is a real
   subject, keep it and the frame is a positive, not a hard negative.
5. Keys on that page: 1–6 class, A accept, C complete, Ctrl+S save.
6. Do not start a training job from this collection until that review
   is done. A job's default work state is `complete`, so these new
   frames are excluded until they are marked. `annotated_or_complete`
   would train the proposals as if they were labels.

## Appendix — one row per new frame

Prior frames are not listed. `light` is the capture-time bucket. `size`
is the track envelope (`n/a` on a birth, which has no subject box).
`source` is `keyFrame` or `recording`.

```
frameId	trackId	deviceId	class	light	size	source	width	height	teacherBoxes	llmBoxes	agreed	saved
retrain:d1w655cpm0:b9201e60d8d9c24c	d1w655cpm0	103	animal	day	small	keyFrame	3840	2160	2	2	1	3
retrain:ksd3rjakf9:219f412cc2219cd8	ksd3rjakf9	103	animal	day	small	keyFrame	3840	2160	3	3	3	3
retrain:yhrwm6gcjw:0da733ae53876bab	yhrwm6gcjw	103	animal	dusk	small	keyFrame	3840	2160	3	3	3	3
retrain:1gx1a5rtd6:d942b8d8d3bb4b1e	1gx1a5rtd6	103	animal	day	small	keyFrame	3840	2160	1	2	1	2
retrain:e5z5zsvtv1:76eabdab1766d4bd	e5z5zsvtv1	103	animal	day	small	keyFrame	3840	2160	1	1	1	1
retrain:rc8rpkc7e9:52636cb09011cf62	rc8rpkc7e9	103	animal	night	small	keyFrame	3840	2160	3	2	1	4
retrain:wm4hmj5xqy:2a9a37757c29eb47	wm4hmj5xqy	103	animal	night	small	keyFrame	3840	2160	2	3	1	4
retrain:wc97tjb3ve:28d1b25a766e5f8d	wc97tjb3ve	103	animal	night	small	keyFrame	3840	2160	2	0	0	2
retrain:fx4s0bvrrp:ee0c1905e03eb30c	fx4s0bvrrp	586	animal	day	mid	keyFrame	3840	2160	1	1	0	1
retrain:t7rmtgrr34:abf4faf94fa0adaf	t7rmtgrr34	586	animal	dusk	mid	keyFrame	3840	2160	1	1	1	1
retrain:5r9fcpxsv5:e70587e1aee7b6f6	5r9fcpxsv5	586	animal	day	mid	keyFrame	3840	2160	1	0	0	1
retrain:553h2nbps8:83181e609d724e94	553h2nbps8	586	animal	night	mid	keyFrame	3840	2160	0	1	0	1
retrain:4rw0a182h5:fcb822d8d41a3a48	4rw0a182h5	586	animal	night	mid	keyFrame	3840	2160	1	1	0	2
retrain:cdj3s2prvv:6f5acf226381b48c	cdj3s2prvv	586	animal	day	mid	keyFrame	3840	2160	1	1	0	1
retrain:vdb0db8ncg:7a6846dc095974a6	vdb0db8ncg	586	animal	day	mid	keyFrame	3840	2160	1	0	0	1
retrain:7ev0bcy5y4:4bd1f6487966de3c	7ev0bcy5y4	586	animal	night	mid	keyFrame	3840	2160	1	2	0	3
retrain:wy7p90brp2:6080a014040d87b5	wy7p90brp2	587	animal	day	small	keyFrame	3840	2160	3	3	3	3
retrain:sb7x5znd10:027f826e797dc8d4	sb7x5znd10	587	animal	day	small	keyFrame	3840	2160	2	2	1	3
retrain:dhb7jpgn7f:71d4504502556d1a	dhb7jpgn7f	587	animal	day	small	keyFrame	3840	2160	2	5	2	5
retrain:s8g9q7axr2:4eca5343240924c3	s8g9q7axr2	587	animal	day	small	keyFrame	3840	2160	1	6	1	4
retrain:587w1et06g:8ca9ec09d2675e48	587w1et06g	587	animal	night	small	keyFrame	3840	2160	2	3	1	5
retrain:y6rg1zgahm:32dd61a63eb9186a	y6rg1zgahm	587	animal	night	small	keyFrame	3840	2160	0	0	0	0
retrain:x07480387d:c6422d55b395218b	x07480387d	587	animal	night	small	keyFrame	3840	2160	1	2	0	3
retrain:eym0w5y064:b70aea31b2d61125	eym0w5y064	587	animal	dusk	small	keyFrame	3840	2160	2	2	2	2
retrain:rhx6gw2akz:de69752f41533a79	rhx6gw2akz	104	animal	day	small	keyFrame	3840	2160	3	4	3	4
retrain:p4kqseepdc:1d9c848f6f49137f	p4kqseepdc	104	animal	dusk	small	keyFrame	3840	2160	1	1	1	1
retrain:rhh0n9ct66:6ab274e6287d118d	rhh0n9ct66	104	animal	night	small	keyFrame	3840	2160	1	1	1	1
retrain:qtay8yhh6k:30e8cf4ce14d6dd3	qtay8yhh6k	104	animal	night	small	keyFrame	3840	2160	1	1	1	1
retrain:j0h4va39th:ef2b56323db8411a	j0h4va39th	104	animal	day	small	keyFrame	3840	2160	1	2	1	2
retrain:f3nn0236vy:a34bc3a42213e766	f3nn0236vy	104	animal	day	small	keyFrame	3840	2160	1	2	1	2
retrain:fecthtaaq8:cef2f82f0b7acc64	fecthtaaq8	104	animal	day	small	keyFrame	3840	2160	0	0	0	0
retrain:m6jfztenwh:6b6bf7526d297d24	m6jfztenwh	592	animal	night	small	keyFrame	3840	2160	0	0	0	0
retrain:3k0vvgpg3p:19dc75580e051691	3k0vvgpg3p	592	animal	night	small	keyFrame	3840	2160	1	0	0	1
retrain:dtamtjhxv5:106ef917b17536b7	dtamtjhxv5	592	animal	day	mid	keyFrame	3840	2160	1	1	0	2
retrain:02v8nb21es:5ded7ee68620c5ed	02v8nb21es	592	animal	dusk	small	keyFrame	3840	2160	0	0	0	0
retrain:2p55pn0gmf:69be125ae34a4ae7	2p55pn0gmf	592	animal	night	small	keyFrame	3840	2160	1	3	1	3
retrain:ne9wtzn6k4:306fe12447b62407	ne9wtzn6k4	592	animal	night	mid	keyFrame	3840	2160	0	0	0	0
retrain:hb9sefdpbt:8ee2bb25005aebf5	hb9sefdpbt	592	animal	day	small	keyFrame	3840	2160	0	0	0	0
retrain:c7rt1tg2sm:7fc93059efa8ef0b	c7rt1tg2sm	592	animal	day	small	keyFrame	3840	2160	1	0	0	1
retrain:zx33swcpxx:6993475fd9e41ffe	zx33swcpxx	592	animal	dusk	small	keyFrame	3840	2160	1	0	0	1
retrain:m3p2sbqq22:e9b60bb13371fa64	m3p2sbqq22	592	animal	day	mid	keyFrame	3840	2160	1	0	0	1
retrain:jjtsrhfay6:a075b16086024242	jjtsrhfay6	101	animal	day	small	keyFrame	3840	2160	1	2	0	3
retrain:zdabg91a3m:29d0db7971d91bfb	zdabg91a3m	101	animal	day	small	keyFrame	3840	2160	1	2	1	3
retrain:ypk8hpgwgy:744d340a1777c0ee	ypk8hpgwgy	101	animal	day	small	keyFrame	3840	2160	1	0	0	1
retrain:nvea9scf88:4472c039afe4ba07	nvea9scf88	101	animal	day	small	keyFrame	3840	2160	1	2	1	2
retrain:ezy6nka21p:3ca1c71e142aae92	ezy6nka21p	101	animal	dusk	small	keyFrame	3840	2160	2	2	2	2
retrain:wsnhtdhj18:e3eab7bacab8bf4c	wsnhtdhj18	101	animal	night	small	keyFrame	3840	2160	1	0	0	1
retrain:0nf5ybh54n:06076d47a37ea30a	0nf5ybh54n	101	animal	night	small	keyFrame	3840	2160	0	0	0	0
retrain:8d0d3m76gn:bfc84ef4b39b569d	8d0d3m76gn	101	animal	night	small	keyFrame	3840	2160	2	2	2	3
retrain:wphwe1ykxb:30cc9398dc6267cc	wphwe1ykxb	102	animal	day	small	keyFrame	3840	2160	4	5	3	6
retrain:tgwrse4f7e:b9b4b9f8aa21973a	tgwrse4f7e	102	animal	day	small	keyFrame	3840	2160	4	6	4	6
retrain:t2tcdeeccb:c32014abaa7154a1	t2tcdeeccb	102	animal	day	small	keyFrame	3840	2160	2	2	2	2
retrain:wjdhhx4046:0f16277b1752e760	wjdhhx4046	102	animal	day	small	keyFrame	3840	2160	5	8	5	7
retrain:y4jn5szxwt:d48d2bd180a682ab	y4jn5szxwt	102	animal	day	small	keyFrame	3840	2160	4	5	4	5
retrain:wnbkv5k5zg:87e53cdcf41fbada	wnbkv5k5zg	102	animal	dusk	small	keyFrame	3840	2160	6	6	5	7
retrain:8rfdy4nabw:55eb2a3cc966611c	8rfdy4nabw	102	animal	day	small	keyFrame	3840	2160	1	3	1	3
retrain:z45swhth3z:d3358510cae89f16	z45swhth3z	102	animal	dusk	small	keyFrame	3840	2160	3	4	3	4
retrain:896k435yw5:90ae802b5b41fbd0	896k435yw5	102	animal	night	small	keyFrame	3840	2160	3	6	3	5
retrain:k8zw3nsf1v:b66bab6d3a867667	k8zw3nsf1v	618	animal	night	small	keyFrame	3840	2160	1	2	1	3
retrain:pe5nravw7q:0296f37b22aca565	pe5nravw7q	618	animal	day	mid	keyFrame	3840	2160	2	2	2	2
retrain:aff4tdz1ax:24e638bef281216f	aff4tdz1ax	618	animal	day	small	keyFrame	3840	2160	0	0	0	0
retrain:sya05cjygd:64dc1eb0f155d27d	sya05cjygd	618	animal	day	mid	keyFrame	3840	2160	0	0	0	0
retrain:d99f1bmvps:f78010db71d596ac	d99f1bmvps	618	animal	night	small	keyFrame	3840	2160	1	1	0	2
retrain:53f56wq6qn:8882ed40d8a500c0	53f56wq6qn	618	animal	night	small	keyFrame	3840	2160	0	0	0	0
retrain:6eb2dsaswb:ac0ea92d82862e79	6eb2dsaswb	618	animal	dusk	small	keyFrame	3840	2160	0	0	0	0
retrain:51m1g6rmxm:37e0190f7fb19f03	51m1g6rmxm	618	animal	day	mid	keyFrame	3840	2160	1	2	0	3
retrain:g76hfd5nrf:29c6227e60f50516	g76hfd5nrf	618	animal	night	mid	keyFrame	3840	2160	0	0	0	0
retrain:0gmaattyx6:9ac2af0334eac05c	0gmaattyx6	636	animal	dusk	small	keyFrame	3840	2160	0	0	0	0
retrain:wh3yjvh29q:ecd6515894e701d3	wh3yjvh29q	636	animal	dusk	small	keyFrame	3840	2160	0	0	0	0
retrain:3yh5gbtsty:584f55bef89565a4	3yh5gbtsty	636	animal	dusk	small	keyFrame	3840	2160	1	1	1	1
retrain:4drmk58vy1:7cf656057ff1a199	4drmk58vy1	636	animal	day	small	keyFrame	3840	2160	0	0	0	0
retrain:yvdcp4smq8:b1181984bb1f65e8	yvdcp4smq8	636	animal	day	small	keyFrame	3840	2160	0	0	0	0
retrain:f9ymf6p77c:021dfe570fa3346d	f9ymf6p77c	636	animal	day	small	keyFrame	3840	2160	1	1	0	2
retrain:bkpq6z721q:7e77180663d76380	bkpq6z721q	636	animal	day	small	keyFrame	3840	2160	1	2	1	2
retrain:01akb7z5by:d33857f359607534	01akb7z5by	636	animal	day	small	keyFrame	3840	2160	0	0	0	0
retrain:f3zwnwq7fd:2e498976c05eea95	f3zwnwq7fd	637	animal	day	small	keyFrame	3840	2160	1	2	1	2
retrain:0aebc5sqk4:377af0a4c0c2ab3f	0aebc5sqk4	637	animal	night	small	keyFrame	3840	2160	0	0	0	0
retrain:0rnqx4s0k8:2f5a4309f6e07c25	0rnqx4s0k8	637	animal	dusk	small	keyFrame	3840	2160	1	2	1	2
retrain:xzzg3t7qk0:b27eff1f44fc2563	xzzg3t7qk0	637	animal	day	small	keyFrame	3840	2160	1	2	1	2
retrain:4ymx06b74t:fc6084f88ec93c93	4ymx06b74t	637	animal	night	small	keyFrame	3840	2160	1	1	1	1
retrain:66mshfahf9:05e9d982d9156c4f	66mshfahf9	637	animal	day	small	keyFrame	3840	2160	1	1	1	1
retrain:zr9j1ythfe:4c0cc45a5d0a301e	zr9j1ythfe	637	animal	day	small	keyFrame	3840	2160	1	1	1	1
retrain:ptdfmqe0jx:0f81193ce9b770f2	ptdfmqe0jx	637	animal	night	small	keyFrame	3840	2160	0	0	0	0
retrain:4wmgfc2z3x:9dc953cf7af7a627	4wmgfc2z3x	1439	animal	day	small	keyFrame	3840	2160	3	3	3	3
retrain:a9d74jqve7:cd0f44a82b143cbb	a9d74jqve7	1441	animal	night	mid	keyFrame	4096	1817	0	0	0	0
retrain:9h559cztj9:cbb18d809f116600	9h559cztj9	1443	animal	night	small	keyFrame	3840	2160	2	2	1	3
retrain:kg884jsnra:3f00b1403560348b	kg884jsnra	1443	animal	night	small	keyFrame	3840	2160	1	1	1	1
retrain:jf0cnwfrfy:8e71f636da7f41fa	jf0cnwfrfy	1443	animal	day	small	keyFrame	1280	720	1	2	1	2
retrain:frmrw7eyx9:e809cd68f400f395	frmrw7eyx9	1443	animal	day	small	keyFrame	1280	720	0	0	0	0
retrain:pgbmsxjhzz:208a14c6983c1dbb	pgbmsxjhzz	1443	animal	day	small	keyFrame	1280	720	1	1	1	1
retrain:3x9j404gz1:a848a625a90bff47	3x9j404gz1	1443	animal	dusk	small	keyFrame	1280	720	1	2	1	2
retrain:3p8rbtvkex:5209168e97d29bea	3p8rbtvkex	1443	animal	day	small	keyFrame	1280	720	2	2	2	2
retrain:fk3d7ymn50:09bbf17e65195c2b	fk3d7ymn50	1443	animal	night	small	keyFrame	1280	720	0	0	0	0
retrain:5b4pw7c9da:6fc0d393630ef9c5	5b4pw7c9da	3628	animal	day	small	keyFrame	2304	1296	1	0	1	1
retrain:00dztkp53t:e8cbfe03f79b187c	00dztkp53t	3628	animal	day	mid	keyFrame	2304	1296	2	2	2	2
retrain:d1j2zsecb5:7edcbb92ee7db58b	d1j2zsecb5	3628	animal	day	small	keyFrame	2304	1296	2	0	0	2
retrain:mjd4k1gnw8:778d261340995062	mjd4k1gnw8	3628	animal	dusk	mid	keyFrame	2304	1296	1	0	0	1
retrain:7aachn6a3a:e11c5ab91d447f93	7aachn6a3a	3628	animal	dusk	mid	keyFrame	2304	1296	1	0	0	1
retrain:ay1gccvj2r:722b562fba2e1300	ay1gccvj2r	3628	animal	day	mid	keyFrame	2304	1296	1	0	0	1
retrain:j037p57w0c:e67204734432db36	j037p57w0c	3628	animal	night	large	keyFrame	2304	1296	0	0	0	0
retrain:n7j2mtd5hw:bbdbd7954f1e9102	n7j2mtd5hw	3629	animal	dusk	small	keyFrame	3840	2160	0	0	0	0
retrain:rt64ptw4d6:afc116cc11b25a54	rt64ptw4d6	3629	animal	dusk	mid	keyFrame	3840	2160	0	0	0	0
retrain:39gdn852gd:aee92dc25eeabb7c	39gdn852gd	3629	animal	day	small	keyFrame	3840	2160	1	1	1	1
retrain:12rs6hrw5d:e569f1a1ef465092	12rs6hrw5d	3629	animal	day	mid	keyFrame	3840	2160	1	1	1	1
retrain:1b0jfjzrh0:0ee5abd7e69718b7	1b0jfjzrh0	3629	animal	day	small	keyFrame	3840	2160	1	1	1	1
retrain:53geq5x7nf:6705d0823f32b5f6	53geq5x7nf	3829	animal	day	large	keyFrame	3840	2160	3	3	3	3
retrain:2c9q1efh7v:8c89c5ab7db5082f	2c9q1efh7v	3829	animal	dusk	mid	keyFrame	3840	2160	3	3	1	4
retrain:y6gxwwpqq0:a734addfbae2cc6d	y6gxwwpqq0	3829	animal	dusk	mid	keyFrame	3840	2160	3	3	2	4
retrain:atnrv6h8nk:51216a3da539ef5a	atnrv6h8nk	3829	animal	dusk	large	keyFrame	3840	2160	0	0	0	0
retrain:8c7b5n2rjh:fa99b44c2b3157cc	8c7b5n2rjh	3829	animal	dusk	small	keyFrame	3840	2160	2	3	2	4
retrain:ywrra39dh7:719227e358ae0fc5	ywrra39dh7	3829	animal	dusk	mid	keyFrame	3840	2160	4	4	4	4
retrain:szq47a3kbe:921d5885eafd4cde	szq47a3kbe	3829	animal	day	mid	keyFrame	3840	2160	3	3	2	4
retrain:jvy9grkf45:31a335931d13add2	jvy9grkf45	3829	animal	night	small	keyFrame	3840	2160	3	4	3	5
retrain:2mm6xx64vh:b00b9b26c0a1991f	2mm6xx64vh	3829	animal	night	small	keyFrame	3840	2160	2	0	0	2
retrain:fzgej7ayj0:8c4b09c61f40b3d9	fzgej7ayj0	3829	animal	day	small	keyFrame	3840	2160	4	4	4	4
retrain:bbr6pd9z90:9fb2d787f2c1f3c6	bbr6pd9z90	3830	animal	dusk	small	keyFrame	3840	2160	1	3	1	3
retrain:kypdngkcnd:da6d6d4dfcbb62a5	kypdngkcnd	3830	animal	dusk	small	keyFrame	3840	2160	0	0	0	0
retrain:vcexq8fxbn:5fffd682fa97e65f	vcexq8fxbn	3830	animal	day	mid	keyFrame	3840	2160	1	1	1	1
retrain:mpv7gexnp0:8d2d22cadc182956	mpv7gexnp0	3830	animal	day	mid	keyFrame	3840	2160	1	1	1	1
retrain:3axn03115p:256972b07d97ee48	3axn03115p	3835	animal	day	small	keyFrame	3840	2160	1	2	1	2
retrain:3c2w7hgee2:114810acbaee4776	3c2w7hgee2	3835	animal	day	small	keyFrame	3840	2160	0	0	0	0
retrain:z3sy4h7scn:298512c574fe3df8	z3sy4h7scn	3835	animal	day	small	keyFrame	3840	2160	1	2	1	2
retrain:42v2q5wpc6:34fa5908568f41dd	42v2q5wpc6	3835	animal	day	small	keyFrame	3840	2160	1	2	1	3
retrain:rgknsmbqaq:d8a9ab192adee766	rgknsmbqaq	3835	animal	day	small	keyFrame	3840	2160	0	0	0	0
retrain:j2ahewynab:79e860fbc5b17847	j2ahewynab	3835	animal	dusk	small	keyFrame	3840	2160	0	0	0	0
retrain:bt5w1c8v1g:02e53c9c64b9b529	bt5w1c8v1g	3835	animal	dusk	small	keyFrame	3840	2160	1	2	1	2
retrain:fr87wp4j93:233362960b600806	fr87wp4j93	3835	animal	day	small	keyFrame	3840	2160	0	0	0	0
retrain:9nv2wrhqp4:611642d55ca9e52c	9nv2wrhqp4	3835	animal	dusk	small	keyFrame	3840	2160	2	2	1	3
retrain:chx6d992f9:49693441b38fb984	chx6d992f9	3836	animal	night	small	keyFrame	2560	1440	2	2	2	2
retrain:6z3dzz906n:dd0b90a9ea12c5ff	6z3dzz906n	3836	animal	day	small	keyFrame	2560	1440	2	2	2	2
retrain:0w0xsh29rq:168ecb14fc6dd170	0w0xsh29rq	3836	animal	night	small	keyFrame	2560	1440	2	2	2	2
retrain:d3hnmmhc5x:fcab227e18f50b3b	d3hnmmhc5x	3836	animal	day	small	keyFrame	2560	1440	3	3	3	3
retrain:qhgrnz1jzx:9fee53911d633676	qhgrnz1jzx	3836	animal	day	small	keyFrame	2560	1440	2	2	2	2
retrain:r14v955d0v:231cef4e22450166	r14v955d0v	3836	animal	dusk	small	keyFrame	2560	1440	2	2	2	2
retrain:j2dvdw3prm:7cc3a543a45c0434	j2dvdw3prm	3836	animal	night	small	keyFrame	2560	1440	0	0	0	0
retrain:w8c7fsehjr:b18e2b659a97fa74	w8c7fsehjr	3836	animal	day	small	keyFrame	2560	1440	1	1	1	1
retrain:0t3xwyp0tr:615659612d0340af	0t3xwyp0tr	3839	animal	night	small	keyFrame	3840	2160	1	1	1	1
retrain:8qcwtgvh1y:08bee2676266b3dc	8qcwtgvh1y	3839	animal	day	small	keyFrame	3840	2160	0	0	0	0
retrain:zpr1j42mqb:2c898eef6c0df6b5	zpr1j42mqb	3839	animal	day	small	keyFrame	3840	2160	2	3	2	3
retrain:g5p9cx0vqv:b387a2eb0c2227a6	g5p9cx0vqv	3839	animal	day	small	keyFrame	3840	2160	2	0	0	2
retrain:2wvskgnr75:56a6f3e880a892b6	2wvskgnr75	3839	animal	dusk	small	keyFrame	3840	2160	2	1	1	3
retrain:hr78d5yvst:4cabd98238b64fb9	hr78d5yvst	3839	animal	day	small	keyFrame	3840	2160	1	2	1	1
retrain:0en0f6wrwe:e6ac667a15d48d14	0en0f6wrwe	3839	animal	night	small	keyFrame	3840	2160	0	0	0	0
retrain:he0smr55dz:44f72bc48b9cd6eb	he0smr55dz	3839	animal	night	small	keyFrame	3840	2160	0	0	0	0
retrain:rec:586:c7b1a867698cb2ce	rb6whtkv8r	586	background	night	n/a	recording	3840	2160	1	0	1	1
retrain:rec:587:eaeb67a29c81bc6a	ndsygs0tdz	587	background	day	n/a	recording	3840	2160	0	0	0	0
retrain:rec:104:c60bf9afc636818c	tn0g3p4vk7	104	background	dusk	n/a	recording	3840	2160	1	3	0	4
retrain:rec:104:1c9fe241fd7ca545	2j9gx1ckhj	104	background	dusk	n/a	recording	3840	2160	1	1	0	2
retrain:rec:104:16622cfc3ef56184	w6rvkcjwy6	104	background	dusk	n/a	recording	3840	2160	1	1	1	1
retrain:rec:104:3e0e8b840d68a926	r2xvzv3rnz	104	background	dusk	n/a	recording	3840	2160	3	3	3	3
retrain:rec:104:4ae74258ff13d80e	c8eya0dfx8	104	background	day	n/a	recording	3840	2160	2	2	2	2
retrain:rec:104:eaca486c72e1c320	dhgtfvfbqt	104	background	day	n/a	recording	3840	2160	4	4	4	4
retrain:rec:104:ff2e7b8ece141ceb	g0d3gzmn9c	104	background	day	n/a	recording	3840	2160	3	3	3	3
retrain:rec:104:a2468cf0d7f5e5d8	xfsf1raemk	104	background	day	n/a	recording	3840	2160	2	0	0	2
retrain:rec:104:d59fb57a5ee3601e	72mc110xdd	104	background	day	n/a	recording	3840	2160	3	4	3	4
retrain:rec:104:97d9d526626fa5cd	8b79bahe3j	104	background	day	n/a	recording	3840	2160	2	0	0	2
retrain:rec:104:a7a435c6365eabfb	cxwfgqe63z	104	background	day	n/a	recording	3840	2160	2	3	2	3
retrain:rec:104:3d8e22cbaba64963	4j8e41tjdz	104	background	day	n/a	recording	3840	2160	2	4	2	3
retrain:rec:104:fe6e58b08b0cf9e0	nh4vfnjpw8	104	background	day	n/a	recording	3840	2160	2	4	2	4
retrain:rec:104:f006b30a8c3170b5	959xhk6ppc	104	background	day	n/a	recording	3840	2160	5	5	5	5
retrain:rec:104:d4ce5e1481a4fb8e	dygdgq16nn	104	background	day	n/a	recording	3840	2160	1	2	1	2
retrain:rec:104:9479b63bf0dfeac8	ejycmeg9e2	104	background	day	n/a	recording	3840	2160	1	3	0	4
retrain:rec:104:51a08bf81bc060e2	bg9pae4tvg	104	background	day	n/a	recording	3840	2160	2	4	1	5
retrain:rec:104:a1d9a11d3cabe696	d48dqdeteh	104	background	day	n/a	recording	3840	2160	1	3	1	3
retrain:rec:104:d83d80366f17d61f	epa7pvc9af	104	background	day	n/a	recording	3840	2160	2	2	1	4
retrain:rec:104:09746dab862d39e7	8eseppj966	104	background	day	n/a	recording	3840	2160	2	3	2	3
retrain:rec:104:7572d5fa16093e0b	qhp47v06m5	104	background	day	n/a	recording	3840	2160	1	2	0	3
retrain:rec:104:2579b09e04aa1e16	akm2g6k6mz	104	background	day	n/a	recording	3840	2160	1	1	0	2
retrain:rec:104:81bdbc5fd29e057a	sgd0yx7q8r	104	background	day	n/a	recording	3840	2160	0	0	0	0
retrain:rec:104:5ef1a68a0b10bad7	jf7ptv7kq5	104	background	day	n/a	recording	3840	2160	1	4	1	4
retrain:rec:104:24020e81ffe97d00	g6sk5sfqts	104	background	day	n/a	recording	3840	2160	0	0	0	0
retrain:rec:104:e694c9c9afb35c13	c5dqabdxmx	104	background	day	n/a	recording	3840	2160	1	2	1	2
retrain:rec:104:524c80ad6cfc4c24	ap4ry12yyk	104	background	day	n/a	recording	3840	2160	1	2	0	3
retrain:rec:104:4ffb8c3f2c9bac5a	9kh7gadnwj	104	background	day	n/a	recording	3840	2160	1	3	1	2
retrain:rec:592:8c300a20c8731441	9c7qjj388a	592	background	day	n/a	recording	3840	2160	1	1	0	2
retrain:rec:592:f90d40db2517f740	t8sqf1zftw	592	background	day	n/a	recording	3840	2160	2	2	2	2
retrain:rec:592:1609e3f4b2534fcd	rag4q8z0t7	592	background	day	n/a	recording	3840	2160	1	3	0	4
retrain:rec:592:fb58ee9694d61f28	g76rqrpqam	592	background	day	n/a	recording	3840	2160	1	2	0	3
retrain:rec:592:635f2e7faa325cac	pczawd26m2	592	background	day	n/a	recording	3840	2160	0	0	0	0
retrain:rec:592:28b2ddc5e0cbe2e2	se5pcvznnb	592	background	day	n/a	recording	3840	2160	0	0	0	0
retrain:rec:592:519435d3f2a522b7	9hsbd4tppy	592	background	day	n/a	recording	3840	2160	1	3	0	3
retrain:rec:101:b00a0f37d621d042	79xrd652vg	101	background	night	n/a	recording	3840	2160	0	0	0	0
retrain:rec:101:4c2631ec576798dd	87a37zgbhe	101	background	night	n/a	recording	3840	2160	0	0	0	0
retrain:rec:101:cd023a41ff6e07e4	kq76m8xhnf	101	background	night	n/a	recording	3840	2160	0	0	0	0
retrain:rec:101:13a5ec594e05bdf4	arr2mexh87	101	background	night	n/a	recording	3840	2160	0	0	0	0
retrain:rec:101:8c0ff15244be02cd	v9r7zvnhap	101	background	night	n/a	recording	3840	2160	1	0	0	1
retrain:rec:101:f8628ebf242be63d	50ynd3fvwp	101	background	night	n/a	recording	3840	2160	0	0	0	0
retrain:rec:101:46a12950267bee56	3bdeda7j8r	101	background	night	n/a	recording	3840	2160	1	0	0	1
retrain:rec:101:345b3d20fb34011f	yerqzc7cer	101	background	night	n/a	recording	3840	2160	1	0	0	1
retrain:rec:101:50d209b25bdb9ac8	q82639rv0f	101	background	night	n/a	recording	3840	2160	0	0	0	0
retrain:rec:101:48f9884fbd2584bf	k8e1ggjp0g	101	background	night	n/a	recording	3840	2160	0	0	0	0
retrain:rec:101:4a0e27378271762e	008zza4yrk	101	background	night	n/a	recording	3840	2160	0	0	0	0
retrain:rec:101:f27204339a9423d8	49c9g74qjq	101	background	night	n/a	recording	3840	2160	1	0	0	1
retrain:rec:101:b4916ea6d967b084	rf886x4hzc	101	background	day	n/a	recording	3840	2160	0	0	0	0
retrain:rec:101:fbf0d33a41ed8173	2eknw79ey3	101	background	day	n/a	recording	3840	2160	1	0	0	1
retrain:rec:101:4d2c4be516aa7596	2d0zbzea2z	101	background	day	n/a	recording	3840	2160	1	0	0	1
retrain:rec:101:b4363a4d4d44fb26	mc92kg7rcb	101	background	day	n/a	recording	3840	2160	1	0	0	1
retrain:rec:101:b645a8d9baa63496	njm67b7v2d	101	background	day	n/a	recording	3840	2160	0	0	0	0
retrain:rec:101:0436adefe493d145	qkk9sn0075	101	background	day	n/a	recording	3840	2160	0	0	0	0
retrain:rec:101:7db654abd06b704f	23qp5p0cd7	101	background	day	n/a	recording	3840	2160	1	0	0	1
retrain:rec:101:fc921ae4fa2b7a41	cav1tkq9ya	101	background	day	n/a	recording	3840	2160	1	2	1	2
retrain:rec:101:8ac3e67b36a9b2b5	rwnh3ee4m6	101	background	day	n/a	recording	3840	2160	0	0	0	0
retrain:rec:101:ab2e102d9a182065	ezbpmek268	101	background	day	n/a	recording	3840	2160	0	0	0	0
retrain:rec:102:bf1cf42b9236ca4d	cgxyc6s467	102	background	night	n/a	recording	3840	2160	3	4	3	3
retrain:rec:102:6dd578e42f54ce0f	g53m5x4c8n	102	background	night	n/a	recording	3840	2160	4	5	4	5
retrain:rec:102:090c7d919cc42bee	fp08dckftp	102	background	night	n/a	recording	3840	2160	4	4	4	4
retrain:rec:102:ef8b86c7835c5bc8	x2p2c2mzft	102	background	day	n/a	recording	3840	2160	4	0	0	4
retrain:rec:102:2a96e7a9bca85577	x3bzk11q0c	102	background	day	n/a	recording	3840	2160	5	5	5	6
retrain:rec:102:adb48e9320c93ab6	zad4xw4twv	102	background	day	n/a	recording	3840	2160	1	1	1	1
retrain:rec:102:bc8c17acb43bae91	km3wctwyqw	102	background	day	n/a	recording	3840	2160	2	3	2	3
retrain:rec:1441:75d1d1492d2541ca	htr93spa7e	1441	background	night	n/a	recording	4256	1888	0	0	0	0
retrain:rec:1441:1acabb07625ebdb8	w30019xntk	1441	background	night	n/a	recording	4256	1888	0	0	0	0
retrain:rec:1441:10fad4cd18f20cf2	rpmzgz5va8	1441	background	night	n/a	recording	4256	1888	0	0	0	0
retrain:rec:1441:fa5088ddd0b5a6f6	ck37tfzbhn	1441	background	night	n/a	recording	4256	1888	0	0	0	0
retrain:rec:1441:717249608baa550e	fxbsb37x22	1441	background	night	n/a	recording	4256	1888	0	0	0	0
retrain:rec:1441:8bc9202e90f7d2a9	e93qrs56fr	1441	background	night	n/a	recording	4256	1888	0	0	0	0
retrain:rec:1441:cedc7c3a836e0b6a	v5hyme9rw7	1441	background	night	n/a	recording	4256	1888	0	0	0	0
retrain:rec:1441:53686d84b942b6e2	tq8p8z0ejs	1441	background	day	n/a	recording	4256	1888	0	0	0	0
retrain:rec:1441:8faa68455c2aca22	dcram7s3dh	1441	background	day	n/a	recording	4256	1888	0	0	0	0
retrain:rec:1443:e6c2743d1fc1c4e1	g5seekrsf1	1443	background	day	n/a	recording	3840	2160	1	2	0	3
retrain:rec:1443:7c7057ae64ec6c6f	6x8gwm09xf	1443	background	day	n/a	recording	3840	2160	2	3	2	4
retrain:rec:1443:26902cc36ff6e8f2	7fh081cjvx	1443	background	day	n/a	recording	3840	2160	3	5	3	5
retrain:rec:1443:63d50256a0f386a0	2cvetjpxs6	1443	background	day	n/a	recording	3840	2160	0	0	0	0
retrain:rec:1443:044df319e89b23a0	qryw88z4rx	1443	background	day	n/a	recording	3840	2160	0	0	0	0
retrain:rec:1443:04f5418394a64087	ezsqb8d6ef	1443	background	day	n/a	recording	3840	2160	1	3	0	4
retrain:rec:1443:317ae78a4d8ac71a	hew7rn8kkh	1443	background	day	n/a	recording	3840	2160	1	2	1	2
retrain:rec:1443:f308adb9a6252fd8	g4g31f5egr	1443	background	day	n/a	recording	3840	2160	1	0	0	1
retrain:rec:3831:8a5b65e0d5f18585	tfq8d2zq83	3831	background	day	n/a	recording	3840	2160	0	0	0	0
retrain:rec:3831:476d5f666f983da3	jnfscwdyyv	3831	background	day	n/a	recording	3840	2160	0	0	0	0
retrain:rec:3835:8d3be6ac66eb2405	ctcmspy8h3	3835	background	dusk	n/a	recording	3840	2160	1	0	0	1
retrain:rec:3835:818cbf0b2b83703b	aj3qk97jbv	3835	background	day	n/a	recording	3840	2160	1	0	1	1
retrain:rec:3835:e547129dee0df364	7at5ybgf3r	3835	background	day	n/a	recording	3840	2160	2	0	2	2
retrain:rec:3835:8cd3faf486f67e0e	8y5tv84pbd	3835	background	day	n/a	recording	3840	2160	2	0	2	2
retrain:rec:3835:e17c90e047906876	5sgsmvyscs	3835	background	day	n/a	recording	3840	2160	2	0	2	2
retrain:rec:3835:99de758643fcbbaa	f4nxxzamgn	3835	background	day	n/a	recording	3840	2160	2	0	2	2
retrain:rec:3835:f191b571f0121b05	qpb1b8rfp3	3835	background	day	n/a	recording	3840	2160	2	0	2	2
retrain:rec:3835:e2df5a6f6584b882	p2f23b00br	3835	background	day	n/a	recording	3840	2160	1	0	0	1
retrain:rec:3835:8a12d44248d3666b	w8pgpjppe1	3835	background	day	n/a	recording	3840	2160	2	2	2	2
retrain:rec:3836:d789238582537275	sz2zs91hhr	3836	background	day	n/a	recording	2560	1440	0	0	0	0
retrain:rec:3839:bac4916d72c3d778	ydrkjppas9	3839	background	night	n/a	recording	3840	2160	1	0	0	1
retrain:rec:3839:6c26614e82b166da	7j52td9wsx	3839	background	day	n/a	recording	3840	2160	1	1	0	2
retrain:rec:3839:9f2e3cf6304c691a	x7pdvxzg3s	3839	background	day	n/a	recording	3840	2160	1	0	0	1
retrain:rec:3839:c6549b1c93328dfa	wrptgyrhjd	3839	background	day	n/a	recording	3840	2160	1	0	0	1
retrain:rec:3839:08eab1c361ec6945	prm4w26fbp	3839	background	day	n/a	recording	3840	2160	2	2	2	2
retrain:cm7fqsvjvr:4d133b9941e38a9c	cm7fqsvjvr	103	person	day	mid	keyFrame	3840	2160	1	0	0	1
retrain:hse0rw4wyg:4533966693ee2a89	hse0rw4wyg	103	person	day	small	keyFrame	3840	2160	1	1	0	2
retrain:q4c7zwjm5r:03a471d4ec7552bd	q4c7zwjm5r	103	person	day	small	keyFrame	3840	2160	1	1	0	2
retrain:5h09gt59zv:09cb5409e9221b24	5h09gt59zv	103	person	day	small	keyFrame	3840	2160	1	1	0	2
retrain:bk9qvt4v52:1f9078d3d249d77d	bk9qvt4v52	103	person	night	small	keyFrame	3840	2160	1	0	0	1
retrain:ywf9yyfx7d:2b5843cdf479b37d	ywf9yyfx7d	103	person	dusk	mid	keyFrame	3840	2160	1	2	0	3
retrain:vc17k44bq4:e38b2d901f02594a	vc17k44bq4	103	person	night	mid	keyFrame	3840	2160	1	2	1	2
retrain:ce4r3c6mp2:47e470ffe6322b31	ce4r3c6mp2	103	person	night	small	keyFrame	3840	2160	1	1	0	2
retrain:g7fkgvqmx5:72556d1fe512b6f6	g7fkgvqmx5	103	person	night	mid	keyFrame	3840	2160	1	2	0	3
retrain:xew95rxm17:08e6fa1d09595e03	xew95rxm17	103	person	night	mid	keyFrame	3840	2160	1	1	0	2
retrain:a93y0n76hf:bb3d7d00b020e57a	a93y0n76hf	103	person	night	small	keyFrame	3840	2160	1	2	0	3
retrain:y241ffsfp0:ea802e669dd39b45	y241ffsfp0	103	person	dusk	mid	keyFrame	3840	2160	1	1	0	2
retrain:89avb99t7c:ee9c1b847f2d1b29	89avb99t7c	103	person	dusk	small	keyFrame	3840	2160	1	2	0	2
retrain:51jw7sbehr:05245c980de2cb87	51jw7sbehr	103	person	day	mid	keyFrame	3840	2160	1	1	0	2
retrain:q0j2h858xh:77f9f8bc2381074d	q0j2h858xh	103	person	night	mid	keyFrame	3840	2160	1	0	0	1
retrain:djwxhspbsh:087bff1b6503926a	djwxhspbsh	103	person	day	small	keyFrame	3840	2160	1	2	0	2
retrain:2cs2xfb3pb:54c74792e52cad4d	2cs2xfb3pb	586	person	day	mid	keyFrame	3840	2160	2	2	2	2
retrain:zxh0gx1397:c00f87174215d4e6	zxh0gx1397	586	person	dusk	mid	keyFrame	3840	2160	1	2	1	1
retrain:x3vsbm38zh:019b42435c2bf586	x3vsbm38zh	586	person	night	mid	keyFrame	3840	2160	2	2	2	2
retrain:ykn77s8fy7:1750984db6189038	ykn77s8fy7	586	person	night	mid	keyFrame	3840	2160	2	2	2	2
retrain:3qg1rq6vb5:993aed02be111fdc	3qg1rq6vb5	586	person	day	small	keyFrame	3840	2160	1	2	0	2
retrain:ejwhmme8k1:87c7441477cdcd68	ejwhmme8k1	586	person	dusk	small	keyFrame	3840	2160	2	0	0	2
retrain:13mejrhp49:4c9c27dd2212e75e	13mejrhp49	586	person	dusk	small	keyFrame	3840	2160	1	2	1	1
retrain:2jkrzzzmse:9d77bd5f6c29a53f	2jkrzzzmse	586	person	dusk	mid	keyFrame	3840	2160	1	2	1	2
retrain:2czxxckj7w:91ee8603ee0cb0cb	2czxxckj7w	586	person	dusk	small	keyFrame	3840	2160	0	0	0	0
retrain:229efpm4ap:dd2bf7ba76dc8787	229efpm4ap	586	person	night	mid	keyFrame	3840	2160	1	2	1	1
retrain:gtew1adbja:0ff38d9fdb028a69	gtew1adbja	586	person	day	small	keyFrame	3840	2160	1	1	1	1
retrain:t2fbhbe5gd:c3050b01f2d083e4	t2fbhbe5gd	586	person	day	small	keyFrame	3840	2160	1	0	0	1
retrain:rcg54f4m0b:fc36277334aa91db	rcg54f4m0b	586	person	day	mid	keyFrame	3840	2160	1	2	1	1
retrain:5cyz9ab9ed:b4d737230cb78a14	5cyz9ab9ed	586	person	night	mid	keyFrame	3840	2160	1	2	1	2
retrain:d22c2djak0:36227b6a1c59a882	d22c2djak0	586	person	night	mid	keyFrame	3840	2160	1	2	0	2
retrain:yfdgfrefmp:4cc30ace824fa272	yfdgfrefmp	586	person	day	mid	keyFrame	3840	2160	2	2	1	3
retrain:be4a7vkb84:51520c40c9ad9c63	be4a7vkb84	587	person	day	small	keyFrame	3840	2160	1	2	1	1
retrain:g17xmpaazt:973da8af7ac6c575	g17xmpaazt	587	person	dusk	large	keyFrame	3840	2160	1	2	1	1
retrain:6e97x3ehm2:37bb391e2c6d0c80	6e97x3ehm2	587	person	dusk	large	keyFrame	3840	2160	1	1	0	2
retrain:ab15fbfk7z:fe16035ed080f159	ab15fbfk7z	587	person	night	mid	keyFrame	3840	2160	1	1	1	1
retrain:zfz3cx1m5f:bf183c15563cf008	zfz3cx1m5f	587	person	night	mid	keyFrame	3840	2160	1	2	1	1
retrain:7j5b998b15:a18bbf0e3251caaf	7j5b998b15	587	person	night	mid	keyFrame	3840	2160	1	1	1	1
retrain:an2qahw9x9:9100e67e7ed420c3	an2qahw9x9	587	person	night	mid	keyFrame	3840	2160	1	2	1	1
retrain:9tf4gxyzgy:c360c06e752b96cb	9tf4gxyzgy	587	person	day	small	keyFrame	3840	2160	3	1	0	4
retrain:g89efc1y63:f0e60b00b4b21e11	g89efc1y63	587	person	day	small	keyFrame	3840	2160	2	2	2	4
retrain:4kg0sj0fzm:dfd6db34b1aed693	4kg0sj0fzm	587	person	day	small	keyFrame	3840	2160	1	2	0	3
retrain:bhr2xd669s:793dedcb8ce5ce39	bhr2xd669s	587	person	day	small	keyFrame	3840	2160	1	0	0	1
retrain:ebyyrvp1jg:900c055eb84d94b6	ebyyrvp1jg	587	person	day	small	keyFrame	3840	2160	1	2	1	1
retrain:xhjtvjgr1r:7a5151b9f61cd951	xhjtvjgr1r	587	person	day	small	keyFrame	3840	2160	1	2	0	3
retrain:6wtptz9a89:93d5483ac6b77970	6wtptz9a89	587	person	night	small	keyFrame	3840	2160	1	0	0	1
retrain:0ct7ny7f5g:7d37a48837240905	0ct7ny7f5g	587	person	day	small	keyFrame	3840	2160	3	3	2	4
retrain:a2agzjjf3p:e5ca0592a5cb823e	a2agzjjf3p	104	person	day	small	keyFrame	3840	2160	2	2	2	2
retrain:qrh5rygs87:5ea747c356829041	qrh5rygs87	104	person	night	mid	keyFrame	3840	2160	1	1	1	1
retrain:z43a1v11m1:9bf3c022de49b845	z43a1v11m1	104	person	dusk	mid	keyFrame	3840	2160	1	2	1	2
retrain:2bpcad8tsk:e96af5c6ecfb2991	2bpcad8tsk	104	person	dusk	mid	keyFrame	3840	2160	1	1	1	1
retrain:4sq72f48p6:b84efcc5b8595c40	4sq72f48p6	104	person	day	small	keyFrame	3840	2160	1	1	0	2
retrain:mh083xere7:af99421131cffd3d	mh083xere7	104	person	day	small	keyFrame	3840	2160	1	0	0	1
retrain:84b28fxhsh:0e289bb914939322	84b28fxhsh	104	person	day	small	keyFrame	3840	2160	2	2	2	3
retrain:m1j0hyb0yj:6841e0a15beb1ebc	m1j0hyb0yj	104	person	day	small	keyFrame	3840	2160	0	0	0	0
retrain:8gczqc546w:c07a3e2efdc6282d	8gczqc546w	104	person	night	small	keyFrame	3840	2160	1	2	1	2
retrain:w66f75bx1n:41b4339ed4b47173	w66f75bx1n	104	person	night	mid	keyFrame	3840	2160	1	1	1	1
retrain:av6c1aqk1x:69e5d4e14c7ac7ab	av6c1aqk1x	104	person	night	mid	keyFrame	3840	2160	1	1	1	1
retrain:5mbpsprn6a:09b8eb3a781b7354	5mbpsprn6a	104	person	night	small	keyFrame	3840	2160	0	0	0	0
retrain:ec4ftx4r8t:ea988a47e0c47361	ec4ftx4r8t	104	person	night	mid	keyFrame	3840	2160	1	1	0	2
retrain:hpx8jd1aj0:195b2afa8315cc06	hpx8jd1aj0	104	person	day	small	keyFrame	3840	2160	4	4	4	4
retrain:a6e240gqtd:ba7135cb7988b8b6	a6e240gqtd	592	person	night	small	keyFrame	3840	2160	2	2	2	2
retrain:rtqr1mvwn7:ab6478f43e6f9894	rtqr1mvwn7	592	person	dusk	small	keyFrame	3840	2160	2	0	0	2
retrain:ab6ytenj4w:94091c0edb658831	ab6ytenj4w	592	person	night	mid	keyFrame	3840	2160	2	1	1	2
retrain:evvwkfsg8p:d8614b6bee4fc5c9	evvwkfsg8p	592	person	night	mid	keyFrame	3840	2160	1	1	0	2
retrain:m2a5e2x1md:fedf673948e2ca41	m2a5e2x1md	592	person	dusk	mid	keyFrame	3840	2160	2	0	0	2
retrain:wkbfwtxms8:77b3002eed5f97a8	wkbfwtxms8	592	person	dusk	small	keyFrame	3840	2160	1	3	1	3
retrain:rbmqxjqz5j:ac3cda05ef268af5	rbmqxjqz5j	592	person	night	mid	keyFrame	3840	2160	2	2	1	3
retrain:6as39qt2ts:bcac066590d42fee	6as39qt2ts	592	person	night	small	keyFrame	3840	2160	1	2	1	2
retrain:n628vxhz8r:3a45ae50f269287a	n628vxhz8r	592	person	day	small	keyFrame	3840	2160	0	0	0	0
retrain:9ezadywhs5:9484818454aa6422	9ezadywhs5	592	person	day	small	keyFrame	3840	2160	0	0	0	0
retrain:t6tc3kek8d:cb7466d375c991f7	t6tc3kek8d	592	person	day	small	keyFrame	3840	2160	0	0	0	0
retrain:6f4m2c47cz:3fd22099667da223	6f4m2c47cz	592	person	day	small	keyFrame	3840	2160	0	0	0	0
retrain:wn0j41pxcr:cc32dc369a555251	wn0j41pxcr	592	person	day	small	keyFrame	3840	2160	1	4	0	4
retrain:23scw7v3cp:f126d5cb21a764d0	23scw7v3cp	592	person	day	small	keyFrame	3840	2160	1	4	0	4
retrain:xtt4y6smj3:e926cb079b73942a	xtt4y6smj3	101	person	night	mid	keyFrame	3840	2160	1	2	1	2
retrain:drpmp0ay9r:1712ebcf80b4cafc	drpmp0ay9r	101	person	night	small	keyFrame	3840	2160	1	3	1	3
retrain:v0md61pk88:ac6067338465707c	v0md61pk88	101	person	day	small	keyFrame	3840	2160	1	2	1	2
retrain:5e5s2p3vm7:a33f18c6670fcabf	5e5s2p3vm7	101	person	day	small	keyFrame	3840	2160	0	0	0	0
retrain:6vz4dqbbrn:6ed57ae13f8945f7	6vz4dqbbrn	101	person	day	small	keyFrame	3840	2160	2	2	2	2
retrain:qaa9n1xhn3:b8d874da813f16cc	qaa9n1xhn3	101	person	day	small	keyFrame	3840	2160	2	2	2	2
retrain:zcc28c08r8:275066539cace323	zcc28c08r8	101	person	dusk	small	keyFrame	3840	2160	0	0	0	0
retrain:hjnsgdnkkv:1588be80ceb3c5f3	hjnsgdnkkv	101	person	night	small	keyFrame	3840	2160	1	2	1	2
retrain:xckhqnrpr4:3ffc9c703d88eb96	xckhqnrpr4	101	person	night	small	keyFrame	3840	2160	2	0	0	2
retrain:fbb2x91wd3:591458eaeb7c2560	fbb2x91wd3	101	person	night	small	keyFrame	3840	2160	2	0	0	2
retrain:ms66r6gq59:68f16a5c734912bf	ms66r6gq59	101	person	night	small	keyFrame	3840	2160	1	2	0	3
retrain:x8t4x88h3k:ad0c5889822a59dd	x8t4x88h3k	101	person	dusk	small	keyFrame	3840	2160	1	1	0	2
retrain:vdwvmr15nb:e34ce9ab4ba3d019	vdwvmr15nb	101	person	day	small	keyFrame	3840	2160	2	3	2	3
retrain:ymt9zdtcwe:b47c77e50b9336ec	ymt9zdtcwe	101	person	dusk	small	keyFrame	3840	2160	1	1	1	1
retrain:t80jbew5bj:8f8ec654da11e151	t80jbew5bj	101	person	day	small	keyFrame	3840	2160	2	3	2	3
retrain:pvwj2e7yt9:a6a4ff3152ffd81c	pvwj2e7yt9	102	person	day	small	keyFrame	3840	2160	4	5	4	5
retrain:e31t99zbdq:3e9b3b0577580d9c	e31t99zbdq	102	person	day	small	keyFrame	3840	2160	4	4	4	4
retrain:yftqn5v58z:961b8b04be77e6d9	yftqn5v58z	102	person	night	small	keyFrame	3840	2160	4	0	0	4
retrain:8pw0exjqg6:5152881c6e50d585	8pw0exjqg6	102	person	day	small	keyFrame	3840	2160	5	6	5	6
retrain:fg2e3g5631:89445e9c111fc4be	fg2e3g5631	102	person	dusk	small	keyFrame	3840	2160	5	0	0	5
retrain:qxbckx59cm:1623c29928289ceb	qxbckx59cm	102	person	dusk	small	keyFrame	3840	2160	5	6	5	6
retrain:rxn8vxsh2g:ddb9602b6ec883cf	rxn8vxsh2g	102	person	dusk	small	keyFrame	3840	2160	3	5	3	5
retrain:zmt3sgd6nv:a1f8f101b119a13a	zmt3sgd6nv	102	person	night	small	keyFrame	3840	2160	3	3	1	5
retrain:rrnr41wn1z:66331ef1316ccba0	rrnr41wn1z	102	person	night	small	keyFrame	3840	2160	3	3	3	3
retrain:6n7zts6z5b:6e2a7f12e706083a	6n7zts6z5b	102	person	night	small	keyFrame	3840	2160	4	4	4	4
retrain:ptbv06r8mc:3c94a2dc532be5fb	ptbv06r8mc	102	person	night	small	keyFrame	3840	2160	4	5	4	5
retrain:ycj2jagy4g:03028b3ec1425031	ycj2jagy4g	102	person	day	small	keyFrame	3840	2160	4	4	4	4
retrain:9kbqzys9de:92169e366b7d2924	9kbqzys9de	102	person	day	small	keyFrame	3840	2160	4	4	4	4
retrain:btw2apf92y:19f416bb36df6e4c	btw2apf92y	102	person	night	small	keyFrame	3840	2160	5	5	5	5
retrain:3w7mm887jy:10e99656436866a1	3w7mm887jy	102	person	day	small	keyFrame	3840	2160	3	3	2	3
retrain:dvresevp4x:9a5b770fe305a589	dvresevp4x	618	person	night	small	keyFrame	3840	2160	1	0	0	1
retrain:bh847mcybm:8b8e801ca2ba59a3	bh847mcybm	618	person	day	small	keyFrame	3840	2160	1	1	1	1
retrain:5j8yxrc89t:4901a8f5c65a3429	5j8yxrc89t	618	person	night	small	keyFrame	3840	2160	1	2	0	3
retrain:dt0qh86v0y:06808e83dfe21d06	dt0qh86v0y	618	person	day	small	keyFrame	3840	2160	2	2	2	2
retrain:7j2br5bkxd:06213a0186ffcc56	7j2br5bkxd	618	person	night	small	keyFrame	3840	2160	1	2	0	3
retrain:tve3jkybvk:9e4dc7b57f634259	tve3jkybvk	618	person	dusk	mid	keyFrame	3840	2160	1	2	0	2
retrain:scm7q8z18z:96f736e6194935cc	scm7q8z18z	618	person	night	small	keyFrame	3840	2160	1	2	1	2
retrain:9eaebc2fye:0895804d7a636014	9eaebc2fye	618	person	day	mid	keyFrame	3840	2160	1	1	1	1
retrain:v6gjjehax7:89c09d9ea092fa46	v6gjjehax7	618	person	day	mid	keyFrame	3840	2160	1	2	1	1
retrain:a1k32007yr:c2b0b4cf65800cef	a1k32007yr	618	person	day	mid	keyFrame	3840	2160	1	0	0	1
retrain:zpnq3amd5n:88b6f65f0c60c485	zpnq3amd5n	618	person	night	small	keyFrame	3840	2160	1	5	0	6
retrain:4vymbe5kkr:b72409ef907c6d98	4vymbe5kkr	618	person	dusk	mid	keyFrame	3840	2160	2	2	2	2
retrain:vqye2b7d36:71fd525fce617139	vqye2b7d36	618	person	night	small	keyFrame	3840	2160	2	1	0	3
retrain:t92nnz06sw:5a102ab19e51984c	t92nnz06sw	618	person	night	small	keyFrame	3840	2160	1	3	1	3
retrain:bpp72dym0h:1a0e01d305e75b72	bpp72dym0h	636	person	day	small	keyFrame	3840	2160	1	2	1	1
retrain:8dw269tktp:d76a26bfe5a29cde	8dw269tktp	636	person	dusk	small	keyFrame	3840	2160	1	0	0	1
retrain:b26ncagdnd:2e1ee95e2001256e	b26ncagdnd	636	person	day	small	keyFrame	3840	2160	1	2	0	2
retrain:pvcgk3wj00:f06745e2fbc4d4a3	pvcgk3wj00	636	person	day	mid	keyFrame	3840	2160	1	1	0	2
retrain:356e1s2q26:ebfa5c23f5994757	356e1s2q26	636	person	day	small	keyFrame	3840	2160	1	1	1	1
retrain:nprxy7mkny:8317d8192a968eb3	nprxy7mkny	636	person	day	small	keyFrame	3840	2160	1	1	1	1
retrain:yd7z120v3j:29f2bd055142582a	yd7z120v3j	636	person	day	small	keyFrame	3840	2160	1	2	0	2
retrain:6r70takmm8:a86041ed9ef344f8	6r70takmm8	636	person	day	mid	keyFrame	3840	2160	1	1	0	2
retrain:7fpm7metnq:e0fcc73abf7dba88	7fpm7metnq	636	person	day	small	keyFrame	3840	2160	1	1	1	1
retrain:zfgybvayzs:3b0830de70da403f	zfgybvayzs	636	person	day	mid	keyFrame	3840	2160	1	1	0	2
retrain:14e2a08z78:e72b726374652b85	14e2a08z78	636	person	day	small	keyFrame	3840	2160	1	2	1	1
retrain:vtvvrzathf:4582e85de3a2f756	vtvvrzathf	636	person	night	mid	keyFrame	3840	2160	1	2	0	3
retrain:e3qcpv9q9h:9c405f1db235296c	e3qcpv9q9h	636	person	day	mid	keyFrame	3840	2160	1	1	1	1
retrain:1s503d2ty8:c230df8571888457	1s503d2ty8	636	person	day	large	keyFrame	3840	2160	1	1	1	1
retrain:as7rjadhpk:1b5eba32e65867da	as7rjadhpk	636	person	day	mid	keyFrame	3840	2160	1	1	1	1
retrain:rrw3hpaake:c20d71c2edf6bc83	rrw3hpaake	637	person	dusk	mid	keyFrame	3840	2160	1	2	1	1
retrain:q7y341j0rb:268a041b7fa0642c	q7y341j0rb	637	person	day	small	keyFrame	3840	2160	1	2	0	2
retrain:zk1cv31wrs:8fc70d20e971bc35	zk1cv31wrs	637	person	day	small	keyFrame	3840	2160	1	2	1	2
retrain:25ywbpm8xa:404b8ce5c3613997	25ywbpm8xa	637	person	night	small	keyFrame	3840	2160	1	2	0	2
retrain:xygwkjyabq:6cd6b9d290f14c47	xygwkjyabq	637	person	night	mid	keyFrame	3840	2160	1	1	1	1
retrain:7g2nqr9nhx:6bc04817213379be	7g2nqr9nhx	637	person	day	small	keyFrame	3840	2160	1	0	0	1
retrain:6cen0bqbde:717a6de228b20407	6cen0bqbde	637	person	day	small	keyFrame	3840	2160	1	2	1	1
retrain:8xk1p91phy:784307e6bc3f451d	8xk1p91phy	637	person	dusk	small	keyFrame	3840	2160	1	2	1	2
retrain:se4ehq6a5f:45a01ea231443983	se4ehq6a5f	637	person	dusk	small	keyFrame	3840	2160	1	2	1	1
retrain:7sgdps7hqz:060544efaa7a6c9a	7sgdps7hqz	637	person	dusk	small	keyFrame	3840	2160	2	2	2	2
retrain:9vcdft8cy6:0f24c67219251027	9vcdft8cy6	637	person	day	small	keyFrame	3840	2160	1	2	1	2
retrain:9081sfwshe:d3cf974c3d95988e	9081sfwshe	637	person	day	small	keyFrame	3840	2160	1	2	1	1
retrain:sh03pr09xm:834c409b70aa27d2	sh03pr09xm	637	person	day	small	keyFrame	3840	2160	1	0	0	1
retrain:w68zjp5wwz:1793c816bedd4ddb	w68zjp5wwz	637	person	night	mid	keyFrame	3840	2160	1	2	1	2
retrain:nsywwaecwr:b6b8770f86f16338	nsywwaecwr	637	person	night	mid	keyFrame	3840	2160	1	1	0	2
retrain:tx7yqz3a11:caf64bcc3bf4d710	tx7yqz3a11	637	person	day	small	keyFrame	3840	2160	1	2	1	1
retrain:cvds3npxm2:87639854b7a5f045	cvds3npxm2	640	person	day	large	keyFrame	2304	1296	2	0	1	2
retrain:2q3cpzwnjt:4d114e2067cd3324	2q3cpzwnjt	640	person	day	large	keyFrame	2304	1296	2	0	1	2
retrain:rcb34zpw7g:8e79f02c38908802	rcb34zpw7g	640	person	day	large	keyFrame	2304	1296	2	1	2	2
retrain:df7jvzmv3a:199f898b03fbf8a7	df7jvzmv3a	640	person	day	large	keyFrame	2304	1296	1	0	0	1
retrain:0ea6e725mx:99b2573c2ffd780f	0ea6e725mx	640	person	day	large	keyFrame	2304	1296	2	0	0	2
retrain:2q7xh20k0f:3442f9267634574c	2q7xh20k0f	640	person	day	mid	keyFrame	2304	1296	3	3	3	3
retrain:r0p4a3mann:30e829b872c405ff	r0p4a3mann	640	person	day	mid	keyFrame	2304	1296	2	1	2	2
retrain:sh3gwg5c6y:36884004f8e4e489	sh3gwg5c6y	640	person	day	mid	keyFrame	2304	1296	2	0	0	2
retrain:rskcntxt3n:62b958a3bd089568	rskcntxt3n	640	person	day	large	keyFrame	2304	1296	2	2	2	2
retrain:rkryx5qzbn:8074a554583ccdd8	rkryx5qzbn	640	person	day	large	keyFrame	2304	1296	2	2	2	2
retrain:90xnstmx0t:f37adde501ba1b05	90xnstmx0t	640	person	day	large	keyFrame	2304	1296	1	0	0	1
retrain:hn54vzr1cr:d7d831e2c8269e10	hn54vzr1cr	640	person	day	large	keyFrame	2304	1296	1	1	1	1
retrain:rda635asq5:8ecf37c3c12203aa	rda635asq5	1436	person	day	small	keyFrame	3840	2160	1	0	0	1
retrain:vmzd97d6n3:92b12c89f3b332bd	vmzd97d6n3	1436	person	day	small	keyFrame	3840	2160	1	0	0	1
retrain:1j1cvkta3r:16c5b1a840493a7b	1j1cvkta3r	1436	person	day	small	keyFrame	3840	2160	1	1	1	1
retrain:kh5wqcsshv:e7584afdf7157cf3	kh5wqcsshv	1436	person	day	small	keyFrame	3840	2160	1	2	1	2
retrain:22tamhd24y:4e83f7d22650d928	22tamhd24y	1436	person	day	mid	keyFrame	3840	2160	1	2	1	2
retrain:r8jfth83ac:82e78f7685d266b9	r8jfth83ac	1436	person	day	small	keyFrame	3840	2160	2	2	2	2
retrain:njkrpwj2z1:4029adc49ba01a45	njkrpwj2z1	1436	person	night	small	keyFrame	3840	2160	2	4	2	4
retrain:1ya8e27ecj:5341997f3905505c	1ya8e27ecj	1436	person	night	mid	keyFrame	3840	2160	2	2	2	2
retrain:rkn3s3k6cw:4f497edbb7f149ff	rkn3s3k6cw	1436	person	night	mid	keyFrame	3840	2160	1	1	1	1
retrain:4zkwjvy02c:424b3dd96fdd675d	4zkwjvy02c	1436	person	dusk	mid	keyFrame	3840	2160	1	2	1	2
retrain:79w59zzqfg:1f54f96ed305aa00	79w59zzqfg	1436	person	night	mid	keyFrame	3840	2160	1	1	1	1
retrain:a0jfcggt34:bbd53895e153f086	a0jfcggt34	1436	person	night	small	keyFrame	3840	2160	1	0	0	1
retrain:1xefsjcz6j:b071978013ecfc13	1xefsjcz6j	1436	person	night	small	keyFrame	3840	2160	1	2	0	2
retrain:nnn73a3atd:36df5d3fe6dfeefa	nnn73a3atd	1436	person	dusk	mid	keyFrame	3840	2160	1	1	1	1
retrain:1g9ns637n9:b79e549b1662f5a7	1g9ns637n9	1436	person	day	small	keyFrame	3840	2160	1	2	1	1
retrain:vytd3znynv:f61d253807d8e8d4	vytd3znynv	1438	person	day	large	keyFrame	2560	1440	2	0	0	2
retrain:69jz4nh5d0:2a6651b856b7f69d	69jz4nh5d0	1438	person	day	mid	keyFrame	2560	1440	2	1	0	3
retrain:nq0mtk55yk:8b8d7a22914cf230	nq0mtk55yk	1438	person	day	mid	keyFrame	2560	1440	2	2	2	2
retrain:t0wjmetxyk:0a5e2640726a012d	t0wjmetxyk	1438	person	night	large	keyFrame	2560	1440	1	1	1	1
retrain:0p4kafsxpd:1e51f098fb203697	0p4kafsxpd	1438	person	dusk	large	keyFrame	2560	1440	1	1	1	1
retrain:7kzs33kqw9:611681bff60cb3d8	7kzs33kqw9	1438	person	dusk	large	keyFrame	2560	1440	1	0	0	1
retrain:kzxtrq4vk4:c737ac3e05299873	kzxtrq4vk4	1438	person	night	large	keyFrame	2560	1440	1	0	0	1
retrain:4dea4jsj2j:aac9b5f71b46f018	4dea4jsj2j	1438	person	night	large	keyFrame	2560	1440	1	1	1	1
retrain:j07ta3t1g4:7523998eb4fa7626	j07ta3t1g4	1438	person	night	large	keyFrame	2560	1440	1	1	1	1
retrain:fjgs90fwfz:a19b27876bf2bd5e	fjgs90fwfz	1438	person	day	large	keyFrame	2560	1440	1	1	1	1
retrain:1az5v9p2sx:4b53bc1b6aac04ca	1az5v9p2sx	1438	person	night	large	keyFrame	2560	1440	1	0	0	1
retrain:7df5sa8e43:5fb5926595febbf8	7df5sa8e43	1438	person	day	mid	keyFrame	2560	1440	2	1	1	2
retrain:z2cx8cf50s:e46e94f34e37686a	z2cx8cf50s	1438	person	dusk	large	keyFrame	2560	1440	1	1	1	1
retrain:qhmm2r67qc:1d38751bd2483461	qhmm2r67qc	1439	person	day	small	keyFrame	3840	2160	5	7	5	6
retrain:8x50g7av7p:6c72de14d73150f2	8x50g7av7p	1439	person	day	small	keyFrame	3840	2160	2	3	2	3
retrain:vx4fy0v9wx:3b256946e3943916	vx4fy0v9wx	1439	person	day	small	keyFrame	3840	2160	1	3	0	4
retrain:6s27sj3fc3:a93f645d171e4d52	6s27sj3fc3	1439	person	day	small	keyFrame	3840	2160	3	5	3	5
retrain:8wtkbaqqbk:b570fb8ba9eda84e	8wtkbaqqbk	1439	person	day	small	keyFrame	3840	2160	1	4	1	4
retrain:eqwx63qs3e:2301fe5f875b468c	eqwx63qs3e	1439	person	day	small	keyFrame	3840	2160	1	3	1	3
retrain:hrctk1hcjk:59a2500039426e27	hrctk1hcjk	1439	person	day	small	keyFrame	3840	2160	1	3	1	3
retrain:2qvm5tdskb:d12e761d054dfbf3	2qvm5tdskb	1439	person	day	small	keyFrame	3840	2160	2	4	2	3
retrain:00n3hxhn5q:dddc34ce358ba86a	00n3hxhn5q	1439	person	day	small	keyFrame	3840	2160	1	4	1	4
retrain:09x6h1mdb0:823ab01d95b5227a	09x6h1mdb0	1439	person	day	small	keyFrame	3840	2160	1	5	1	5
retrain:kz768xaf99:cf44649a2caeeb34	kz768xaf99	1439	person	dusk	mid	keyFrame	3840	2160	2	2	2	4
retrain:fpqm6pck23:40c146158b48efa3	fpqm6pck23	1439	person	day	small	keyFrame	3840	2160	1	4	1	4
retrain:7xhahb0fny:ede03fd5cda78988	7xhahb0fny	1439	person	dusk	mid	keyFrame	3840	2160	2	2	2	2
retrain:h0s14dk293:53a75d49ea8bc304	h0s14dk293	1439	person	dusk	mid	keyFrame	3840	2160	2	2	1	3
retrain:pt35awka1k:9bfdff66bbd17212	pt35awka1k	1439	person	dusk	small	keyFrame	3840	2160	2	2	2	2
retrain:rj17x1302p:dc5c7702a9e2df7b	rj17x1302p	1439	person	dusk	mid	keyFrame	3840	2160	2	2	2	2
retrain:h95rjmds5b:6077097c272232da	h95rjmds5b	1441	person	day	small	keyFrame	4096	1817	1	2	0	2
retrain:jmt459dd1j:f27b83767edb57b3	jmt459dd1j	1441	person	day	small	keyFrame	4096	1817	1	2	1	2
retrain:ssnsd0bs2q:b28ce7ceeefbf322	ssnsd0bs2q	1441	person	dusk	mid	keyFrame	4096	1817	1	2	0	3
retrain:nxb46wma9r:bd11a7b9fdf6fa41	nxb46wma9r	1441	person	day	small	keyFrame	4096	1817	2	2	2	2
retrain:yc1n9d4fg1:3dfa32659505720b	yc1n9d4fg1	1441	person	day	small	keyFrame	4096	1817	2	2	2	2
retrain:w4dxrq9s1t:ab25d26a5683c144	w4dxrq9s1t	1441	person	day	small	keyFrame	4096	1817	2	2	2	2
retrain:j99yp83z89:9fe45194edd5ff9c	j99yp83z89	1441	person	night	mid	keyFrame	4096	1817	1	0	0	1
retrain:qgpffrdekq:fa0d4ff6ac431b6a	qgpffrdekq	1441	person	day	small	keyFrame	4096	1817	1	4	1	4
retrain:ayj3t0qbph:ffae0f61a9cd9702	ayj3t0qbph	1441	person	day	small	keyFrame	4096	1817	1	2	1	2
retrain:05x415pgn3:aef8d98ea08b2d16	05x415pgn3	1441	person	dusk	small	keyFrame	4096	1817	1	2	1	2
retrain:54nzw2wn9y:15d6c14c89b18c3d	54nzw2wn9y	1441	person	dusk	mid	keyFrame	4096	1817	1	2	0	3
retrain:34hdbda47t:144e5cdb60f104b8	34hdbda47t	1441	person	dusk	small	keyFrame	4096	1817	1	3	0	4
retrain:06h6y74at6:250e7f321565d779	06h6y74at6	1441	person	day	small	keyFrame	4096	1817	1	2	0	3
retrain:pgwg3wkn1n:4aeff894867d7bb2	pgwg3wkn1n	1441	person	night	large	keyFrame	4096	1817	1	3	1	3
retrain:f3r41y80hm:00d52289f1c7c6ae	f3r41y80hm	1441	person	night	mid	keyFrame	4096	1817	1	2	1	2
retrain:d46e95kxxv:1aa3ddd700fef791	d46e95kxxv	1443	person	night	mid	keyFrame	3840	2160	2	0	0	2
retrain:44rxztqxma:79a8d1204b7f1d52	44rxztqxma	1443	person	night	small	keyFrame	3840	2160	2	2	0	4
retrain:xsje68zmgk:9522f815ed19665c	xsje68zmgk	1443	person	night	mid	keyFrame	3840	2160	1	1	0	2
retrain:zfemdwj0d9:94b748722878acea	zfemdwj0d9	1443	person	day	small	keyFrame	1280	720	0	0	0	0
retrain:7wz867qcdg:75fa7b968aa37074	7wz867qcdg	1443	person	night	small	keyFrame	1280	720	1	2	1	1
retrain:x5aejfpjya:726778e5f6bfda28	x5aejfpjya	1443	person	day	small	keyFrame	1280	720	2	0	0	2
retrain:ww2tp2gj9d:ba20163e1608b9c7	ww2tp2gj9d	1443	person	night	mid	keyFrame	1280	720	1	2	1	2
retrain:25qzspk9h4:90687e40bc450426	25qzspk9h4	1443	person	day	small	keyFrame	1280	720	1	2	1	2
retrain:ajvkrqn1hk:e0d1791035fa1a51	ajvkrqn1hk	1443	person	day	small	keyFrame	1280	720	1	2	1	1
retrain:dcf0e77sbz:8c6edc6cdc671cb6	dcf0e77sbz	1443	person	dusk	small	keyFrame	1280	720	1	2	1	2
retrain:20hpttvgb4:299197c916e854c2	20hpttvgb4	1443	person	dusk	mid	keyFrame	1280	720	2	1	1	2
retrain:v0j6xb4q7h:389d7d6595b4ed9a	v0j6xb4q7h	1443	person	dusk	mid	keyFrame	1280	720	1	2	1	2
retrain:w48kjqev46:0f6a6d0ede417921	w48kjqev46	1443	person	night	mid	keyFrame	1280	720	1	2	1	1
retrain:rfnzbwb2ah:a21970d06f54f654	rfnzbwb2ah	1443	person	day	small	keyFrame	1280	720	1	0	0	1
retrain:0dj2d7r9ps:0e67e98c556b7973	0dj2d7r9ps	3628	person	day	large	keyFrame	2304	1296	1	1	1	1
retrain:4s4tqhp9c2:8ff94369b4b53603	4s4tqhp9c2	3628	person	dusk	mid	keyFrame	2304	1296	3	3	0	6
retrain:rec:3628:5de267ae9e99a281	xzk76nbxeb	3628	person	dusk	small	recording	2304	1296	3	0	0	3
retrain:h1rnxwz8y5:c8659af950577231	h1rnxwz8y5	3628	person	dusk	small	keyFrame	2304	1296	3	1	2	3
retrain:rec:3628:31fa31e6dfac1dee	dbdtd9szze	3628	person	dusk	small	recording	2304	1296	4	4	3	5
retrain:md73efemek:1b3136fd8d6e8168	md73efemek	3628	person	day	mid	keyFrame	2304	1296	1	1	1	1
retrain:0vayqc2dz5:bee4e47939a3484e	0vayqc2dz5	3628	person	day	mid	keyFrame	2304	1296	2	2	2	2
retrain:6q18jtgz1v:a8c65c507e8c8f5c	6q18jtgz1v	3628	person	day	mid	keyFrame	2304	1296	1	1	1	1
retrain:xy70m7j513:959b61736094c6fc	xy70m7j513	3628	person	day	mid	keyFrame	2304	1296	1	1	0	2
retrain:s80c72150h:5de6262d2ebe7926	s80c72150h	3628	person	dusk	mid	keyFrame	2304	1296	3	1	2	4
retrain:gv6heyad47:6ad79d84fdc2963e	gv6heyad47	3628	person	dusk	mid	keyFrame	2304	1296	2	1	1	2
retrain:j81y5t8m5z:908c2b2046792f6a	j81y5t8m5z	3628	person	day	mid	keyFrame	2304	1296	3	3	3	3
retrain:6p4x08mqfc:8212b477f47e1c43	6p4x08mqfc	3628	person	night	mid	keyFrame	2304	1296	2	1	0	3
retrain:9zax30tmjr:70bf3851c2c01120	9zax30tmjr	3628	person	night	large	keyFrame	2304	1296	1	1	1	1
retrain:4anayrpwnc:f1c294dcf4d9b062	4anayrpwnc	3628	person	night	large	keyFrame	2304	1296	1	0	0	1
retrain:mta9wt03pa:ee4d39436a302aab	mta9wt03pa	3628	person	night	mid	keyFrame	2304	1296	3	3	3	3
retrain:w3mba9jafz:8b799a4b016d4d48	w3mba9jafz	3628	person	night	large	keyFrame	2304	1296	1	0	0	1
retrain:v6mg8ze2jm:926dd57b03ab75ba	v6mg8ze2jm	3629	person	dusk	large	keyFrame	3840	2160	1	1	1	1
retrain:nfzxs2wfwq:fe953015bf0ebd7b	nfzxs2wfwq	3629	person	dusk	large	keyFrame	3840	2160	1	0	0	1
retrain:v9kcd9an2t:59bd3beef7d67e21	v9kcd9an2t	3629	person	dusk	large	keyFrame	3840	2160	1	1	1	1
retrain:jmmvga3nxh:274fb20c1b92f8f1	jmmvga3nxh	3629	person	day	large	keyFrame	3840	2160	1	0	0	1
retrain:ka8d5d91nn:0d3aeebcce991c6f	ka8d5d91nn	3629	person	dusk	large	keyFrame	3840	2160	1	1	1	1
retrain:b5b67z598c:5e1ed769cc806e55	b5b67z598c	3629	person	dusk	large	keyFrame	3840	2160	1	2	0	2
retrain:c5yqw5adnr:7f1f0d8bf22258ee	c5yqw5adnr	3629	person	dusk	large	keyFrame	3840	2160	1	1	1	1
retrain:rec:3629:da532a44aba2d4bb	wz06w80ndv	3629	person	day	mid	recording	3840	2160	1	1	1	1
retrain:rec:3629:774d4fd6566e1347	zhbjmf93vn	3629	person	dusk	mid	recording	3840	2160	1	2	1	2
retrain:rec:3629:b716b0738dfa4be7	zhbjmf93vn	3629	person	dusk	small	recording	3840	2160	1	2	1	1
retrain:rec:3629:9621f345d0d8ff0c	587a4k26dx	3629	person	dusk	large	recording	3840	2160	1	1	1	1
retrain:k715mpehaa:1ba8de7fda78d940	k715mpehaa	3629	person	dusk	large	keyFrame	3840	2160	1	1	1	1
retrain:z0yfzb9mck:8f531005fe632e21	z0yfzb9mck	3629	person	dusk	large	keyFrame	3840	2160	1	1	1	1
retrain:vbr6e9d79d:7f5bb8c094632269	vbr6e9d79d	3825	person	day	large	keyFrame	1920	1080	1	1	1	1
retrain:gfvreqcbe8:00878bc32ddb7026	gfvreqcbe8	3825	person	day	large	keyFrame	1920	1080	1	2	1	2
retrain:hyab9g08a6:eb4e5f15f3bb311b	hyab9g08a6	3825	person	day	mid	keyFrame	1920	1080	1	1	1	1
retrain:mmhfg0mfrv:0fb3295a9e9b43c8	mmhfg0mfrv	3829	person	day	small	keyFrame	3840	2160	4	0	1	4
retrain:y2pv51axma:0e9886822b8f4a3e	y2pv51axma	3829	person	dusk	mid	keyFrame	3840	2160	3	3	3	3
retrain:rt982a1kts:dd201b184a16f2d3	rt982a1kts	3829	person	day	small	keyFrame	3840	2160	2	2	2	2
retrain:mwd1hn00kv:302309e5ed7c24bf	mwd1hn00kv	3829	person	day	small	keyFrame	3840	2160	2	2	2	2
retrain:89sabmzm6z:211ff17dc5f3a945	89sabmzm6z	3829	person	day	small	keyFrame	3840	2160	3	3	3	3
retrain:vr63b9t48s:1ac016cac12c7928	vr63b9t48s	3829	person	day	small	keyFrame	3840	2160	3	3	3	3
retrain:gc6czrxmar:0de559ad351deb26	gc6czrxmar	3829	person	day	small	keyFrame	3840	2160	2	2	2	2
retrain:mb7bmh54yz:1daa8c139126aecb	mb7bmh54yz	3829	person	dusk	small	keyFrame	3840	2160	2	1	1	2
retrain:c9cnergve6:d982e1f06d72c72f	c9cnergve6	3829	person	day	small	keyFrame	3840	2160	2	1	1	2
retrain:xj6gsmrxyn:324d620d3c35c9db	xj6gsmrxyn	3829	person	day	small	keyFrame	3840	2160	2	2	2	2
retrain:pj7cwzmmdd:9b2552474cf4b0e5	pj7cwzmmdd	3829	person	day	small	keyFrame	3840	2160	2	2	2	2
retrain:gkc7x2cpye:cc94eb3cf5e0f435	gkc7x2cpye	3830	person	night	large	keyFrame	3840	2160	1	0	0	1
retrain:2y98zrnyxp:6a7e63c188646137	2y98zrnyxp	3830	person	day	mid	keyFrame	3840	2160	1	2	1	2
retrain:2eh0gbbpq3:b4a0f618b12b56e6	2eh0gbbpq3	3830	person	day	mid	keyFrame	3840	2160	1	4	0	3
retrain:54ga1gaznw:3bfaeb13bba7edbb	54ga1gaznw	3830	person	day	mid	keyFrame	3840	2160	1	3	1	3
retrain:jb52r7db7g:e71598b7b3c5b462	jb52r7db7g	3830	person	day	small	keyFrame	3840	2160	1	1	1	1
retrain:btqe1kghaa:b6d4ea8045c108dd	btqe1kghaa	3830	person	day	mid	keyFrame	3840	2160	1	2	1	2
retrain:w39kqjprxq:8a06df81054037bc	w39kqjprxq	3830	person	day	mid	keyFrame	3840	2160	1	2	1	2
retrain:rymfvs0s6k:dc83093356434529	rymfvs0s6k	3830	person	day	mid	keyFrame	3840	2160	1	3	1	3
retrain:3nbkehbf46:32ec43aed5856899	3nbkehbf46	3830	person	day	mid	keyFrame	3840	2160	1	3	1	2
retrain:h6rpfnf2kr:5af22800cbb1bb46	h6rpfnf2kr	3830	person	day	mid	keyFrame	3840	2160	1	2	1	2
retrain:gg9h998am6:39829f2b4b33bc12	gg9h998am6	3830	person	night	large	keyFrame	3840	2160	1	2	1	2
retrain:dryj9be4dw:cc6d3753e53a0506	dryj9be4dw	3830	person	day	mid	keyFrame	3840	2160	1	1	0	2
retrain:w7mp1gcvyj:a029178f8a342ae7	w7mp1gcvyj	3830	person	day	small	keyFrame	3840	2160	1	2	1	2
retrain:jsft6zne58:15e170b0291fb2ae	jsft6zne58	3831	person	day	large	keyFrame	3840	2160	0	0	0	0
retrain:agmb3prnjt:068f602fd5b820ce	agmb3prnjt	3831	person	dusk	large	keyFrame	3840	2160	0	0	0	0
retrain:ken8kp0fh7:df0266f2c2fbecca	ken8kp0fh7	3835	person	day	small	keyFrame	3840	2160	1	3	1	2
retrain:6v38n0qyxb:bf31f45b50277352	6v38n0qyxb	3835	person	day	small	keyFrame	3840	2160	1	2	1	3
retrain:qsz6w53cpb:6b8ffed0873ddbf1	qsz6w53cpb	3835	person	day	small	keyFrame	3840	2160	1	3	1	1
retrain:5qrx9d0mr0:0ab070a94ef1b9bd	5qrx9d0mr0	3835	person	day	small	keyFrame	3840	2160	0	0	0	0
retrain:90cpsn3cej:2c2af0996357fa8f	90cpsn3cej	3835	person	dusk	small	keyFrame	3840	2160	1	2	0	3
retrain:ech9225j4k:cb47d5e03bfba502	ech9225j4k	3835	person	day	small	keyFrame	3840	2160	1	2	1	2
retrain:drscqh6c15:8c6ba54a04517770	drscqh6c15	3835	person	day	small	keyFrame	3840	2160	1	2	1	2
retrain:6bafn0h2gc:9c7fc6ac8f482403	6bafn0h2gc	3835	person	day	small	keyFrame	3840	2160	1	2	1	2
retrain:jvt0pxd87v:22fd67b989a19110	jvt0pxd87v	3835	person	day	small	keyFrame	3840	2160	1	1	0	2
retrain:wwz47p1ks6:f6e8511efd62bec9	wwz47p1ks6	3835	person	day	small	keyFrame	3840	2160	1	3	1	3
retrain:6zr791pxh7:b840919679f9707d	6zr791pxh7	3835	person	day	small	keyFrame	3840	2160	1	1	1	1
retrain:gcqk8qr835:c0bafa17e19a27a1	gcqk8qr835	3835	person	day	small	keyFrame	3840	2160	1	2	0	2
retrain:wanfccaabq:83b79d5e74d0a276	wanfccaabq	3835	person	day	small	keyFrame	3840	2160	0	0	0	0
retrain:6qqyka9btv:10b46a2989d5c172	6qqyka9btv	3835	person	day	small	keyFrame	3840	2160	1	2	1	2
retrain:f43g0c0ph1:4d120988a4e1ea2b	f43g0c0ph1	3835	person	night	large	keyFrame	3840	2160	1	2	1	2
retrain:5tyztx24hs:71b40e920d4ad5bf	5tyztx24hs	3836	person	day	small	keyFrame	2560	1440	0	0	0	0
retrain:7eyr66w5pw:1ae6336d4d77b58d	7eyr66w5pw	3836	person	day	small	keyFrame	2560	1440	1	2	1	1
retrain:tfh0a2hz3t:405374391eba9d0b	tfh0a2hz3t	3836	person	day	small	keyFrame	2560	1440	1	2	0	3
retrain:0df7chkqnz:c7991124bc5d3476	0df7chkqnz	3836	person	day	small	keyFrame	2560	1440	1	2	1	2
retrain:gq3scrvjgs:dd9eb06700e83c9c	gq3scrvjgs	3836	person	day	small	keyFrame	2560	1440	1	2	1	1
retrain:bzfym2epen:7f3fb8f00583b327	bzfym2epen	3836	person	night	small	keyFrame	2560	1440	1	2	0	3
retrain:xe4ntpyf0e:15ff751bb76b7d4e	xe4ntpyf0e	3836	person	night	small	keyFrame	2560	1440	2	2	2	2
retrain:xgp0fj4gx8:c33ab9f245375d70	xgp0fj4gx8	3836	person	night	small	keyFrame	2560	1440	1	2	0	3
retrain:3xkpcth4sw:e59cf70906320ce2	3xkpcth4sw	3836	person	night	small	keyFrame	2560	1440	2	2	2	2
retrain:zbhgxmdx7a:22d29f1874e03aa4	zbhgxmdx7a	3836	person	night	small	keyFrame	2560	1440	1	2	1	1
retrain:d16k8n1mng:b6faf509f6c18b79	d16k8n1mng	3836	person	night	small	keyFrame	2560	1440	1	2	1	3
retrain:3re4nbpj55:34b5961e98884633	3re4nbpj55	3836	person	night	small	keyFrame	2560	1440	2	2	2	2
retrain:3spmffh4n6:c4ec4da29c89b514	3spmffh4n6	3836	person	dusk	mid	keyFrame	2560	1440	2	2	1	3
retrain:dn9jzxsbv7:c204d088c375e221	dn9jzxsbv7	3836	person	day	small	keyFrame	2560	1440	1	2	1	1
retrain:bcmc004576:cb61355a4f1a4b64	bcmc004576	3836	person	dusk	small	keyFrame	2560	1440	3	3	1	4
retrain:8dg6j5wbxt:61be145abe000f7e	8dg6j5wbxt	3836	person	dusk	mid	keyFrame	2560	1440	3	2	3	3
retrain:0qks4h0pce:3aa0c224d7ea57dd	0qks4h0pce	3838	person	day	large	keyFrame	1920	1080	1	2	1	1
retrain:tm07t59vcp:8c6b5cc702413651	tm07t59vcp	3839	person	day	small	keyFrame	3840	2160	1	2	1	2
retrain:7expv42kxy:be6da83f85c3d596	7expv42kxy	3839	person	day	small	keyFrame	3840	2160	1	2	1	1
retrain:re2m67t10x:08747db20cf85ecc	re2m67t10x	3839	person	day	small	keyFrame	3840	2160	2	1	1	2
retrain:b12gxqxe8x:12e50739175bc44b	b12gxqxe8x	3839	person	day	small	keyFrame	3840	2160	1	2	1	1
retrain:3y4qd8yer0:62c37b7e3055c155	3y4qd8yer0	3839	person	night	mid	keyFrame	3840	2160	1	0	0	1
retrain:naf25vqk1y:a684aea07cbab237	naf25vqk1y	3839	person	day	small	keyFrame	3840	2160	1	0	0	1
retrain:tjvm6a5v5f:db752ba79c0cdee4	tjvm6a5v5f	3839	person	day	mid	keyFrame	3840	2160	1	2	1	2
retrain:rr8qf64f27:a42a04461f4c144c	rr8qf64f27	3839	person	dusk	mid	keyFrame	3840	2160	2	3	2	3
retrain:5cdmr422v4:73d29da645f4474a	5cdmr422v4	3839	person	night	mid	keyFrame	3840	2160	1	2	1	2
retrain:s2gkxzn50c:04e904467ed8a1b3	s2gkxzn50c	3839	person	day	small	keyFrame	3840	2160	3	3	2	4
retrain:qfa0h816cc:d09b65d3ea7de6a2	qfa0h816cc	3839	person	dusk	mid	keyFrame	3840	2160	2	2	2	2
retrain:3wdzqkv4vw:f7847ddb610559bf	3wdzqkv4vw	3839	person	night	mid	keyFrame	3840	2160	2	1	1	2
retrain:km8xyjnv3j:41986e68cd5f547e	km8xyjnv3j	3839	person	day	small	keyFrame	3840	2160	0	0	0	0
retrain:f5vwvsxqcp:f282bd36eb408762	f5vwvsxqcp	3839	person	night	small	keyFrame	3840	2160	1	2	1	2
retrain:gcpar54hvw:7bb97827ac3eb8f0	gcpar54hvw	3839	person	night	mid	keyFrame	3840	2160	1	0	0	1
retrain:xkay5065wt:b908eeb0aa4cc094	xkay5065wt	3839	person	day	small	keyFrame	3840	2160	1	0	0	1
retrain:rec:3839:b62fd012841c2543	zbs6n78kpw	3839	person	day	small	recording	3840	2160	2	2	1	3
retrain:nxyjdc9drj:5e4fd51dca2d2a64	nxyjdc9drj	4263	person	night	large	keyFrame	2048	2048	0	0	0	0
retrain:a3w64xf70x:b62ec3fa5a5a5941	a3w64xf70x	4263	person	night	mid	keyFrame	2048	2048	0	0	0	0
retrain:x8ye0c5d7f:94deda74d7b14278	x8ye0c5d7f	4263	person	night	large	keyFrame	2048	2048	1	1	1	1
retrain:7gqzp6ezqy:508d16885a247386	7gqzp6ezqy	4263	person	day	large	keyFrame	2048	2048	1	0	1	1
retrain:dq4x3rrb5k:8881d1204d641ce7	dq4x3rrb5k	103	vehicle	day	mid	keyFrame	3840	2160	1	2	0	3
retrain:g0dqazb8av:3af7d338f16eea6c	g0dqazb8av	587	vehicle	night	large	keyFrame	3840	2160	0	0	0	0
retrain:cznmve91d3:19d6c7191db67c93	cznmve91d3	104	vehicle	day	small	keyFrame	3840	2160	2	2	2	3
retrain:gv4yb5nwpr:81139251deefb16d	gv4yb5nwpr	104	vehicle	day	mid	keyFrame	3840	2160	4	4	4	4
retrain:497ngs105b:829b06d33203d3ef	497ngs105b	104	vehicle	night	small	keyFrame	3840	2160	0	0	0	0
retrain:9ytk7mtbg5:fe2f8995a655fa01	9ytk7mtbg5	104	vehicle	day	small	keyFrame	3840	2160	3	3	2	4
retrain:98gwqat394:f83cf5131480cdef	98gwqat394	104	vehicle	day	small	keyFrame	3840	2160	2	4	2	4
retrain:qawgxyfe9b:6eb039b5881d2d0f	qawgxyfe9b	104	vehicle	day	small	keyFrame	3840	2160	2	5	2	5
retrain:k54gqctf8f:0926a163870d4b28	k54gqctf8f	104	vehicle	day	small	keyFrame	3840	2160	2	2	2	2
retrain:kddzhher83:13b842650277e4fd	kddzhher83	104	vehicle	day	small	keyFrame	3840	2160	2	0	1	2
retrain:canvjns46f:b466cec0f1f23032	canvjns46f	104	vehicle	day	small	keyFrame	3840	2160	2	4	2	4
retrain:4krpshyks7:55f645ca84bb9a05	4krpshyks7	104	vehicle	day	small	keyFrame	3840	2160	2	2	2	3
retrain:q1jm6q6dm4:8e19515e43ebb575	q1jm6q6dm4	104	vehicle	day	small	keyFrame	3840	2160	3	3	3	3
retrain:tq4se5y65b:00c839fa2ba8e2fa	tq4se5y65b	104	vehicle	day	small	keyFrame	3840	2160	3	0	0	3
retrain:w6w4156ap1:c710cc337e571f38	w6w4156ap1	104	vehicle	day	small	keyFrame	3840	2160	2	4	2	4
retrain:hzsjz4b7n3:0bc05ae072886835	hzsjz4b7n3	104	vehicle	day	small	keyFrame	3840	2160	3	4	3	3
retrain:kfz98xtxjj:eee7a7f6d6f8e82a	kfz98xtxjj	104	vehicle	day	small	keyFrame	3840	2160	1	0	0	1
retrain:ah2p17f7kh:efe696aea92d0edd	ah2p17f7kh	101	vehicle	day	small	keyFrame	3840	2160	1	0	1	1
retrain:csprfybhz0:dad1b673731a4cb5	csprfybhz0	101	vehicle	day	small	keyFrame	3840	2160	1	0	0	1
retrain:aq16fb53r4:9d195305464e18d0	aq16fb53r4	101	vehicle	dusk	mid	keyFrame	3840	2160	1	0	0	1
retrain:4zydjf292p:f6a3937d0ae2f451	4zydjf292p	101	vehicle	day	small	keyFrame	3840	2160	1	0	1	1
retrain:hes4mmy9h9:20e29465b11c6be8	hes4mmy9h9	101	vehicle	day	small	keyFrame	3840	2160	0	0	0	0
retrain:eyt7sec107:c323bb24292a4a92	eyt7sec107	101	vehicle	day	small	keyFrame	3840	2160	3	0	0	3
retrain:12ttavd339:812eca432b2d4eb9	12ttavd339	101	vehicle	day	small	keyFrame	3840	2160	1	0	0	1
retrain:nsbph3avb7:85ca91bb46d64a4d	nsbph3avb7	101	vehicle	day	small	keyFrame	3840	2160	1	0	0	1
retrain:yezjb3kmmz:99b689831e3c9880	yezjb3kmmz	101	vehicle	day	small	keyFrame	3840	2160	1	0	1	1
retrain:3r3hjrscp6:fb5e39cd614d9737	3r3hjrscp6	101	vehicle	day	small	keyFrame	3840	2160	2	0	0	2
retrain:kc09m48c6s:ad4903fd51d979ce	kc09m48c6s	101	vehicle	day	small	keyFrame	3840	2160	1	0	0	1
retrain:rz4d1s6bpr:146b8dded354b286	rz4d1s6bpr	101	vehicle	day	small	keyFrame	3840	2160	1	0	1	1
retrain:t5j3zyyjsw:36102e630a50b5fb	t5j3zyyjsw	101	vehicle	day	small	keyFrame	3840	2160	1	2	1	2
retrain:3d6w92k7c7:c64f3c52489b440e	3d6w92k7c7	101	vehicle	day	small	keyFrame	3840	2160	1	0	1	1
retrain:9x5k2g9dwy:62d720abd6b98d42	9x5k2g9dwy	101	vehicle	dusk	small	keyFrame	3840	2160	1	0	0	1
retrain:vrf6qphytr:5ef4485f73f371c5	vrf6qphytr	101	vehicle	dusk	small	keyFrame	3840	2160	1	2	1	1
retrain:jahnecm5k5:9e319c8749662638	jahnecm5k5	101	vehicle	day	small	keyFrame	3840	2160	1	0	0	1
retrain:8n3rh0vw7r:9829bc0994ff9268	8n3rh0vw7r	101	vehicle	dusk	small	keyFrame	3840	2160	1	0	0	1
retrain:rb06w9fh9j:e1296e9877ac026c	rb06w9fh9j	101	vehicle	dusk	small	keyFrame	3840	2160	1	0	0	1
retrain:9c9q1deycs:d143c4e1b658d47f	9c9q1deycs	101	vehicle	night	mid	keyFrame	3840	2160	1	0	1	1
retrain:kd8r0h9aw2:b6823df6d3ffdb37	kd8r0h9aw2	101	vehicle	day	small	keyFrame	3840	2160	0	0	0	0
retrain:stx9b1wtx3:a97109e2e1adcbad	stx9b1wtx3	101	vehicle	night	small	keyFrame	3840	2160	1	0	1	1
retrain:qveqxj7tmg:b8983f7b7e8f4be4	qveqxj7tmg	101	vehicle	night	mid	keyFrame	3840	2160	1	2	1	2
retrain:g8aaek538p:faac6bd2131d5d52	g8aaek538p	101	vehicle	night	small	keyFrame	3840	2160	1	0	0	1
retrain:btj7dr9s64:bfb7fc5e602d362d	btj7dr9s64	101	vehicle	day	small	keyFrame	3840	2160	1	0	0	1
retrain:3x7781xc8g:4cce111b674cb640	3x7781xc8g	101	vehicle	day	small	keyFrame	3840	2160	1	0	0	1
retrain:naevmerzjp:ffa9b47706b567e3	naevmerzjp	101	vehicle	day	small	keyFrame	3840	2160	1	0	0	1
retrain:0t2jgh074b:9545da1d01ccbe0e	0t2jgh074b	101	vehicle	day	small	keyFrame	3840	2160	1	0	1	1
retrain:k9w3xj8mqs:348a21a598607d03	k9w3xj8mqs	101	vehicle	day	small	keyFrame	3840	2160	1	0	1	1
retrain:0ba7d4mzpd:a1efe34cf3371147	0ba7d4mzpd	101	vehicle	day	small	keyFrame	3840	2160	1	2	1	2
retrain:bwa28a2kts:a54bd6d1b15da868	bwa28a2kts	101	vehicle	day	small	keyFrame	3840	2160	1	0	1	1
retrain:1afz7dxanb:3f9bfdb07babe5c8	1afz7dxanb	101	vehicle	day	small	keyFrame	3840	2160	1	2	1	2
retrain:h31vs6fear:9ab49e197400100b	h31vs6fear	101	vehicle	day	small	keyFrame	3840	2160	2	0	0	2
retrain:a7543vmmnj:eb498565439bceb3	a7543vmmnj	101	vehicle	dusk	small	keyFrame	3840	2160	3	0	0	3
retrain:e35jpshrdk:16ba1d825ab977ca	e35jpshrdk	101	vehicle	dusk	small	keyFrame	3840	2160	1	0	1	1
retrain:d6pse5tjvd:054a7395d1913f84	d6pse5tjvd	101	vehicle	dusk	small	keyFrame	3840	2160	2	0	0	2
retrain:7pd5415v6j:1eaf87a98316b5c3	7pd5415v6j	101	vehicle	night	mid	keyFrame	3840	2160	0	0	0	0
retrain:teqyv2fw6h:c2a6c2d0284d5616	teqyv2fw6h	101	vehicle	day	small	keyFrame	3840	2160	1	0	0	1
retrain:dtgg1cs9dq:cb9c5f72c8544cbf	dtgg1cs9dq	101	vehicle	day	small	keyFrame	3840	2160	2	0	2	2
retrain:m7mdz0mqh4:285ccaba466645fa	m7mdz0mqh4	101	vehicle	dusk	small	keyFrame	3840	2160	1	0	1	1
retrain:0cc1rgj8wn:74d324f8c3869162	0cc1rgj8wn	101	vehicle	dusk	small	keyFrame	3840	2160	2	0	0	2
retrain:zwackfejtm:811f007e9331b128	zwackfejtm	101	vehicle	day	small	keyFrame	3840	2160	3	6	2	6
retrain:8jaczhfada:5ea79edcab3e5063	8jaczhfada	101	vehicle	day	small	keyFrame	3840	2160	1	0	1	1
retrain:j7kby65cnb:5c68dc5552b93b46	j7kby65cnb	101	vehicle	dusk	small	keyFrame	3840	2160	1	0	1	1
retrain:5gzd5wktxy:39c53edfdad34359	5gzd5wktxy	101	vehicle	dusk	small	keyFrame	3840	2160	2	0	0	2
retrain:8p8rsj4aqk:00c539aca5a1e3cb	8p8rsj4aqk	101	vehicle	dusk	small	keyFrame	3840	2160	1	0	0	1
retrain:g73x47v6pg:01dcd184beceab9a	g73x47v6pg	101	vehicle	night	mid	keyFrame	3840	2160	0	0	0	0
retrain:zag01dyw8q:8630e01bf8a9455a	zag01dyw8q	101	vehicle	day	small	keyFrame	3840	2160	1	0	1	1
retrain:we3e96gpa1:ee99347644d363ca	we3e96gpa1	101	vehicle	day	small	keyFrame	3840	2160	1	0	1	1
retrain:4hwk4ee72a:83396a78ed262a1c	4hwk4ee72a	102	vehicle	night	small	keyFrame	3840	2160	3	3	3	3
retrain:tps3218m9f:c64df123595fbf9c	tps3218m9f	102	vehicle	night	small	keyFrame	3840	2160	4	4	4	4
retrain:zz4z0wcsa5:d7fc0e6e9041d1c1	zz4z0wcsa5	102	vehicle	night	small	keyFrame	3840	2160	3	4	3	4
retrain:8bazs0ajsv:f990be87ebb7a057	8bazs0ajsv	102	vehicle	night	small	keyFrame	3840	2160	4	6	4	6
retrain:zswd1bh7ym:7ed83a9b3ae46263	zswd1bh7ym	102	vehicle	night	small	keyFrame	3840	2160	3	3	3	3
retrain:kw0nse1n7s:c018bc4ccad3cc53	kw0nse1n7s	102	vehicle	night	small	keyFrame	3840	2160	3	3	3	3
retrain:jenhh7kqaj:160ad48a86ccdf98	jenhh7kqaj	102	vehicle	day	small	keyFrame	3840	2160	4	4	4	4
retrain:7eg53jck9y:09a0a472ce888f03	7eg53jck9y	102	vehicle	dusk	small	keyFrame	3840	2160	3	3	3	3
retrain:x3nd6rhp5e:7ab6240b553c1918	x3nd6rhp5e	102	vehicle	night	small	keyFrame	3840	2160	3	3	3	3
retrain:92mcfmme4w:ec646568ec420514	92mcfmme4w	102	vehicle	day	small	keyFrame	3840	2160	3	3	3	3
retrain:p9t56njvhr:b5a0942dc5bdd303	p9t56njvhr	102	vehicle	day	small	keyFrame	3840	2160	5	5	5	5
retrain:p1xprva6nb:27eb38bcac16c40d	p1xprva6nb	102	vehicle	dusk	small	keyFrame	3840	2160	5	5	5	5
retrain:bk5bdr0vwk:b1a0ffa15eb2d453	bk5bdr0vwk	102	vehicle	dusk	small	keyFrame	3840	2160	4	4	4	4
retrain:2q4wa85qhm:8c67517fca811c5a	2q4wa85qhm	102	vehicle	night	small	keyFrame	3840	2160	4	4	4	4
retrain:t8ctnfe5rr:eb590459b0d8a04b	t8ctnfe5rr	102	vehicle	night	small	keyFrame	3840	2160	3	3	3	3
retrain:1phf77vq57:42e36d4f8ea27017	1phf77vq57	102	vehicle	day	small	keyFrame	3840	2160	3	3	3	3
retrain:crvhs8ve2c:3b61a5471e014325	crvhs8ve2c	102	vehicle	day	small	keyFrame	3840	2160	2	2	2	2
retrain:r20d7h4ve5:2d02c7e191e3608b	r20d7h4ve5	102	vehicle	night	small	keyFrame	3840	2160	5	5	5	5
retrain:7gan97q72s:4d78d7a6d1190c6e	7gan97q72s	102	vehicle	night	small	keyFrame	3840	2160	3	2	2	3
retrain:5zedp9rrgq:2a216e69ce93ad97	5zedp9rrgq	102	vehicle	night	small	keyFrame	3840	2160	3	3	3	3
retrain:02ch35har4:dbf6b09dcf9f2183	02ch35har4	102	vehicle	night	small	keyFrame	3840	2160	3	2	2	3
retrain:spqprsybsw:82082d803395e68b	spqprsybsw	102	vehicle	day	small	keyFrame	3840	2160	2	1	1	2
retrain:s72fnf01sc:866c9b147c969029	s72fnf01sc	102	vehicle	night	small	keyFrame	3840	2160	3	3	3	3
retrain:svkydfvh74:6ed786e9cf5af989	svkydfvh74	102	vehicle	night	small	keyFrame	3840	2160	3	3	3	3
retrain:7sdt79y8md:7d008083346ad8a7	7sdt79y8md	102	vehicle	night	small	keyFrame	3840	2160	3	3	3	3
retrain:h8ac0taqk4:7e024163ad294a14	h8ac0taqk4	102	vehicle	night	small	keyFrame	3840	2160	4	4	4	4
retrain:m0qxd9dnk0:f0cd83786662dfef	m0qxd9dnk0	102	vehicle	night	small	keyFrame	3840	2160	5	5	5	5
retrain:94mss3xr63:7286a4e7aac81a30	94mss3xr63	102	vehicle	night	small	keyFrame	3840	2160	3	0	0	3
retrain:q5dq4bxmcq:7eadfea39560d2ca	q5dq4bxmcq	102	vehicle	night	small	keyFrame	3840	2160	5	0	0	5
retrain:1njpsaah0j:6ae1b9a21028e990	1njpsaah0j	102	vehicle	day	small	keyFrame	3840	2160	4	4	4	4
retrain:v71p0xg45c:aecfdd22fc403546	v71p0xg45c	102	vehicle	night	small	keyFrame	3840	2160	4	4	4	4
retrain:zggvb3khv6:5275f2052ab389cb	zggvb3khv6	102	vehicle	day	small	keyFrame	3840	2160	4	7	4	4
retrain:rcx1anys33:ade08f06642a958b	rcx1anys33	102	vehicle	night	small	keyFrame	3840	2160	3	5	3	5
retrain:mq7mgdtyrp:ec60e1a78a7476c7	mq7mgdtyrp	102	vehicle	night	small	keyFrame	3840	2160	2	2	2	2
retrain:a6wepvd93z:654583030c033f53	a6wepvd93z	102	vehicle	night	small	keyFrame	3840	2160	1	0	0	1
retrain:d6mw1g9ynd:d43b7abf43b9debe	d6mw1g9ynd	102	vehicle	night	small	keyFrame	3840	2160	2	2	2	2
retrain:081k2zwgh6:7c6536f3bed77e06	081k2zwgh6	102	vehicle	night	small	keyFrame	3840	2160	1	0	0	1
retrain:er0y4h5t4d:bbf86bade010ae86	er0y4h5t4d	102	vehicle	day	small	keyFrame	3840	2160	3	0	0	3
retrain:tnhyyt5trr:b55bbacff171c30b	tnhyyt5trr	102	vehicle	day	small	keyFrame	3840	2160	4	7	4	5
retrain:p0zv5rnts1:ba5df2d141170edc	p0zv5rnts1	102	vehicle	day	small	keyFrame	3840	2160	3	4	3	4
retrain:dm5r06jtg1:f023abb626a06a97	dm5r06jtg1	102	vehicle	dusk	small	keyFrame	3840	2160	4	7	4	4
retrain:dpjrs9pbzr:4efd7fc95e83a5fa	dpjrs9pbzr	102	vehicle	night	small	keyFrame	3840	2160	4	5	4	4
retrain:amgbbmzwjh:8c4b0eb3f7876454	amgbbmzwjh	102	vehicle	night	small	keyFrame	3840	2160	4	4	4	4
retrain:epme7ayzp4:10391aab291ed113	epme7ayzp4	102	vehicle	night	small	keyFrame	3840	2160	4	4	4	4
retrain:7k88qrdyx4:ff150cd6381a2376	7k88qrdyx4	102	vehicle	night	mid	keyFrame	3840	2160	4	4	4	4
retrain:w262ph767e:31545e0e0d590ee4	w262ph767e	102	vehicle	dusk	small	keyFrame	3840	2160	4	3	3	4
retrain:975j176y6z:f19458423c89df93	975j176y6z	102	vehicle	night	small	keyFrame	3840	2160	4	2	1	5
retrain:rdn7s296d9:0e86ddea376ce080	rdn7s296d9	102	vehicle	day	small	keyFrame	3840	2160	2	2	2	2
retrain:r8pvx2ka9c:dbe81b9f7f693b77	r8pvx2ka9c	102	vehicle	day	small	keyFrame	3840	2160	2	2	2	2
retrain:6d65aa9q35:deb66ccd75febd05	6d65aa9q35	637	vehicle	day	large	keyFrame	3840	2160	0	0	0	0
retrain:ma7jt0ps3k:8a08bc85ce958001	ma7jt0ps3k	1439	vehicle	day	mid	keyFrame	3840	2160	2	3	2	3
retrain:h168c7m5n2:4ca3e933b39bfe81	h168c7m5n2	1439	vehicle	day	large	keyFrame	3840	2160	7	9	6	8
retrain:9h859v5363:6826f02f3a65582c	9h859v5363	1439	vehicle	day	mid	keyFrame	3840	2160	4	0	0	4
retrain:z9fr3aky05:919357b189f06b44	z9fr3aky05	1439	vehicle	day	large	keyFrame	3840	2160	2	0	0	2
retrain:jscn9gz9ww:62f9fce57f5bcdaf	jscn9gz9ww	1439	vehicle	day	large	keyFrame	3840	2160	4	0	0	4
retrain:4gxvb3tha5:7c2033c19e1bcd80	4gxvb3tha5	1439	vehicle	day	mid	keyFrame	3840	2160	1	0	0	1
retrain:mjg6s23naf:83d8351bc3c11e9e	mjg6s23naf	1439	vehicle	day	large	keyFrame	3840	2160	1	0	0	1
retrain:kyvjbg8n9k:5a481c9faff02fb7	kyvjbg8n9k	1439	vehicle	day	mid	keyFrame	3840	2160	1	3	1	3
retrain:82jydnnecj:a95a3d6841870b8c	82jydnnecj	1439	vehicle	day	mid	keyFrame	3840	2160	2	3	2	3
retrain:xsvnet7svw:e8cf5bd339916078	xsvnet7svw	1439	vehicle	day	small	keyFrame	3840	2160	2	4	2	4
retrain:fphbahngga:0d6908f5d038c319	fphbahngga	1439	vehicle	day	small	keyFrame	3840	2160	1	3	1	3
retrain:rzmdytbdyq:c899f4eca9b2ba87	rzmdytbdyq	1439	vehicle	day	mid	keyFrame	3840	2160	1	2	1	2
retrain:7j1vas99xe:da3edd20e5d7b059	7j1vas99xe	1439	vehicle	day	small	keyFrame	3840	2160	2	3	2	3
retrain:1a8nn6vv01:248245cac7f39ea1	1a8nn6vv01	1439	vehicle	day	small	keyFrame	3840	2160	1	4	1	3
retrain:my1x03xez9:410c1f12fe1b2f7c	my1x03xez9	1439	vehicle	dusk	mid	keyFrame	3840	2160	0	0	0	0
retrain:mn5tcyj21p:efe03801a7e22208	mn5tcyj21p	1439	vehicle	dusk	mid	keyFrame	3840	2160	1	0	1	1
retrain:m2w2csyygx:10fa5893cfbeaad1	m2w2csyygx	1439	vehicle	dusk	large	keyFrame	3840	2160	0	0	0	0
retrain:9cqns9er3f:dffc0c4a580ccbfe	9cqns9er3f	1439	vehicle	night	large	keyFrame	3840	2160	0	0	0	0
retrain:bpwwj4e0fv:5a4862db393a2133	bpwwj4e0fv	1441	vehicle	night	large	keyFrame	4096	1817	0	0	0	0
retrain:f3mwtb8xw7:d495365b2a5f4f93	f3mwtb8xw7	1441	vehicle	night	large	keyFrame	4096	1817	0	0	0	0
retrain:yenbksgzmq:20800617cc87cf88	yenbksgzmq	1441	vehicle	night	large	keyFrame	4096	1817	0	0	0	0
retrain:vrzangh5dd:da6235d7bcc18d4b	vrzangh5dd	1441	vehicle	night	large	keyFrame	4096	1817	0	0	0	0
retrain:wjngm0tmvx:34c4d345d978d19c	wjngm0tmvx	1441	vehicle	night	large	keyFrame	4096	1817	0	0	0	0
retrain:1w9d0tjwkw:b1d390a3a2553c97	1w9d0tjwkw	1441	vehicle	night	large	keyFrame	4096	1817	0	0	0	0
retrain:679vdzcaqn:cefe607c0746e73b	679vdzcaqn	1441	vehicle	day	small	keyFrame	4096	1817	1	0	0	1
retrain:hybfayyqg4:ab961dc3a1fa8443	hybfayyqg4	1441	vehicle	day	small	keyFrame	4096	1817	0	0	0	0
retrain:z43qatjpfw:432d96efd8408090	z43qatjpfw	1441	vehicle	night	large	keyFrame	4096	1817	0	0	0	0
retrain:xfcgw7k0e3:7c4b0fdd075f7d60	xfcgw7k0e3	1441	vehicle	day	small	keyFrame	4096	1817	0	0	0	0
retrain:85p5w4f058:e36e5d47dded3415	85p5w4f058	1441	vehicle	day	small	keyFrame	4096	1817	0	0	0	0
retrain:6z2pkk8egq:c811dfce916f13e6	6z2pkk8egq	1441	vehicle	day	small	keyFrame	4096	1817	0	0	0	0
retrain:69cka4xh21:94ef7f46bd283e5d	69cka4xh21	1441	vehicle	day	small	keyFrame	4096	1817	0	0	0	0
retrain:jp9a8dkhya:f5c3841a841c59d2	jp9a8dkhya	1441	vehicle	day	small	keyFrame	4096	1817	0	0	0	0
retrain:zsxjnn6907:3ae40a8c5273d0d8	zsxjnn6907	1441	vehicle	day	small	keyFrame	4096	1817	0	0	0	0
retrain:8nxxgkf9g8:ac73810d2f43b78e	8nxxgkf9g8	1441	vehicle	day	small	keyFrame	4096	1817	0	0	0	0
retrain:39zk5chxs4:849689badc045869	39zk5chxs4	1441	vehicle	day	small	keyFrame	4096	1817	0	0	0	0
retrain:gdv4r0j0dy:c0150c5d35dbc050	gdv4r0j0dy	1441	vehicle	day	small	keyFrame	4096	1817	0	0	0	0
retrain:mhc0n8838b:a8a3418548bf41f6	mhc0n8838b	1441	vehicle	day	small	keyFrame	4096	1817	0	0	0	0
retrain:mmrprp9zb7:f6601d9305487eb0	mmrprp9zb7	1441	vehicle	night	large	keyFrame	4096	1817	0	0	0	0
retrain:xg2m7wh57e:3ececd8856289e13	xg2m7wh57e	1441	vehicle	night	large	keyFrame	4096	1817	0	0	0	0
retrain:jfhg51mae1:7e096bd6ac9629df	jfhg51mae1	1441	vehicle	night	large	keyFrame	4096	1817	0	0	0	0
retrain:64sskze3jk:f3f57caccf4d9dc0	64sskze3jk	1441	vehicle	night	large	keyFrame	4096	1817	0	0	0	0
retrain:ew9hw2xy0r:df9ebdb5cf4e5caf	ew9hw2xy0r	1441	vehicle	night	large	keyFrame	4096	1817	0	0	0	0
retrain:d7fmk4ebdj:1d0684e170c4b99f	d7fmk4ebdj	1441	vehicle	day	large	keyFrame	4096	1817	0	0	0	0
retrain:y6zx01xwnp:bc42c8d4e588ebde	y6zx01xwnp	1441	vehicle	day	large	keyFrame	4096	1817	0	0	0	0
retrain:qcpnx00n7w:8d749c492ad2b1cd	qcpnx00n7w	1441	vehicle	night	large	keyFrame	4096	1817	1	0	0	1
retrain:rjtphx9q5y:95ebb4f0b0c8e70a	rjtphx9q5y	1441	vehicle	night	mid	keyFrame	4096	1817	1	0	0	1
retrain:47b3wa8eze:c2ac209beaea84e0	47b3wa8eze	1443	vehicle	night	small	keyFrame	1280	720	0	0	0	0
retrain:a442kcvenp:afcada4b5bace5be	a442kcvenp	3629	vehicle	dusk	small	keyFrame	3840	2160	1	1	1	1
retrain:hmvnj7xtd1:f48ecdc268bfe57c	hmvnj7xtd1	3829	vehicle	night	small	keyFrame	3840	2160	2	1	1	2
retrain:kxq1mypzeq:d7332c118f9c7f08	kxq1mypzeq	3829	vehicle	day	mid	keyFrame	3840	2160	2	0	0	2
retrain:8qzfy69q85:8770e085bfd36dfe	8qzfy69q85	3829	vehicle	day	mid	keyFrame	3840	2160	3	1	2	3
retrain:xqtm3gcfj5:818fe68afab15e76	xqtm3gcfj5	3829	vehicle	day	mid	keyFrame	3840	2160	4	4	4	5
retrain:n98nb0th20:0cddffb694fc01b2	n98nb0th20	3829	vehicle	day	small	keyFrame	3840	2160	3	3	3	3
retrain:hmfrxjj3jj:80f9862d6b89b593	hmfrxjj3jj	3829	vehicle	day	mid	keyFrame	3840	2160	2	2	2	2
retrain:0mgqg7dg1m:566a976bcbe92614	0mgqg7dg1m	3829	vehicle	day	mid	keyFrame	3840	2160	2	2	2	2
retrain:1x6mbqsmf3:47d604b775a75481	1x6mbqsmf3	3829	vehicle	day	mid	keyFrame	3840	2160	2	1	1	2
retrain:4pnxbebyrs:9ab1c6b6b134e3ba	4pnxbebyrs	3829	vehicle	day	mid	keyFrame	3840	2160	2	2	2	2
retrain:s75ttwkehx:3bc9336a3e2ad0ae	s75ttwkehx	3829	vehicle	day	mid	keyFrame	3840	2160	2	2	2	2
retrain:fsj6065tzn:bc75f5e871e4eae1	fsj6065tzn	3829	vehicle	day	mid	keyFrame	3840	2160	3	4	3	4
retrain:6adxt75jrr:d04ba0039415b270	6adxt75jrr	3829	vehicle	day	mid	keyFrame	3840	2160	2	1	1	2
retrain:a5mfzsmjpt:2e984dfd650f036a	a5mfzsmjpt	3829	vehicle	day	mid	keyFrame	3840	2160	2	2	1	3
retrain:q0j8wrs97z:4e0105720c2ba6ce	q0j8wrs97z	3829	vehicle	day	mid	keyFrame	3840	2160	2	2	1	3
retrain:72mvqx017c:913efd57040497b3	72mvqx017c	3829	vehicle	dusk	mid	keyFrame	3840	2160	3	0	0	3
retrain:0tr66yxr95:129f08553db1bcf5	0tr66yxr95	3829	vehicle	day	mid	keyFrame	3840	2160	2	2	2	2
retrain:t0je3dx3mm:86da5882d80837c0	t0je3dx3mm	3829	vehicle	day	mid	keyFrame	3840	2160	2	2	2	2
retrain:eztaern0nn:2f882bed2c41289d	eztaern0nn	3829	vehicle	day	mid	keyFrame	3840	2160	2	2	2	2
retrain:mkvnsf97d2:a9badcfe78cd8db2	mkvnsf97d2	3829	vehicle	day	mid	keyFrame	3840	2160	2	2	2	2
retrain:anzw1vdwa0:13c9316f31a52f99	anzw1vdwa0	3829	vehicle	day	mid	keyFrame	3840	2160	2	2	2	2
retrain:zeq170jbtf:cf6b2e4f2e80ab79	zeq170jbtf	3829	vehicle	day	mid	keyFrame	3840	2160	2	2	2	2
retrain:h3whg42w56:4ed0f3d600f858c2	h3whg42w56	3829	vehicle	day	mid	keyFrame	3840	2160	2	2	2	2
retrain:bkptd01v7w:c2bf987d05cea829	bkptd01v7w	3829	vehicle	day	mid	keyFrame	3840	2160	2	2	2	2
retrain:m75ssy8cka:0761e07045bf791b	m75ssy8cka	3829	vehicle	day	mid	keyFrame	3840	2160	2	2	2	2
retrain:3jd6sv8kjk:88f95f0eaa05122f	3jd6sv8kjk	3829	vehicle	day	mid	keyFrame	3840	2160	3	3	2	5
retrain:b5y1h0n6j6:d7e0ed15dd3196ce	b5y1h0n6j6	3829	vehicle	day	mid	keyFrame	3840	2160	2	2	2	2
retrain:303wbwpb8s:828082ee264085c4	303wbwpb8s	3829	vehicle	day	mid	keyFrame	3840	2160	3	2	2	3
retrain:t60gyqxhvd:49e7cfa075e8d8d8	t60gyqxhvd	3829	vehicle	day	mid	keyFrame	3840	2160	2	1	1	2
retrain:ztr8ckcwgf:a9936dac5424031b	ztr8ckcwgf	3829	vehicle	day	mid	keyFrame	3840	2160	2	2	2	2
retrain:8ztewrnfm9:9caab09af2067d45	8ztewrnfm9	3829	vehicle	day	mid	keyFrame	3840	2160	4	2	1	5
retrain:fbs47dmhkb:da9c388415776c4b	fbs47dmhkb	3829	vehicle	day	mid	keyFrame	3840	2160	3	2	3	3
retrain:jfbnhsmk8f:0d045f2c77aad396	jfbnhsmk8f	3829	vehicle	day	large	keyFrame	3840	2160	2	2	2	2
retrain:4btcawyc37:f34ad4c0386c082d	4btcawyc37	3829	vehicle	day	mid	keyFrame	3840	2160	3	0	0	3
retrain:zk406g8v25:f2e033c99018520f	zk406g8v25	3829	vehicle	dusk	mid	keyFrame	3840	2160	2	1	1	2
retrain:taebjxknws:f9f6bba6895e0e46	taebjxknws	3829	vehicle	dusk	mid	keyFrame	3840	2160	2	2	2	2
retrain:202nysbgz0:95e9e0a03fabe5da	202nysbgz0	3829	vehicle	dusk	mid	keyFrame	3840	2160	2	2	2	2
retrain:69e98w6hp7:453d1dbba0db50c2	69e98w6hp7	3829	vehicle	dusk	mid	keyFrame	3840	2160	2	2	2	2
retrain:3fgkhdgxv9:abea38f1e173dd78	3fgkhdgxv9	3829	vehicle	night	small	keyFrame	3840	2160	3	0	0	3
retrain:dn8x5bd9r1:8037a41ff6441348	dn8x5bd9r1	3829	vehicle	day	mid	keyFrame	3840	2160	2	1	1	2
retrain:dgh2cbs007:6d9aa2c29b38ed64	dgh2cbs007	3829	vehicle	day	mid	keyFrame	3840	2160	2	1	1	2
retrain:bnrns9t4j5:33e1684529896667	bnrns9t4j5	3829	vehicle	day	mid	keyFrame	3840	2160	3	3	2	4
retrain:x6bqzj6n5c:fb0eb1bfa8a97ef5	x6bqzj6n5c	3829	vehicle	day	mid	keyFrame	3840	2160	2	1	1	2
retrain:yk6vrnfv2b:a9aa4f5bfba101de	yk6vrnfv2b	3829	vehicle	day	mid	keyFrame	3840	2160	2	2	2	2
retrain:dvmtjwh7yv:edc7a568ec8038de	dvmtjwh7yv	3829	vehicle	day	mid	keyFrame	3840	2160	2	1	1	2
retrain:qjhch0ty9j:a9ddb55ac8c5580e	qjhch0ty9j	3829	vehicle	day	mid	keyFrame	3840	2160	2	2	2	2
retrain:tkwjk0jn8d:c0abd6eaf20076a5	tkwjk0jn8d	3829	vehicle	day	mid	keyFrame	3840	2160	2	2	2	2
retrain:7nvpm91ay2:69496636224ba8b0	7nvpm91ay2	3829	vehicle	day	mid	keyFrame	3840	2160	2	1	1	2
retrain:d889gadt3z:61f9f71bbede428d	d889gadt3z	3829	vehicle	dusk	mid	keyFrame	3840	2160	3	0	0	3
retrain:bk4t7stphk:10b06ef0269c31b8	bk4t7stphk	3829	vehicle	day	mid	keyFrame	3840	2160	2	2	2	2
retrain:260jwadb08:ef0dbfb2344a8b04	260jwadb08	3829	vehicle	day	mid	keyFrame	3840	2160	2	2	2	2
retrain:2fg045ptw4:4fb6019357c5885a	2fg045ptw4	3835	vehicle	day	mid	keyFrame	3840	2160	0	0	0	0
retrain:x6xzpff7ac:21ce323121877603	x6xzpff7ac	3835	vehicle	day	mid	keyFrame	3840	2160	0	0	0	0
retrain:f8sz92zj6y:ee39edd15a4b5063	f8sz92zj6y	3835	vehicle	dusk	small	keyFrame	3840	2160	1	0	1	1
retrain:7c0gesfebs:b68bc9abab9c9577	7c0gesfebs	3835	vehicle	day	small	keyFrame	3840	2160	0	0	0	0
retrain:j1vezvhrz5:a33417c2bf8c4460	j1vezvhrz5	3835	vehicle	night	large	keyFrame	3840	2160	0	0	0	0
retrain:e7gjkf18s5:34e13da3de82e411	e7gjkf18s5	3835	vehicle	night	large	keyFrame	3840	2160	0	0	0	0
retrain:rmawnet8bw:65279efff83c98b0	rmawnet8bw	3835	vehicle	dusk	small	keyFrame	3840	2160	1	0	1	1
retrain:6qda78v91y:b5da81fb298a386b	6qda78v91y	3835	vehicle	dusk	small	keyFrame	3840	2160	1	0	1	1
retrain:t4e8hznh1t:98308607a68c1728	t4e8hznh1t	3835	vehicle	day	small	keyFrame	3840	2160	1	0	1	1
retrain:ja0v171ce7:dbd2e74e92a36a08	ja0v171ce7	3835	vehicle	day	small	keyFrame	3840	2160	1	0	1	1
retrain:42d52vf22v:7f91b6a91502df16	42d52vf22v	3835	vehicle	dusk	small	keyFrame	3840	2160	1	0	1	1
retrain:57vz0dtkfg:31cb6812987e8439	57vz0dtkfg	3835	vehicle	night	small	keyFrame	3840	2160	1	0	1	1
retrain:t8gcw3mejd:f1269753f8c7ae35	t8gcw3mejd	3835	vehicle	day	small	keyFrame	3840	2160	0	0	0	0
retrain:n7cm28nefn:1f392835abe1515b	n7cm28nefn	3835	vehicle	dusk	small	keyFrame	3840	2160	1	0	0	1
retrain:wdywc67qr4:8a20c76035055cdc	wdywc67qr4	3835	vehicle	dusk	small	keyFrame	3840	2160	1	0	0	1
retrain:0bqxpwcpdg:0618ab47058f8aa3	0bqxpwcpdg	3835	vehicle	night	small	keyFrame	3840	2160	0	0	0	0
retrain:a03amajezs:34d9e68a8369fb7a	a03amajezs	3835	vehicle	night	large	keyFrame	3840	2160	0	0	0	0
retrain:hnyf2q7c45:c01b793afbc1c71a	hnyf2q7c45	3835	vehicle	dusk	small	keyFrame	3840	2160	1	0	1	1
retrain:sp66bmrts5:781fac6e1e31fdcd	sp66bmrts5	3835	vehicle	day	small	keyFrame	3840	2160	1	2	1	2
retrain:xj685f3pjm:97af7d6bf2784eb5	xj685f3pjm	3835	vehicle	night	large	keyFrame	3840	2160	0	0	0	0
retrain:80dpcke1g6:d4ec758dd93d59e2	80dpcke1g6	3835	vehicle	dusk	small	keyFrame	3840	2160	0	0	0	0
retrain:hh16kzt63a:0a75c7d7c6316679	hh16kzt63a	3835	vehicle	day	small	keyFrame	3840	2160	0	0	0	0
retrain:8yac6sq5df:d9d01b047a779bd6	8yac6sq5df	3835	vehicle	day	small	keyFrame	3840	2160	0	0	0	0
retrain:66a8txrmaa:c57424744d536c1b	66a8txrmaa	3836	vehicle	night	large	keyFrame	2560	1440	2	1	2	2
retrain:s88ppfj0r5:88e267e5cb511faa	s88ppfj0r5	3836	vehicle	day	large	keyFrame	2560	1440	1	2	1	1
retrain:9yprfnjpqn:ae17eb92636fc9fb	9yprfnjpqn	3836	vehicle	night	large	keyFrame	2560	1440	2	1	0	3
retrain:6eb96vf2hy:ed6ba1d8a9b57cf6	6eb96vf2hy	3839	vehicle	day	small	keyFrame	3840	2160	5	3	3	5
retrain:97drkx9vam:6025dcc0db63a0fa	97drkx9vam	3839	vehicle	day	small	keyFrame	3840	2160	2	2	2	2
retrain:7fvt0ed7rs:c13820705904f0d5	7fvt0ed7rs	3839	vehicle	night	small	keyFrame	3840	2160	2	1	1	2
retrain:7fzsaeah85:b0091ebc585b3406	7fzsaeah85	3839	vehicle	dusk	mid	keyFrame	3840	2160	3	0	0	3
retrain:9zpk1tcnen:7438a87a923b3901	9zpk1tcnen	3839	vehicle	day	small	keyFrame	3840	2160	4	4	4	4
retrain:pc9d837kmk:c1be5ecc02c6401a	pc9d837kmk	3839	vehicle	day	small	keyFrame	3840	2160	2	2	2	2
retrain:qc8xqnb6wd:1f677515c7ff2a5b	qc8xqnb6wd	3839	vehicle	night	small	keyFrame	3840	2160	2	2	2	2
retrain:7nqq322msr:a73b2cef9af096e9	7nqq322msr	3839	vehicle	dusk	mid	keyFrame	3840	2160	4	4	4	4
retrain:hschnt9bnw:36300f6bd990ae94	hschnt9bnw	3839	vehicle	day	small	keyFrame	3840	2160	3	3	3	3
retrain:6gvsnzcrpd:7275fa445e68ecb5	6gvsnzcrpd	3839	vehicle	day	small	keyFrame	3840	2160	3	3	3	3
retrain:q162rvdmky:9aaa242242abaedc	q162rvdmky	3839	vehicle	day	small	keyFrame	3840	2160	2	3	2	3
retrain:s5sjv27he9:6a93c1a5118310c4	s5sjv27he9	3839	vehicle	dusk	small	keyFrame	3840	2160	3	3	3	3
retrain:032sc1tqwh:b2f2e8a213e33add	032sc1tqwh	3839	vehicle	dusk	small	keyFrame	3840	2160	1	2	1	2
retrain:4328jstt33:0ed8d328fa7c1083	4328jstt33	3839	vehicle	day	small	keyFrame	3840	2160	2	2	2	2
retrain:gk23ad320r:4ef009ad5c2ea294	gk23ad320r	3839	vehicle	day	small	keyFrame	3840	2160	1	3	0	4
retrain:qkec76a53m:cd49f6beb28b6646	qkec76a53m	3839	vehicle	day	small	keyFrame	3840	2160	3	3	3	3
retrain:dhdv136q37:293faa982d4bfb9d	dhdv136q37	3839	vehicle	night	small	keyFrame	3840	2160	3	2	3	3
retrain:ay6mb0w1ev:af3b26f7c5549036	ay6mb0w1ev	3839	vehicle	night	small	keyFrame	3840	2160	2	2	1	3
retrain:62vsm8c4hk:138df7e0e04403f4	62vsm8c4hk	3839	vehicle	dusk	small	keyFrame	3840	2160	3	3	3	3
retrain:x8nyfyxgt5:4a3f1d16d599a470	x8nyfyxgt5	3839	vehicle	dusk	small	keyFrame	3840	2160	3	4	3	4
retrain:9h0kkfh2te:ece41a6c26d60efb	9h0kkfh2te	3839	vehicle	dusk	small	keyFrame	3840	2160	2	3	1	4
retrain:p4a3eq6sxx:6c930e66339ca039	p4a3eq6sxx	3839	vehicle	night	mid	keyFrame	3840	2160	2	3	2	3
retrain:8mfk5xf2ke:6254c92c2a2cf2af	8mfk5xf2ke	3839	vehicle	dusk	mid	keyFrame	3840	2160	2	3	2	3
retrain:3r7e9y5ba0:138c4951d6bbbaf7	3r7e9y5ba0	3839	vehicle	day	small	keyFrame	3840	2160	3	3	3	3
retrain:j1nka5nsgg:341acaf258fe5d55	j1nka5nsgg	3839	vehicle	day	small	keyFrame	3840	2160	4	4	4	4
retrain:d4rrqyyb1y:cec2fbd171c54631	d4rrqyyb1y	3839	vehicle	day	small	keyFrame	3840	2160	4	5	3	7
retrain:dqe09q7w8z:9d98faa8434bf981	dqe09q7w8z	3839	vehicle	day	small	keyFrame	3840	2160	2	0	0	2
retrain:y2aa905dbg:4d67569fcb63258f	y2aa905dbg	3839	vehicle	day	small	keyFrame	3840	2160	3	3	3	3
retrain:bsvnsv7d92:aa229d9cb2aa4b7c	bsvnsv7d92	3839	vehicle	day	small	keyFrame	3840	2160	3	4	1	5
retrain:p97ttm12ga:37d361c08aa26acd	p97ttm12ga	3839	vehicle	day	small	keyFrame	3840	2160	2	3	2	3
retrain:7jgc4m5d3s:ec6eac56cc20ceb3	7jgc4m5d3s	3839	vehicle	day	small	keyFrame	3840	2160	3	2	3	3
retrain:jra771gqtb:c8121d57158c0c19	jra771gqtb	3839	vehicle	day	small	keyFrame	3840	2160	3	4	3	4
retrain:vvdzwkyr7h:d93a62c5872091b3	vvdzwkyr7h	3839	vehicle	day	small	keyFrame	3840	2160	2	2	2	2
retrain:yrt178k0md:887bf54c136acdf7	yrt178k0md	3839	vehicle	day	small	keyFrame	3840	2160	2	3	2	3
retrain:qy8dee6p1r:6f16314c5956e017	qy8dee6p1r	3839	vehicle	day	small	keyFrame	3840	2160	3	3	2	4
retrain:wr5v3ht7gf:dac7d879265da33e	wr5v3ht7gf	3839	vehicle	day	small	keyFrame	3840	2160	3	3	3	3
retrain:qcfm9hpa73:bf70ead4e7b333e5	qcfm9hpa73	3839	vehicle	dusk	small	keyFrame	3840	2160	6	6	6	6
retrain:wj2ceyvnjt:8985d8f3a9c103ec	wj2ceyvnjt	3839	vehicle	dusk	small	keyFrame	3840	2160	4	5	4	5
retrain:n98vb7zbv5:215a647becd218c0	n98vb7zbv5	3839	vehicle	dusk	small	keyFrame	3840	2160	3	3	3	3
retrain:0kwattbwmz:69df740bb95a1810	0kwattbwmz	3839	vehicle	dusk	small	keyFrame	3840	2160	4	4	4	4
retrain:f5k5yevre7:fbbd15e67424f39a	f5k5yevre7	3839	vehicle	day	small	keyFrame	3840	2160	3	2	2	3
retrain:wdq0ayp34t:17f2a1b84c8b2ae6	wdq0ayp34t	3839	vehicle	day	small	keyFrame	3840	2160	2	1	1	2
retrain:2h68jfwre8:0819e3522f335b0b	2h68jfwre8	3839	vehicle	night	small	keyFrame	3840	2160	2	2	2	2
retrain:qwz9bdmvhj:eaede11f83b44c13	qwz9bdmvhj	3839	vehicle	night	small	keyFrame	3840	2160	2	2	2	2
retrain:mrttfxrxa1:4ee1a00c5fa9db6b	mrttfxrxa1	3839	vehicle	day	small	keyFrame	3840	2160	2	2	2	2
retrain:4bpcajd78f:8a048926a70ef8a0	4bpcajd78f	3839	vehicle	day	small	keyFrame	3840	2160	3	3	3	3
retrain:8mq3zx4k8j:883c389bbc3a1804	8mq3zx4k8j	3839	vehicle	dusk	small	keyFrame	3840	2160	2	1	1	2
retrain:v5ehzy2wmz:4b2776a95748e94e	v5ehzy2wmz	3839	vehicle	day	small	keyFrame	3840	2160	4	4	4	4
retrain:vf1hhr59qg:4606a64fc7789d9a	vf1hhr59qg	3839	vehicle	day	small	keyFrame	3840	2160	3	3	3	3
retrain:s01gadveqp:78db7e605a664836	s01gadveqp	3839	vehicle	day	small	keyFrame	3840	2160	2	2	2	2
```

