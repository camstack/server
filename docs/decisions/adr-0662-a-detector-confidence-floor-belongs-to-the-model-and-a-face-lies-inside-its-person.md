---
id: D662
title: A detector's default confidence belongs to the MODEL that runs, the recognizer applies no second face-confidence bar, and a face must lie inside its person
status: accepted
date: 2026-09-27
supersedes:
applies-to:
  - packages/addon-pipeline/src/detection-pipeline/registry/effective-confidence.ts
  - packages/addon-pipeline/src/pipeline-runner/face-parent-geometry.ts
---

Amends [D645](adr-0645-yunet-joins-the-face-catalog-with-its-input-contract-baked-into-every-format.md).

## Context

D645 made YuNet the `face-detection` default on 2026-09-26 at 20:24Z. The step
declared `defaultConfidence: 0.5` — the floor SCRFD had been calibrated at — and
YuNet inherited it. YuNet's score is `sqrt(cls·obj)`, on another scale
(OpenCV's own default is 0.9). The next day ~25–35% of the faces the hub
buffered were not faces: backs of heads, hands, sandals, a vase, bedding, OSD
clock digits, and on camera 102 a car wheel, buffered twice (0.51 and 0.81).
Judged by eye over 70 crops per band, 1074 faces 08:00–15:35Z: junk ~85% at
0.50–0.67, ~70% at 0.67–0.78, ~35% at 0.78–0.84, ~15% at 0.84–0.87, ~10% at
0.87–0.89, ~5% ≥ 0.89. The same window the day before, on SCRFD, was ~5–8%.
Every auto-recognition that day scored ≥ 0.85; the junk drove suggestions and
the best-shot `face-visible` promotion.

What had let it ship: D645 measured RECALL (196/204 COCO faces) and never
false positives on non-face person crops. And there were three places a face
score was judged, none knowing which model produced it:

1. the pool floor, `def.defaultConfidence` — a step constant;
2. the recognizer's `minFaceConfidence` (post-analysis, default 0.5) — a
   second bar on the DETECTOR's score, with no way to know the detector;
3. nothing at all on geometry: the detector sees a PADDED crop of the person
   (`deriveDetailCropRect`), and the wheel sat in that padding — its top at
   y≈419, the person's at y=526.

The interim repair on 2026-09-27 was the only operator lever that existed: the
recognizer's global `minFaceConfidence` set to 0.85 by hand (it gates what
reaches the gallery, not what the detector returns).

## Decision

**A confidence default is a property of the model.** `ModelCatalogEntry`
carries an optional `defaultConfidence`; the DEFAULT is
`model.defaultConfidence ?? step.defaultConfidence`, resolved ONLY in
`registry/effective-confidence.ts`. Every reader of a default goes through it:
the pool floor (`engine-factory`), the slider defaults a step hydrates into its
settings (`getConfigSchema(model)` → `tree-builder`), and `getSchema`, which
now reports each model's floor on its option. `yunet-2023mar` declares 0.85;
`scrfd-2.5g` declares none and keeps the step's 0.5. On a step WITH a threshold
slider the operator's saved value still wins (`tree-builder` merges
`step.settings` over the defaults).

**After D662 there is NO operator control of the face floor.** `face-detection`
has no config schema and its pool floor takes no operator input; the recognizer's
`minFaceConfidence` (below) was the only lever and it is gone. The face floor is
the MODEL's, and changing it is a code change to the catalog entry. A per-device
face threshold is a follow-up (on the producer, see Consequences).

**The recognizer applies no face-confidence bar.** `minFaceConfidence` is
removed from the face settings, the form and the candidate filter, and a stored
value is announced and unset by the retention pass (the D222 procedure). The
other choice — derive the recognizer's bar from the detector that ran — needs
the detector's model id on `DetailResult`: a `@camstack/types` field, codegen,
and a `@camstack/server` release before the hub route stops stripping it, to
buy a number that can only equal the floor the runner already applied (a no-op)
or disagree with it (the defect). A threshold belongs to whoever generates the
event, and the detector's model is known only on the runner.

**A face must lie inside its person.** On the detail plane a detected face
whose CENTRE is outside the UNPADDED parent box is dropped
(`face-parent-geometry.ts`), and each drop is logged per camera, rate-limited
(first at once, then one line per minute carrying the count), tagged
`{ deviceId }` (D391). The centre, not the box: person detectors put the top
edge at the forehead, so a real head straddles it; a subject beside the person
does not.

## Consequences

- **Deploy order** (both runners are `any-node`, so versions can differ per
  node, and a new post-analysis on ANY node purges the GLOBAL interim 0.85):
  1. keep the interim `minFaceConfidence` 0.85 in place;
  2. `addon-pipeline` on the hub AND both agents (every node running
     `pipeline-runner`), verified on disk with the stale-addon detector — then
     no buffered face scores below 0.85 and `face dropped — its centre is
     outside` lines appear with `{ deviceId }`;
  3. only then `addon-post-analysis` everywhere — expect one
     `face confidence bar RETIRED` (wasSetTo 0.85) per node at its first
     retention tick;
  4. `addon-admin-ui` last.
  Never roll back `addon-pipeline` alone while the new post-analysis runs: that
  leaves YuNet at 0.5 with no second bar. Roll post-analysis back first, then
  restore 0.85 from the rollback record, then the pipeline.
- `defaultConfidence` is a new optional field on a `@camstack/types` schema.
  Addons bundle `@camstack/types`; the per-model option field in
  `getSchema` is optional, so an admin UI talking to an older runner falls
  back to the step value.
- There is no face-confidence lever at all now — global, per node or per
  camera. The per-device threshold is a FOLLOW-UP, and it belongs on the
  `face-detection` step (the producer): a `minConfidence` field whose default is
  `getConfigSchema(model)`, applied on the runner, where the executor's
  per-macro gate would already read a `minConfidenceFace` setting on the
  detail plane — not back in the recognizer.
- `runStatelessStep` (bulk work over stored media) does not apply the geometry
  guard: its callers ship boxes they already hold, not live person tracks.
- On the last rung of the crop ladder (a tile the caller cut, `cropJpeg`) the
  guard CANNOT run: the tile's padding is unknown and its mapping anchor is the
  parent box itself. Its faces pass, and a `face geometry guard cannot run`
  warning per dispatch says so (D391).
- **Model replacement checklist, added:** a model joining or replacing a step's
  default is measured for FALSE POSITIVES on stored non-face (non-subject)
  crops of its input class, not only recall, and declares its own
  `defaultConfidence` from that measurement. See
  [detection-execution.md](../architecture/detection-execution.md#a-models-confidence-floor-is-its-own).

## Enforcement

- `detection-pipeline/__tests__/model-default-confidence.spec.ts`: YuNet 0.85 /
  SCRFD none in the catalog; model before step; the pool floor per
  model; slider hydration per model with the operator's saved value winning;
  `getSchema` per-model floors. Each fix disarmed and seen to fail.
- `pipeline-analytics/__tests__/face-recognizer.spec.ts`: a 0.2-score face is a
  candidate (no second bar). `face-settings.spec.ts` and
  `suggestion-band-derived-wiring.spec.ts`: the field is gone and a stored value
  is announced and unset, globally and per device, once.
- `pipeline-runner/__tests__/face-parent-geometry.spec.ts`: the 102 wheel
  geometry is dropped through the real `runDetailSubtree`, a clipped head is
  kept, the drop is never silent, the log is per camera and rate-limited and
  flushes the count it held back when the window closes, and the pre-cut rung
  says it could not judge.
- Nothing mechanical stops a new reader taking `definition.defaultConfidence`
  directly — review only, pointed at by the resolver's header.
