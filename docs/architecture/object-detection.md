---
title: Object detection — thresholds, gating and enablement
last-verified: 2026-10-07
---

# Object detection — thresholds, gating and enablement

Where a detection is filtered, what turns a feature on, and the three
misreadings that have already cost time. Read this before tuning a threshold or
concluding that a detection feature is "not implemented yet". How the pipeline
*executes* — engines, the two planes, per-step device placement, the discard
trail — is [detection-execution.md](detection-execution.md); what happens after
the frame result leaves the process is [post-analysis.md](post-analysis.md),
including tracking — tracklets, a deferred linker, and the parked-object
registry ([D683](../decisions/adr-0683-identity-is-decided-late-tracklets-split-when-in-doubt-a-deferred-linker-fuses-them-and-a-still-subject-belongs-to-the-registry.md)).

## The filter chain, earliest to latest

A box that survives to a notification passed all of these, in order:

| # | Where | Knob | Effect |
| --- | --- | --- | --- |
| 1 | model | its own score threshold | nothing below it is ever returned |
| 2 | `executor.matchesMacroFilter` | `enabledMacroClasses` | class not enabled ⇒ dropped |
| 3 | `executor.matchesMacroFilter` | `minConfidence<Macro>` | score below the macro floor ⇒ dropped |
| 4 | `executor` | `fullFrameGuardMaxConfidence` | near-full-frame LOW-confidence box ⇒ dropped |
| 5 | zone rules | `zoneRules.<stage>` | outside an `include` zone ⇒ not gated in |
| 6 | zone MEMBERSHIP | `zoneMembershipMinOverlap` | too little of the box inside ⇒ the zone is not stamped |
| 7 | notification rule | `minConfidence`, `minImportance`, `minLabelConfidence` | subject below the bar ⇒ no notification |

**Filter as early as the question allows.** Steps 3–4 stop the object
existing. Step 7 stops only the notification: the event still lands in the
database, the timeline, the occupancy counts, and still has media cut for it.
Reaching for the rule-level filter when the detection-level one is the right
answer is the most common mistake here.

## Confidence floors are per macro class, and they are enforced

`minConfidencePerson` / `minConfidenceVehicle` / `minConfidenceAnimal` are
sliders on the `object-detection` step (0–1, step 0.05), set on the
ACCELERATOR that runs the model — never per camera.

**A model is chosen by the accelerator that runs it; a camera only turns steps
on or off
([D927](../decisions/adr-0927-a-model-is-chosen-by-the-accelerator-that-runs-it.md)).**
A step's model and its model-bound floors live in
`agentSettings[node].inferenceDevices[deviceKey].steps[step]`. A camera has two
layers only: `stepToggles` (which steps run) and
`cameraSettings[cam].stepSettings[step]` (`setCameraStepSettings`) for
CAMERA-SEMANTIC fields — an allow-list of classes, a zone-driven option —
merged key by key over the node base on every accelerator
([D754](../decisions/adr-0754-a-camera-step-setting-is-camera-wide-and-field-level-and-a-model-stays-per-accelerator.md)).
`setCameraStepSettings` refuses a model id, a `<key>ModelId` binding or a
`minConfidence*` floor by name, and dispatch drops one a legacy row may still
hold. The rule lives in `@camstack/types` `pipeline/step-settings-layers.ts`
and `isModelScopedStepSettingKey`; `scripts/check-no-camera-model-layer.ts`
keeps the retired per-camera layers out. Per-camera thresholds are a possible
future extension (D927, private planning ideas), not a gap.

**Declared defaults are real defaults.** `tree-builder.collectSchemaDefaults`
hydrates every declared default into the runtime `settings` before the executor
sees them. Do not read `matchesMacroFilter`'s `if (!settings) return true` as
"the default is not applied" — the hydration is upstream, and it exists
precisely because an unhydrated step let ~900 phantom boxes per frame through
in the benchmark.

Global defaults: **person 0.65**, vehicle 0.50, animal 0.50. Person was raised
from 0.50 on 2026-07-30; vehicle and animal are deliberately unchanged because
they have no ground truth. See [the detection-quality plan](../design/2026-07-30-detection-quality-plan.md).

### The floors belong to the model that runs (D738)

Detectors score the same true objects very differently. The median score of a
correct person on this hub was `yolov9m-320-int8` 0.78, `yolo26s-320-int8`
0.68, `yolo26n-320-int8` 0.40 and `yolo26s` (640) 0.89. So since
[D738](../decisions/adr-0738-a-class-confidence-floor-defaults-to-the-running-model-and-an-override-is-bound-to-the-model-it-was-set-for.md)
the global values above are only a fallback:

- **The default is the running model's.** A catalog entry may carry
  `defaultClassFloors` (`{ person, vehicle, animal }`). Since
  [D739](../decisions/adr-0739-the-floor-defaults-are-measured-per-model-every-model-scaled-threshold-binds-and-an-import-brings-its-sources-defaults.md)
  the rows in `model-catalogs.ts` (`OBJECT_DETECTION_CLASS_FLOORS`) are the
  measurement in
  [`docs/benchmarks/model-floors.json`](../benchmarks/model-floors.json),
  and a spec holds the two equal. Each floor is the lowest score at which a
  model makes no more false positives than the old production root did on 409
  hub frames. The live root `yolov9m-320-int8` runs at person 0.65, vehicle
  0.40 and animal 0.45. An unmeasured model runs at the global values.
  `package` is not calibrated. An imported plus catalog model carries plus catalog's
  per-detection `min_score` (0.5), and a plus catalog model carries the plus catalog
  starting values (0.65), unless the import states its own.
- **An override is bound to the model it was set for.** The editor stores
  the value together with a sibling `minConfidence<Macro>ModelId`. The runner
  (`tree-builder`) applies the value only while that model RUNS. "Runs" means
  the resolved variant on the elected device, including an unpinned root's
  hardware-aware default. Under any other model the value is ignored and that
  model's default applies. Nothing is written when the model changes: the
  binding is checked on read, so a dropped event or an unpinned root changing
  defaults cannot leave a stale floor in force.
- **A value with no binding applies to any model**, as before D738. This
  covers values stored earlier, benchmark and replay settings, and the raw
  onboard gate. The next save in the editor binds it.
- **The editor** (the settings panel a step-matrix cell opens, on the node
  Pipeline tab and on the camera's Steps tab, D757) shows the value in force for the viewed
  accelerator's effective model and the layer it comes from — this
  accelerator, this camera, the node, the model default, or an untuned global
  default — with the other levels beside it. It names an override made for
  another model as not applying. It offers "Reset to <next level>" per field,
  and "Reset thresholds to model defaults" for the edited layer in one write.
- **The same binding covers every threshold on a model's scale:** the
  animal, vehicle and bird classifiers' `minConfidence` and
  `minConfidencePackage`. Plate and face detection have no operator threshold
  (D662).


Switching A → B → A with no edit on B brings A's override back, because it is
still stored and bound to A.

Reading the floor a camera actually ran with: the root model is on every
frame result (`rootModelId`), and the floor in force is that model's row or
the bound override.

**A box under the floor is not thrown away whole.** It stays on
`FrameResult.discarded` (`below-threshold`), is counted per class and score
band on the `pipeline stats` line (`belowFloor`), and a person/animal box at or
above the tracker's `lowScoreContinuationFloor` (0.35) may keep an already
confirmed track alive — never open one, never produce an event, a notification
or media ([D665](../decisions/adr-0665-a-box-under-the-class-floor-may-continue-a-track-and-do-nothing-else.md)).
The floor still decides everything an operator sees; it no longer decides
whether a subject the detector is unsure about keeps its id.

## Enablement follows configuration

**When a feature has a configuration surface, that surface is the switch.**

Package detection shipped behind `packageDropEnabled`, an opt-in defaulting to
false. A camera could have the zone, an enabled `package`-stage zone rule
pointing at it, and a notification rule on `delivery: 'package-event'` — and
produce nothing, because a boolean that none of those three surfaces mentions
was false. That is not "the feature is off", it is silence that reads exactly
like a broken feature.

`packageDropEnabled` now defaults to **true** and means only "force this camera
off". The `package`-stage zone rule is the enabling configuration.

A separate boolean beside a configuration surface is a second source of truth.
If you find another one, it is a bug, not a design.

## What a zone-scoped rule actually tests

A notification rule's `zones` condition is a **plain set-membership test** over
the zone ids stamped on the event. So whatever decides that stamping decides
whether the rule can fire — not the zone RULE's `bboxInclusionPct`, which gates
the DETECTION stage and is a different question entirely.

Two functions look interchangeable and are not:

| Function | Used by | Rule |
| --- | --- | --- |
| `zoneEngine.annotateDetection` | the LIVE stamping → `event.zones` | overlap > `zoneMembershipMinOverlap` |
| `positionsIntersectZone` | the spatial filter on `listTracks` QUERIES | centroid-in-polygon (polygon zones) |

Reading the second as if it governed notifications produced two wrong
conclusions in one session.

The overlap metric is **intersection ÷ the DETECTION's own area**, which has a
consequence worth internalising: a near-full-frame box scores LOW against a
small zone, not high. Measured on device 101 — a `vehicle` box covering 94.4% of
the frame scored 0.156 against `Uscio` and 0.078 against `Aiuola`. Raising the
membership bar is therefore a lever against full-frame phantoms polluting
zone-scoped rules.

`zoneMembershipMinOverlap` defaults to **0** — any positive overlap counts,
byte-identical to the behaviour before 2026-07-31. That default is why a
delivered "Persona su Uscio" notification came from a subject overlapping
`Uscio` by 6.2% while sitting geometrically inside `Aiuola`: the zone NAME in
the body was wrong too. Every stamped event now logs its per-zone `overlapPct`
(`zone membership stamped on event`), so the bar can be chosen from the
distribution rather than guessed.

**Set it from the Detection pipeline → Tracking form, never from the raw
settings router.** The field shipped without a form entry, and the raw route an
operator then reached for (`addonSettingsRaw.updateDevice`, deleted since D675) wrote
`addon-device-settings` — a different sqlite table from the
`<addonId>:addon-devices` collection a FORKED addon reads. The API answered
`0.1` while the running pipeline read `0` and logged it on every stamped event.
A guard now fails the build when a `TrackingSettingsSchema` field has no form
entry, because the missing UI is what steers you into the wrong store. The
guard covers ONLY that schema — `packageDropClassFilter` and `cropPadding` are
equally form-less and equally silent today (they are post-analysis settings, not
pipeline-step config, so the step's `getConfigSchema()` cannot reach them). And there is **no global→device
cascade** anywhere in these settings: an unset per-device key falls back to
the schema default, never to the operator's global value (several settings
modules' docblocks claim otherwise; `readDeviceStore`'s contract is the
truth). Both verified 2026-08-02 — details in
[post-analysis.md](post-analysis.md#the-knob-map--which-surface-writes-what).

## Occupancy COUNTS, and that gives it two rules of its own

Both of these read from the outside as "the feature is not implemented".

**Parked zone membership is the same path as live**
([D702](../decisions/adr-0702-parked-zone-membership-uses-the-same-engine-and-bar-as-live.md)).
A stationary registry entry never flows through the FrameProcessor, but
`computeStationaryEntryZones` still calls `ZoneEngine.annotateDetection` with
`zoneMembershipMinOverlap`. Centroid point-in-polygon for parked objects is
retired — a car mostly inside a bay must not flap when the box jitters across
the polygon edge. Hydration, the occupancy census, and the package-drop zone
gate share that adapter; there is no parked-only threshold.

**A class scope may only be a MACRO class** ([D135](../decisions/adr-0135.md)).
The zone snapshot's `byClass` is macro-keyed, so a rule scoped to `car` names a
key that does not exist and counts 0 on every frame, forever — two live rules on
device 102 shipped that way. Occupancy is the ONE class condition the engine
does not put through `expandClassSelector`: matching may widen (a `car` IS a
`vehicle`), counting may not. Which surfaces enforce it, and the log line that
reports an uncountable key, are in
[notifications.md](notifications.md#the-occupancy-class-scope-is-macro-only-d135).

**The periodic re-check is ON by default, at `occupancyRecheckSec` = 300 s**
([D136](../decisions/adr-0136.md)). A stationary object is counted only while the
stationary registry holds it, and that registry rebuilds FROM MOTION — so
without the re-check a parked car is invisible to every occupancy rule until
something moves in front of it. 30 s was tried on 2026-08-13 and reverted the
same evening: the timer is armed on every `on-motion` camera whose last session
closed with detections still in frame — not only on the cameras a rule watches —
and 19 cameras × 4 frames every 30 s starved the decode path. 300 s per camera,
with a narrower value available as a per-camera override, is the shipped answer.

Two things about changing it:

- 300 is also the schema `max`. Changing a DEFAULT ships with an addon deploy;
  widening a BOUND is train-bound, because the host validates `attachCamera`
  against its own copy of the cap schema even though the orchestrator is what
  sends the value.
- `occupancyRecheckEnabled` has a default in TWO places — `.default()` in
  `pipeline-runner.cap.ts` and a fallback in
  `device-detection-settings.ts`'s `resolveDetectionSettings`. The second is the
  effective one. Flip only one and the UI and the runtime disagree.

## A step can take its result from the root model

Since [D730](../decisions/adr-0730-a-step-takes-its-result-from-the-root-model-when-its-flag-is-on-and-the-current-root-declares-it.md)
every root detection model declares which steps its own output can supply —
`animal-classifier`, `vehicle-classifier` and `package-detection` from its
labels, `plate-detection` and `face-detection` from `license_plate` / `face`
boxes — derived from its labelmap (`deriveRootSupplies`), with no exemption for
COCO. A step uses it when its `useRootModel` flag is on (default on for the
label steps, off for plates and faces) AND the camera's current root declares
it: `resolveRootSupply`, the one function the runner, the detail dispatcher and
the step editors share. The flag never touches the step's model; with a root
that cannot supply the step, the step runs its own model and the editor shows
the flag as inactive.

Since [D736](../decisions/adr-0736-the-animal-and-vehicle-classifiers-are-on-by-default-sourced-from-the-root-and-the-supply-follows-the-camera-gate.md)
the animal and vehicle classifiers are **enabled by default** (catalog
`enabledByDefault: true`) with the root as their source: a root that declares
them names animals and vehicles at no extra inference, a root that does not
leaves the enabled classifier running its own model. `package-detection` stays
zone-driven. A root supplies only a step the camera RUNS — a step gated off by
`stepToggles` has no supply state at all — and the runner judges the root the
elected device really runs (an unpinned root is the device's hardware-aware
default, never the flat `yolo26n`). The step editors and both matrices read the
node layer under the device's own entry (`effectiveStepSettingsForDevice`, the
mirror of `nodeDeviceBase`, D927), because that is what a session is
provisioned with.

Three consequences that read as bugs if you do not know them:

- **A camera on a CamStack COCO root does not dispatch the animal or vehicle
  classifier.** Both are on, and its `dog` / `bus` come from the detector at
  the detection's score; `deer`, `Van` and friends are not produced there. The
  runner logs `root model supplies a pipeline step` once per (camera, step).
- **A root-supplied species has its own floor**
  ([D741](../decisions/adr-0741-a-root-supplied-fine-label-has-a-floor-per-root-model-and-the-face-embedding-keeps-its-own-gate.md)).
  The floor is on the DETECTION score, per root model (`suppliedLabelFloors`):
  0.75 on `yolov9m-320-int8`, and never on the Coral SSD. Below it the
  detection is just `animal`. The animal classifier's `minConfidence` slider
  governs it, bound to the ROOT model. Vehicle types have no extra floor. Face
  detection (YuNet) runs at 0.70, and the face embedding keeps a separate 0.85
  gate (`defaultMinParentScore`).
- **A classifier gated off is not "supplied".** No `filledBy`, no log line, and
  the root's fine label stays the executor's score-0 fallback.
- **A root plate or face is a detail of its parent, never a track.** A plate
  goes to the plate reader with an uncalibrated root-box margin
  (`ROOT_SUPPLIED_PLATE_MARGIN_FRACTION`). A face is only a location: the face
  detector re-finds it in a 1.6× square at an effective 160 px input and only
  that face, with landmarks, is recognised — and only from a root whose input
  is 640 px or more ([D731](../decisions/adr-0731-a-root-face-is-re-found-in-its-own-square-before-recognition-and-only-from-a-root-that-sees-640.md));
  a 320 px root shows the face flag inactive.

### A seg root supplies the segmentation step's masks

[D737](../decisions/adr-0737-a-yolo26-seg-root-supplies-the-segmentation-step-from-its-own-masks.md)
adds a third kind, `mask`. The YOLO26-seg builds (`yolo26n/s/m-seg`) are
object-detection models (family `yolo26-seg` in the picker), whose `yolo-seg`
decode emits a mask with every detection. Such a root declares `segmentation`,
on top of the COCO label supplies. With the step on and its flag on (the
default), the runner drops `segmentation` from the frame dispatch
(`root-mask-supply.ts`). The root's mask then becomes the detection's mask,
and its `refinedBbox` comes from the mask's largest component, so every
consumer reads the shape U2-Net produced.

Things that look like bugs:

- **A seg root's boxes come from the same code as the detector's.**
  `yolo_seg.py` calls `yolo.py`'s decode, but the seg model is a different
  network from yolo26n, so a few detections differ.
- **The masks are coarse.** They sit on the model's 160-cell grid, cropped
  to the box.
- **With Segmentation off, a seg root's masks are stripped by the runner.**
  They still cost about 1–2 ms per frame to decode.
- `instance-segmentation` is a dormant step. The live mask step is
  `segmentation`.

## Package detection has its OWN step

Packages do **not** flow through `object-detection`, and its
`enabledMacroClasses` does not gate them. There is a dedicated detector step:

```
package-detection · slot: detector · extractMode: crop-zone
outputClasses: ['package'] · model: rfdetr-package · enabledByDefault: false
```

It is a `crop-zone` root step with its own settings and its own model.
`rfdetr-package` has been the default since 2026-08-07, superseding
`yolov8n-package` of 2026-07-17 on measured separation; it ships onnx / coreml /
openvino, so `getDefaultModelForFormat` resolves it on every node in the fleet
except `tflite`/edgetpu, where a DETR head does not compile — and where the
previous default had no build either, so nothing regressed. Concluding that a
missing `package` in the generic detector's `enabledMacroClasses` explains a
silent package feature is wrong — check the resolved pipeline for the step
itself (`pipelineOrchestrator.resolvePipeline` lists it) and the model on the
node.

The COCO `suitcase`/`backpack`/`handbag` → `package` proxies in
`coco-classmap.ts` belong to a DIFFERENT route (a generic model standing in for
a parcel model); they are not what the dedicated step uses. **Since 2026-08-19
the root step no longer OFFERS `package` at all.** It could only ever produce
that proxy, so an operator ticking the root box turned the proxy on and left the
real detector off, silently — and the root's own `minConfidencePackage` slider,
gated on `includes: 'package'`, went with it. The offer is what was removed: the
label map, `COCO_TO_MACRO` and the dedicated step are untouched, and a camera
that already stored `'package'` in `enabledMacroClasses` behaves exactly as
before.

**Its enablement is the zone rule, and NOTHING else.** `enabledByDefault: false`
is a catalog default the per-camera `stepToggles` gate deliberately skips;
`applyPackageZoneActivation` (`pipeline-resolver.ts`) is the sole authority —
an enabled `package`-stage zone rule with ≥1 zone appends the step as an
enabled root, and its removal strips it. There is no operator toggle, and adding
one would be a second source of truth beside the zone rule.

That makes the "does this camera have a package zone" read load-bearing in the
destructive direction, so it does **not** go straight to the store.
`PackageZoneGate` (`package-zone-gate.ts`) mirrors the answer per device:
a read that FAILED leaves the mirror untouched and keeps the last-known-good
answer (warn, `tags: { deviceId }`), and a read that succeeded but is empty for a
camera the mirror had as zoned ARMS the strip and needs a second consecutive
agreeing read to apply it. `listRules` folds a read error into `[]`, which is
indistinguishable from "the operator deleted the zone" — the same shape as the
doorbell that rang 0/3 ([D49](../decisions/adr-0049.md)). A camera never read
successfully stays OFF: packages are opt-in.

**The confidence floor is per-camera, and it is `minConfidencePackage`.** The
step's slider key is not free — `macroFilterVerdict` builds
`minConfidence${capitalize(macroClass)}` at runtime, and this detector's boxes
carry `macroClass: 'package'`. The default is 0.5, which is where it has always
been; before 2026-08-07 there was no schema at all, so the floor was unreachable
from any surface while a doormat scored 0.5669 on camera 101. A step that
declares such a slider must also be in `engine-factory.ts`'s
`PER_MACRO_REFILTERED_STEP_IDS`, or the pool's own floor pre-empts every
position below the default —
`packages/addon-pipeline/src/__tests__/guards/per-macro-slider-reaches-the-pool.guard.ts` fails the build otherwise.

## The package-drop gate chain

`PackageDropDetector.onAppeared` returns early unless ALL hold. **Every one of
them logs its rejection** with `tags: { deviceId }` (gate 1 at debug, the rest
at info) — before 2026-08-14 all five were silent, which is most of why the
chain was unfalsifiable:

1. `packageDropEnabled` (default true — an explicit per-camera OFF). Logged on
   the TRANSITION only, or every parked car on the camera would log it.
2. class ∈ `packageDropClassFilter` (default `['package']`)
3. at least one **enabled `package`-stage zone rule**, and the entry's centroid
   inside one of its zones
4. seen on ≥ `packageDropMinFrames` frames (default 3) **and** stationary for
   ≥ `packageDropDwellSec` (default **0** s — N frames is the FP bar; dwell is
   an extra operator bar)
5. bbox area ≥ `packageDropMinBboxAreaFrac` (default 0.004 of the **zone crop**
   the package step uses — full frame when there is no crop — [D929](../decisions/adr-0929-a-package-candidate-opens-from-raw-boxes-on-governor-looks-and-min-area-is-zone-crop.md))
   and ≤ `packageDropMaxBboxAreaFrac` (default 0.04 of the **full frame** —
   [D205](../decisions/adr-0205-a-package-has-a-plausible-size-and-a-deliverer.md))

Both ends of gate 5 are MEASUREMENTS, not guesses. The recurring `package`
boxes this install has ever produced are on 101 and occupy **0.0796–0.0947 of
the frame** — and 348/350 of them were ONE static object, the streetlight's
light wedge on the granite paving (a commit had mislabelled it "the doormat").
The wedge scores up to 0.877; the one true parcel measured scored 0.885, so
CONFIDENCE cannot separate them — AREA does: real parcels measured **0.0114
and 0.0172**, an A5 flyer estimates at **≈0.010**. The 0.04 ceiling sits ~4×
above every real parcel and ~2× below the smallest wedge.

The stillness path applies the same **maximum** (full-frame) ceiling on looked
frames (`package-look-sightings.ts`), promotes only candidates whose
first sighting was preceded by non-package activity **in a configured
package drop-off zone** within `packageDropActivityWindowSec` (default
300 s — a parcel needs a deliverer; a walker at the far gate does not
count), treats an unwitnessed disappearance as detector loss rather than a
pick-up, and suppresses positions with repeated ghost delivered→vanished
cycles
([D206](../decisions/adr-0206-a-position-that-delivers-itself-is-background.md)).
An unpromoted candidate that expires logs WHY (hits / dwell / no-activity).

**How the detector is fed.** Two producers, one contract:

| Producer | Promotes when | For |
| --- | --- | --- |
| `StationaryObjectRegistry` | repeated sightings in the same place: N≥8 agreeing, N/M≥0.6, span≥120 s ([D264](../decisions/adr-0264-an-object-becomes-stationary-by-repetition-not-by-one-track-surviving.md); was 4 positions in 30 s) | parked cars |
| `PackageStillnessTracker` | N sightings (default 3), raw boxes on looked frames, IoU across looks | packages |

The dedicated path exists because the generic criterion was **arithmetically
unreachable** at governor cadence ([D144](../decisions/adr-0144.md)) and because
package tracklets die between looks while the step still sees the box ([D929](../decisions/adr-0929-a-package-candidate-opens-from-raw-boxes-on-governor-looks-and-min-area-is-zone-crop.md)).
The relation is a build guard (`scripts/check-package-promotion-satisfiable.ts`).

One governor **look** is one hit when the step ran. A settle burst must contain
enough looks for `packageDropMinFrames`; the poll-only path still needs
`(minHits − 1) × pollIntervalMs < TTL`. Dwell default is 0 so N sightings is
enough when activity is present.

**When the detector runs at all.** A settle edge of motion NEAR the package
zones opens a BURST of 5 runs, 5 s apart; the 45 s poll is the safety net for a
parcel whose motion was never observed. With dwell 0, a courier who drops and
leaves in ~2 s still delivers if the settle session sees the box three times.
A complaint of MINUTES means the burst never opened (grep
`package-detection dispatched by the motion-settle governor` and check its
`reason`).

**When a pick-up is concluded.** A promoted parcel departs once it has been
unseen for `PACKAGE_STILLNESS_TTL_MS` (300 s), with somebody in the drop-off
zone at or after its last sighting (otherwise it is detector loss, not a
pick-up). Two things end that wait:

- **The next frame.** `observe` judges the TTL on every pipeline frame. The
  first frame after a silence always runs the governor's poll (it is due after
  300 s), so a parcel still on the doormat is re-sighted before its expiry is
  judged. That look is why silence never concludes anything.
- **The sweep, since 2026-09-30.** The analytics' existing 5 s TTL tick asks
  `PackageStillnessTracker.sweep` for the same TTL without a frame, but it
  concludes ONLY a parcel carrying at least **two absence reads** since its
  last sighting, and only when the most recent look was one of them. An
  absence read is a frame on which the package step LOOKED
  (`FrameResult.packageLooked`, stamped by the runner from the governor's
  decision; recorded on tapes as `pl`) and returned no package box at that
  place, with no person or vehicle box over it. The package box is judged on
  the step's RAW output (kept and below-threshold boxes), never the tracker's:
  a raw box there is a presence and clears the reads. Throws are caught per
  device and named `package stillness sweep threw`. A parcel nobody looked for since is left for
  the next frame's look. On 101, 2026-09-30, the frame path held a pick-up 29 s
  past its TTL, waiting for the next analysed frame. The departure line says
  `via: sweep` or `via: frame`.
- **Early, on positive evidence, per camera opt-in**
  ([D687](../decisions/adr-0687-a-pick-up-is-concluded-early-only-on-positive-evidence.md),
  `packageDropEarlyPickupEnabled`, default **off**). The parcel is concluded
  gone before its TTL when there are three absence reads spanning at least
  10 s and somebody was in the drop-off zone around the disappearance. A
  re-sighting clears the reads. The departure line says `rule: early` or
  `rule: ttl`. The rule is off by default because the only pick-up the
  retained data could replay (101, 2026-09-30) is one sample: it would have
  concluded at 15:23:42 instead of 15:28:36, with no false departure.
The registry's own knobs are in
[post-analysis.md](post-analysis.md#the-knob-map--which-surface-writes-what).

**A `package-delivered` event now carries the DETECTOR's confidence.** It was a
fixed `1` until 2026-08-14, which made step 7's rule-level `minConfidence` a
no-op on every package event — an operator had no lever at all against a
recurring false positive. `importance` stays fixed at 1, and the
`package-picked-up` event still carries a fixed confidence: a pickup is a
disappearance, and the score of the box that is no longer there says nothing.
Both levers matter now that the chain fires, because the first thing it fires on
is 101's doormat, which RF-DETR scores **0.53–0.60** — above the 0.5
`minConfidencePackage` floor. Calibrate the pair from a drop test, not from this
page.

## YOLOv9 on a Coral: offered in the catalog, mirrored on our Hugging Face repo

The community YOLOv9-s compiled for the Coral (`yolov9s-320-edgetpu`,
`yolov9s-512-edgetpu`) is a catalog entry like any other detector, under the
D661 record `DBRO_YOLOV9_EDGETPU_GPL`: weights GPL-3.0 (fine-tuned from
WongKinYiu/yolov9's GPL-3.0 checkpoint on 17 COCO classes), and
`hosting: 'camstack-hf'` — the publisher's release files are mirrored
byte-identical on `camstack/camstack-models` (`objectDetection/yolov9/tflite/`),
with the corresponding source (the fine-tuning checkpoint and notebooks) in
`source/yolov9-edgetpu-dbro/`, pinned by sha256. It is
the Coral default (D908) and Auto tune sizes an enabled Coral at it (D912). Layout and decode:
[detection-execution.md](detection-execution.md#yolov9-on-a-coral-a-catalog-entry-decoded-by-yolo-split-dfl).
Its confidence floors are the stock defaults until measured.

## Misreadings, all of which happened

**"The comment says the provider does not exist yet."**
`resolveDevicePackageRules` carried a docblock stating that the `package` slice
"is written by the orchestrator's package-stage provider (a later slice); until
then this returns `[]` and no package events fire". It was stale. The
`zone-rules` capability with a `package` stage is live, and the camera in
question already had a rule. **Query the cap; do not trust a comment about
whether something exists.**
`zoneRules.listRules({ deviceId, stage: 'package' })` answers it in one call.

**"The per-device setting is not stored, so it is unset."**
Per-device addon settings live in `ctx.settings.readDeviceStore`, exposed as
`addonSettingsRaw.getDeviceOverrides({ addonId, deviceId })` — with `deviceId`
as a **string**. They are NOT on the `deviceManager.getDevice` record. Checking
the device record and finding nothing proves nothing.

**"The rule has no class filter, so it fires on everything."**
Rule conditions are not the whole rule. A notification rule also carries
`delivery`, and `delivery: 'package-event'` scopes it to package events on its
own. Print the whole rule before concluding what it matches.

**"A full-frame box satisfies every zone, so no membership bar can stop it."**
Backwards. The overlap is a share of the DETECTION's area, so a full-frame box
scores LOW against a small zone — see the table above for the measured values.

**"The guard is not armed, which is why phantoms survive."**
The full-frame guard runs on every frame with a built-in 0.70 bar and needs no
configuration; `fullFrameGuardMaxConfidence` is an override, not a switch. Its
real defect was that its drops were invisible (a `console.log` behind a
verbosity flag). Six full-frame `vehicle` boxes at 94.4% of the frame scored
0.710–0.787 in one day and passed the bar legitimately; those SURVIVORS are now
logged, which is the number an operator needs before arming the per-camera
score-independent area cut (`fullFrameGuardHardAreaRatio`, off by default).

## Two silent detection failures now have a name (2026-08-14)

Both are `NcSystemEventKind` members, so a notification rule carrying
`conditions.systemEvent` can be authored on either. They exist because no
liveness signal can express these states — the device, the stream, the node and
the pipeline watchdog all stay green throughout.

| kind | fires when | the test it deliberately is NOT |
| --- | --- | --- |
| `detection-blind` | the camera MOVED — at least 10 min of detection-session time over at least 3 sessions since the detector last produced anything — a fresh frame was analysed, and no frame carried a detection **or a below-floor candidate** ([D907](../decisions/adr-0907-a-camera-is-blind-only-when-it-moved-and-the-detector-produced-nothing.md)) | wall time. The first version counted 60 idle minutes and raised 122 alerts in 3 days, none of them blindness: quiet cameras, constant motion, and floor-filtered candidates. No known motion source (a standing camera) classifies nothing. |
| `motion-noisy` / `motion-calm` | over a rolling hour with zero detections, session time covers at least 25% of it or at least 40 sessions opened; calm when both fall to 80% of the bar or a detection arrives | blind. The detector is fine, the motion zones or sensitivity want tuning. |
| `node-inference-unavailable` | every accelerator the operator ENABLED on a node is unavailable, so the node is dropped from placement | "zero eligible devices" — a CPU-only node has zero and is healthy |

`DetectionBlindMonitor` is fed from `handleInferenceResult` on EVERY frame
(detections AND the `discarded` tally, empty ones included), from the session
registry's open/close edges in-process (an in-memory mirror, D49), and swept on
the existing pending-retry tick rather than a timer of its own.

Excluding a node STRANDS cameras, so `NodeInferenceUsabilityMirror` treats the
unusable direction as destructive, in [D49](../decisions/adr-0049.md)'s shape: a
node never observed is usable, an unusable observation is ARMED and needs a
second consecutive one to apply, and one usable observation restores it
immediately. Recovery is deliberately asymmetric and emits no event.
agent-a absorbed 283k errors in a day in the state this now reports.

## Correlating a notification back to its detection

Since 2026-07-31 the NC verdict lines (`rule matched — enqueueing`, the
cooldown skip, the failed-condition line) carry `eventId` and `trackId` — see
[notifications.md](notifications.md#tracing-a-delivered-notification-back-to-its-detection).

When you query events by hand: `pipelineAnalytics.getObjectEvents` takes
`since` / `until`, **not** `fromMs` / `toMs`. Passing the wrong names does not
error — it silently returns the most recent N rows, which reads like a valid
window and is not one.

## Track-level vs event-level

A rule fires on the FIRST qualifying event, not the best one of the track. A
weak opening detection therefore notifies even when the track later earns a
confident one — and a track whose ONLY event is weak is the signature of a
phantom.

Worth remembering when reading a false positive: check the whole track's scores,
not just the one that fired. On the 2026-07-30 incident the track had eight
positions and a single event at 0.5005.
