/**
 * Pipeline step classes — each step implements IPipelineStep.
 *
 * `definition` holds the static metadata (models, labels, postprocessor, etc.).
 * `getConfigSchema()` declares per-step settings (class filters, thresholds)
 * that the UI renders dynamically and that can be overridden per-run.
 */
import type {
  ConfigField,
  DetailStepAnnounce,
  IPipelineStep,
  ModelCatalogEntry,
  ModelFormat,
  StepDefinition,
} from '@camstack/types'
import {
  AUDIO_MACRO_LABELS,
  audioKindId,
  COCO_80_LABELS,
  COCO_TO_MACRO,
  LABEL_SUPPLY_VOCABULARIES,
} from '@camstack/types'
import { resolveModelDefaultConfidence } from './effective-confidence.js'
import { DEFAULT_LANDMARK_PRECISION_FLOOR_PX } from '../pipeline/landmark-precision-gate.js'
import {
  ANIMAL_CLASSIFIER_MODELS,
  AUDIO_CLASSIFIER_MODELS,
  BIRD_CLASSIFIER_MODELS,
  CLIP_EMBEDDING_MODELS,
  FACE_DETECTION_MODELS,
  FACE_EMBEDDING_MODELS,
  INSTANCE_SEGMENTATION_MODELS,
  OBJECT_DETECTION_MODELS,
  PACKAGE_DETECTION_MODELS,
  PLATE_DETECTION_MODELS,
  PLATE_OCR_MODELS,
  SEGMENTATION_REFINER_MODELS,
  VEHICLE_CLASSIFIER_MODELS,
} from './model-catalogs.js'

// ---------------------------------------------------------------------------
// Label arrays for softmax-based classifiers (loaded into Python pool config)
// ---------------------------------------------------------------------------

// Legacy `animals-10` logit order — retained as the `def.labels` fallback for
// that (now legacy) model, which ships no `-labels.json` (the new models do).
const ANIMAL_10_LABELS = [
  'cat',
  'cow',
  'dog',
  'dolphin',
  'eagle',
  'giant panda',
  'horse',
  'monkey',
  'sheep',
  'spider',
] as const

// PRIMARY `animal-classifier` logit order (Open Images V7, 8 classes) and the
// vehicle classifier's emitted labels live in ONE place,
// `LABEL_SUPPLY_VOCABULARIES` (@camstack/types): they are also the vocabulary a
// root detector's linked label must use (D730). The runtime label lookup itself
// comes per-model from each model's `-labels.json`.
const ANIMAL_CLASSIFIER_LABELS = LABEL_SUPPLY_VOCABULARIES['animal-classifier']
const VEHICLE_CLASSIFIER_LABELS = LABEL_SUPPLY_VOCABULARIES['vehicle-classifier']

// VGG English G2 charset. Index 0 = CTC blank token.
//
// This plugin catalog export has a 96-CHARACTER set (97 output classes incl. blank) —
// ONE more symbol than the stock EasyOCR latin set. Verified empirically against
// the live OpenVINO model (raw argmax indices): digits map 1:1, but every A–Z /
// a–z landed one index too low, so the recognizer read a crisp "DWRO309" as
// "EXSP…" and "ABCDEF…" as "BCDEFG…" (each letter +1). The extra slot sits
// between the symbol block and the uppercase letters; its exact glyph is
// immaterial to alphanumeric plate text, so it is padded with a space (which
// also keeps a plate word-gap decoding correct whichever slot the model uses for
// space). Total = 1 + 10 + 33 + 1 + 52 = 97.
const VGG_G2_CHARSET = [
  '', // 0 — CTC blank
  ...'0123456789'.split(''), // 1–10 — digits
  ...'!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~ '.split(''), // 11–43 — 33 symbols
  ' ', // 44 — extra symbol slot in this export (see note above)
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.split(''), // 45–96
] as const

// Bird and vehicle labels are loaded from JSON files at runtime (too large for inline)
// The engine factory reads them from extraFiles and passes to the pool config

// ---------------------------------------------------------------------------
// Base class — steps with no config return empty array
// ---------------------------------------------------------------------------

/**
 * Detail-subtree dispatch cadence a `PipelineStepBase` step gets when its
 * definition literal doesn't declare one explicitly. Conservative default
 * for the "specialized, opt-in" classifier steps that predate the cadence
 * table — dispatch once per track, cap at 3 attempts.
 */
const DEFAULT_STEP_CADENCE: DetailStepAnnounce['cadence'] = {
  trigger: 'once',
  maxPerTrack: 3,
}

class PipelineStepBase implements IPipelineStep {
  readonly definition: StepDefinition

  constructor(definition: StepDefinition) {
    this.definition = {
      ...definition,
      cadence: definition.cadence ?? DEFAULT_STEP_CADENCE,
    }
  }

  getConfigSchema(): readonly ConfigField[] {
    return []
  }
}

// ---------------------------------------------------------------------------
// Step classes
// ---------------------------------------------------------------------------

/**
 * The GLOBAL per-class confidence floors of the object-detection step — what a
 * model that declares no `defaultClassFloors` row runs at (D738). Tuned on the
 * YOLOv9 root; see the person slider for the measurement behind 0.65.
 */
const GLOBAL_CLASS_FLOORS = { person: 0.65, vehicle: 0.5, animal: 0.5 } as const

/** The model's own default floor for `macroClass`, else the global one (D738). */
function classFloorDefault(
  model: ModelCatalogEntry | undefined,
  macroClass: string,
  globalFloor: number,
): number {
  return model?.defaultClassFloors?.[macroClass] ?? globalFloor
}

class ObjectDetectionStep implements IPipelineStep {
  readonly definition: StepDefinition = {
    id: 'object-detection',
    name: 'Object Detection',
    slot: 'detector',
    postprocessor: 'yolo',
    extractMode: 'full-frame',
    inputClasses: null,
    // `package` rides along for the INTERIM COCO vector (suitcase/backpack/
    // handbag -> package via COCO_TO_MACRO). The dedicated parcel model
    // lands as a SEPARATE root step (not a change to this one), so this
    // step's honest output set is the four mapped macros.
    outputClasses: ['person', 'vehicle', 'animal', 'package'],
    // Tier 1 (4g). NOT for the macro classes above — those are `className` and
    // are refused for either label slot. This declares the tier of the RAW
    // detector class behind the macro (`dog` under `animal`), which ships only
    // under `verbosity: 'full'` as `debug.originalClass`.
    labelTier: 1,
    models: [...OBJECT_DETECTION_MODELS],
    // Default to YOLO26 Nano — newest-generation architecture, light enough for
    // the weakest node (N100) and portable across onnx/coreml/openvino. Powerful
    // nodes can select a larger tier (yolo26s/m/x) or an OpenVINO int8/fp16
    // variant per-node. Matches the segmentation default (yolo26n-seg).
    defaultModelId: 'yolo26n',
    // On the Coral (`tflite` format) the yolo26 lineage has no build — default
    // to YOLOv9-s @320 (D908, amends D710): on the same TPU it out-recalls
    // the SSD MobileNet V2 in every measurement (docs/benchmarks/
    // 2026-10-22-coral-pcie-amd-phoenix.md). The SSD and the 512 build stay
    // selectable; an explicit pin keeps its model. This declaration is what
    // cold-start and an empty pin resolve to.
    defaultModelIdByFormat: {
      tflite: 'yolov9s-320-edgetpu',
    },
    defaultConfidence: 0.5,
    labels: COCO_80_LABELS.map((l) => l.id),
    classMap: COCO_TO_MACRO,
  }

  getConfigSchema(model?: ModelCatalogEntry): readonly ConfigField[] {
    // Rework (Phase 6):
    //  - Drop the macro-vs-COCO switch. Macro is the only mode —
    //    person / vehicle / animal, mapped internally by the postprocessor
    //    (see MACRO_LABELS / COCO_TO_MACRO).
    //  - Single macro multiselect with default = all three.
    //  - Per-macro minConfidence sliders so each class gets its own
    //    sensitivity. Device-scoped so each camera can tune independently
    //    with the global default as fallback.
    return [
      {
        type: 'multiselect' as const,
        key: 'enabledMacroClasses',
        label: 'Enabled Classes',
        // No count in the copy. It said "all three" while four chips were
        // rendered, and a number here goes stale the next time the offer moves.
        description: 'Which macro classes to detect (empty = every class listed here).',
        // `package` is NOT offered here. It is owned by the dedicated
        // `package-detection` step, whose model emits a real parcel class and
        // whose enablement is zone-driven (`applyPackageZoneActivation`). This
        // step can only ever produce the COCO PROXY (suitcase / backpack /
        // handbag via `COCO_TO_MACRO`), so offering the same word twice let an
        // operator tick a box that turned on the proxy and left the real
        // detector off. The mapping and the label map are untouched — the
        // removal is on the OFFER only; a camera that already stored
        // `'package'` here keeps behaving exactly as before.
        options: [
          { value: 'person', label: 'Person' },
          { value: 'vehicle', label: 'Vehicle' },
          { value: 'animal', label: 'Animal' },
        ],
        default: ['person', 'vehicle', 'animal'],
      },
      {
        type: 'slider' as const,
        key: 'minConfidencePerson',
        label: 'Min Confidence — Person',
        description: 'Drop person predictions below this score.',
        min: 0,
        max: 1,
        step: 0.05,
        // 0.65, raised from 0.50 on 2026-07-30. At 0.50 a dead ornamental
        // grass in a gravel bed was detected as `person` at 0.5005 and
        // delivered as a notification. Measured on device 101 over 24 h (161
        // person events): min 0.500, p25 0.538, median 0.641, max 0.913 —
        // the phantom sat at the very bottom of the sample.
        //
        // Raising the floor does not cost real subjects: a genuine one
        // produces at least one high-confidence frame across its track, a
        // phantom only ever grazes the floor. Both ends were checked against
        // the stored media rather than assumed — the 0.855 track was a person
        // walking a dog, the 0.5005 track was the plant.
        //
        // Enforced, not decorative: `collectSchemaDefaults` hydrates this into
        // the runtime settings and `macroFilterVerdict` applies it per
        // detection. Operator-overridable per camera.
        //
        // 0.65 is the GLOBAL default, tuned on the YOLOv9 root. Since D738 the
        // default in force is the RUNNING model's (`defaultClassFloors` in the
        // catalog), and an operator value is bound to the model it was set for.
        default: classFloorDefault(model, 'person', GLOBAL_CLASS_FLOORS.person),
        bindsToModel: true,
        showValue: true,
      },
      {
        type: 'slider' as const,
        key: 'fullFrameGuardHardAreaRatio',
        label: 'Drop full-frame boxes above',
        description:
          'Fraction of the frame at or above which a detection is dropped WHATEVER its score. 1 = off. Use on cameras where a subject can never fill the frame; leave off for doorbells and close-up lenses.',
        min: 0.5,
        max: 1,
        step: 0.01,
        // OFF by default. The score-aware guard already drops full-frame boxes
        // below 0.70, but on 2026-07-30 device 101 produced SIX `vehicle`
        // boxes at 94.4% of the frame scoring 0.710-0.787 — all above that bar,
        // all surviving, each then stamped with every zone it touched. Raising
        // the score bar instead would cost genuine close-ups, which sit at
        // 0.65-0.85; whether a full-frame box can be real is a property of the
        // CAMERA, so this is per-camera and starts disabled.
        default: 1,
        showValue: true,
      },
      {
        type: 'slider' as const,
        key: 'minConfidenceVehicle',
        label: 'Min Confidence — Vehicle',
        description: 'Drop vehicle predictions below this score.',
        min: 0,
        max: 1,
        step: 0.05,
        default: classFloorDefault(model, 'vehicle', GLOBAL_CLASS_FLOORS.vehicle),
        bindsToModel: true,
        showValue: true,
      },
      {
        type: 'slider' as const,
        key: 'minConfidenceAnimal',
        label: 'Min Confidence — Animal',
        description: 'Drop animal predictions below this score.',
        min: 0,
        max: 1,
        step: 0.05,
        default: classFloorDefault(model, 'animal', GLOBAL_CLASS_FLOORS.animal),
        bindsToModel: true,
        showValue: true,
      },
      // No `minConfidencePackage` slider here: the root step no longer offers
      // `package`, so a control gated on `includes: 'package'` would be
      // permanently unreachable. The real one lives on `package-detection`
      // (`PackageDetectionStep.getConfigSchema`), which is where an operator
      // tuning parcels belongs.
      {
        type: 'boolean' as const,
        key: 'motionCropDispatch',
        label: 'Detect on motion-derived crops',
        description:
          'Run the second detector pass on EVERY moving region instead of only on regions no full-frame box accounts for. Additive: the full-frame pass still runs, and it stays the only arm that can see a stationary subject. Costs about one extra detector invocation every four frames while something is moving.',
        // OFF by default, per camera — the same opt-in shape as the motion area
        // bar's `minArea: 0` (D394), so a deploy changes nothing until an
        // operator moves a camera.
        //
        // Measured on camera 101 against `yolov9m-320-int8` over 38 visually
        // confirmed positive frames from six animal pass-bys: recall at the
        // animal floor 24% full-frame, 42% on motion-derived crops, 74% with
        // the motion area bar lowered; per pass-by 4/6 → 6/6. Cost on the node
        // that runs that camera: mean 0.25 extra invocations per frame at the
        // shipped motion sensitivity, 0.88 at the lowered bar, bounded by the
        // motion duty cycle and by the pass's own per-camera rate limit.
        // False positives on 3 085 quiet frames: two, both night-IR corners,
        // both removed by the crop-only class floor (D396); zero false
        // `animal` at any gate.
        default: false,
      },
      {
        type: 'slider' as const,
        key: 'nmsIouThreshold',
        label: 'NMS IoU threshold',
        description:
          'Overlap above which two boxes of the same object are merged (deduplicated). ' +
          'Lower merges more aggressively; higher keeps more near-duplicate boxes.',
        min: 0.1,
        max: 0.9,
        step: 0.05,
        // == the historical hardcoded literal, so reset == today's behaviour.
        default: 0.45,
        showValue: true,
      },
      // NOTE: there is deliberately NO switch for the discard trail — the
      // post-NMS boxes the pipeline drops (class filter, confidence floor,
      // full-frame guard, zone gate) always ride `FrameResult.discarded`.
      // The set is post-NMS and post-confidence-floor: a handful of boxes
      // per frame, not the raw candidate flood, so it costs nothing worth
      // a flag (operator decision, 2026-08-01).
    ]
  }
}

class AudioClassifierStep implements IPipelineStep {
  readonly definition: StepDefinition = {
    id: 'audio-classifier',
    name: 'Audio Classifier',
    slot: 'audio-classifier',
    postprocessor: 'yamnet',
    extractMode: 'full-frame',
    inputClasses: null,
    outputClasses: ['audio'],
    models: [...AUDIO_CLASSIFIER_MODELS],
    // `yamnet-onnx` runs everywhere (onnx/openvino). macOS agents (coreml
    // format) get upgraded to `apple-soundanalysis` at agent-seed time —
    // it's ANE-accelerated and zero-download, which beats yamnet-onnx on
    // Apple Silicon. See `AgentPipelineSettings.addonDefaults` seed logic
    // in the orchestrator.
    defaultModelId: 'yamnet-onnx',
    defaultModelIdByFormat: {
      coreml: 'apple-soundanalysis',
    },
    enabledByDefault: true,
    defaultConfidence: 0.3,
  }

  getConfigSchema(): readonly ConfigField[] {
    // Phase 7 (settings redesign): unified naming — the field was
    // called `minScore` in Phase 6; every step that exposes a
    // threshold now uses `minConfidence` as the canonical key so the
    // `FormBuilder v2` + `NodeAddonsSettingsPanel` can render them
    // uniformly. The audio pipeline runtime reads this key at
    // execution time and drops classifications whose score is below
    // the threshold — `dispatch.ts`'s yamnet postprocessor no longer
    // filters internally.
    const defaultClasses = [
      'scream',
      'crying',
      'dog',
      'alarm',
      'doorbell',
      'glass_breaking',
      'gunshot',
      'siren',
      'footsteps',
    ]
    return [
      {
        type: 'multiselect' as const,
        key: 'enabledAudioClasses',
        label: 'Audio Classes',
        description: 'Which audio macro classes to surface (empty = all).',
        // `iconId`, not an emoji in the label. The glyph is the renderer's
        // business: the web admin resolves it through `resolveEventKindIcon`
        // and the viewer through its own lucide-react-native map, so both draw
        // the SAME icon the rest of the product already uses for that class.
        options: AUDIO_MACRO_LABELS.map((l) => ({
          value: l.id,
          label: l.name,
          iconId: audioKindId(l.id),
        })),
        default: defaultClasses,
      },
      {
        type: 'slider' as const,
        key: 'minConfidence',
        label: 'Min Confidence',
        description: 'Drop predictions whose score is below this threshold.',
        default: 0.3,
        min: 0,
        max: 1,
        step: 0.05,
        showValue: true,
      },
    ]
  }
}

class AnimalClassifierStep implements IPipelineStep {
  readonly definition: StepDefinition = {
    id: 'animal-classifier',
    name: 'Animal Classifier',
    slot: 'classifier',
    postprocessor: 'softmax',
    extractMode: 'crop-roi',
    inputClasses: ['animal'],
    outputClasses: ['animal-type'],
    // Tier 1 (4g): `dog`/`cat`/`bird` is a SUB-CLASS of the `animal` macro —
    // coarser than a species, and it must not be able to overwrite one.
    labelTier: 1,
    models: [...ANIMAL_CLASSIFIER_MODELS],
    defaultModelId: 'animal-classifier',
    // ON by default, and by default its answer comes from the ROOT model
    // (`useRootModel`, D730): a root that declares animals names them at no
    // extra inference; only a root that does not runs this classifier (D736).
    enabledByDefault: true,
    // Confidence gate (2026-07-19): the classifier has NO reject class and will
    // emit a species on people/floor crops, so require a confident top-1
    // (≥ 0.5) before a label is attached. Runs only on `animal` detections
    // (inputClasses) so the object detector already gates it.
    defaultConfidence: 0.5,
    // Legacy `animals-10` fallback labels (that model ships no `-labels.json`).
    // The PRIMARY `animal-classifier` carries its own 8-class labels via
    // extraFiles, which engine-factory prefers over this array.
    labels: [...ANIMAL_10_LABELS],
    cadence: { trigger: 'once', maxPerTrack: 3, stickyOnConfidence: 0.7 },
  }

  getConfigSchema(model?: ModelCatalogEntry): readonly ConfigField[] {
    return [
      {
        type: 'multiselect' as const,
        key: 'enabledClasses',
        label: 'Species',
        description:
          'Which animal species to keep (empty = all). The classifier still scores every label but only the selected classes are returned on the detection. When the root model is the source, the same list decides which of its labels become the species; a switched-off species stays "animal".',
        options: ANIMAL_CLASSIFIER_LABELS.map((l) => ({ value: l, label: l })),
        default: [],
      },
      {
        type: 'slider' as const,
        key: 'minConfidence',
        label: 'Min Confidence',
        description: 'Drop classifications whose score is below this threshold.',
        default: resolveModelDefaultConfidence(this.definition, model),
        // A score threshold is on ONE model's scale: an operator value applies
        // only while the model it was set for runs (D738).
        bindsToModel: true,
        min: 0,
        max: 1,
        step: 0.05,
        showValue: true,
      },
    ]
  }
}

// ---------------------------------------------------------------------------
// Phase 7 (settings redesign): classifier steps with only a `minConfidence`
// slider. The base class with empty configSchema is replaced by this thin
// helper so vehicle-classifier / bird-classifier can declare their
// threshold consistently without each one spelling out the same class body.
// ---------------------------------------------------------------------------

/**
 * `package-detection` — a ROOT detector, so its threshold is NOT the
 * classifier's `minConfidence` key.
 *
 * The executor filters every root detection through `macroFilterVerdict`, which
 * builds its key as `minConfidence${capitalize(macroClass)}`. This detector's
 * model emits `class: 'package'` and the step declares no `classMap`, so
 * `toMutableRootDetection` copies that through verbatim and the key the gate
 * reads is `minConfidencePackage`. A schema declaring `minConfidence` here
 * would render a slider that filters nothing.
 *
 * Why it exists: the 0.5 floor lived only in `definition.defaultConfidence`,
 * which is forwarded to the Python pool and reachable from no operator surface
 * (the catalog carries `configSchema` to the admin-ui; an empty schema renders
 * no form). Camera 101 reported a DOORMAT at 0.5669 on 2026-08-07, and the
 * model's own benchmark had already noted a doormat near-FP at 0.49 — the
 * shipped floor sat 0.01 above a known false positive with no way to move it.
 *
 * There is deliberately NO enable switch. Enablement is zone-driven
 * (`applyPackageZoneActivation` — drawing a `package`-stage zone rule IS the
 * enable), and a second enablement authority beside the zone rule is the exact
 * bug `packageDropEnabled` already was.
 */
class PackageDetectionStep extends PipelineStepBase {
  getConfigSchema(model?: ModelCatalogEntry): readonly ConfigField[] {
    return [
      {
        type: 'slider' as const,
        key: 'minConfidencePackage',
        label: 'Min Confidence — Package',
        description:
          'Drop package predictions below this score. NOTE: raising it does NOT fix a recurring static false positive — measured on device 101, the false object (a streetlight light patch) scored up to 0.877 while the one real parcel scored 0.885, so no threshold separates them. The lever that does is the package SIZE ceiling in the camera’s Package detection settings (the false object covers 8–9.5% of the frame, real parcels 1–2%).',
        min: 0,
        max: 1,
        step: 0.05,
        // == the model's floor, else `definition.defaultConfidence` (D662), so
        // exposing the surface changes nothing until an operator moves it.
        default: resolveModelDefaultConfidence(this.definition, model),
        // On the model's scale — bound to the model it was set for (D738).
        bindsToModel: true,
        showValue: true,
      },
    ]
  }
}

class ClassifierWithMinConfidence extends PipelineStepBase {
  getConfigSchema(model?: ModelCatalogEntry): readonly ConfigField[] {
    return [
      {
        type: 'slider' as const,
        key: 'minConfidence',
        label: 'Min Confidence',
        description: 'Drop classifications whose score is below this threshold.',
        default: resolveModelDefaultConfidence(this.definition, model),
        // A score threshold is on ONE model's scale: an operator value applies
        // only while the model it was set for runs (D738).
        bindsToModel: true,
        min: 0,
        max: 1,
        step: 0.05,
        showValue: true,
      },
    ]
  }
}

// Plate-OCR format-aware rescoring defaults, forwarded to the Python CTC
// postprocessor by `engine-factory.buildPoolModelConfig` (see
// `python/postprocessors/ctc.py`). NODE-level: the pool binds a model's config
// at load time, so these are not per-camera and are deliberately NOT in the
// step's config schema — see the PlateOcrStep docblock. Add a region here only
// once its grammar exists in `PLATE_GRAMMARS`.
const PLATE_OCR_DEFAULT_REGION = 'DE'
const PLATE_OCR_DEFAULT_MIN_TEXT_LENGTH = 3
const PLATE_OCR_DEFAULT_MIN_TEXT_CONFIDENCE = 0
// The FIXED-SLOT reader's gate (`cct-s-v2-global`). `minTextLength` is
// meaningless for it — it emits `max_plate_slots` characters on every input,
// including a blank wall — so the plausibility question becomes "how sure is the
// least sure character". 0.75 is the centre of the band that separates the two
// populations on the cam-102 set across ONNX/OpenVINO/CoreML; the derivation and
// why it leans high live on `DEFAULT_MIN_CHAR_PROBABILITY` in
// `python/postprocessors/plate_slots.py`, which is also the fallback when this
// value is absent.
const PLATE_OCR_DEFAULT_MIN_CHAR_PROBABILITY = 0.75

/**
 * Plate OCR step — exposes a `rectify` toggle (default ON) that deskews the
 * plate crop (rotation rectification) before the CTC recognizer reads it.
 * Oblique cameras (steeply angled plates) skew the text baseline and collapse
 * CTC beyond ~10-15°; a frontal camera loses nothing at 0° because the executor
 * skips the warp when the estimated angle is ~0. Per-camera configurable, and
 * the ONLY per-camera knob this step has — see below.
 *
 * `plateRegion` / `minTextLength` / `minTextConfidence` are NOT offered here.
 * They are consumed inside the Python CTC postprocessor, whose config is bound
 * when the model is loaded into the shared inference pool — node-level by
 * construction, exactly like `nmsIouThreshold` and the pool confidence floor.
 * They used to be rendered as per-camera sliders that wrote a settings row
 * nobody read: `engine-factory.buildPoolModelConfig` takes the STATIC value off
 * the step definition below, so the operator moved a slider and the runtime
 * kept the default (D62 — a per-camera switch that stores nothing is worse than
 * no switch). Making them genuinely per-camera means a per-REQUEST config
 * override through SharedInferencePool → inference_pool.py → ModelSlot.config,
 * i.e. a new wire protocol, not a step-schema entry.
 */
class PlateOcrStep extends PipelineStepBase {
  getConfigSchema(): readonly ConfigField[] {
    return [
      {
        type: 'boolean' as const,
        key: 'rectify',
        label: 'Deskew Plate Crop',
        description:
          'Rotate the plate crop to level the text baseline before OCR. Recommended for oblique/angled cameras; a frontal camera is unaffected (no rotation applied at ~0°).',
        default: true,
        style: 'switch',
      },
    ]
  }
}

// ---------------------------------------------------------------------------
// Steps with no per-step config (use PipelineStepBase)
// ---------------------------------------------------------------------------

const STEP_FACE_DETECTION = new PipelineStepBase({
  id: 'face-detection',
  name: 'Face Detection',
  slot: 'cropper',
  postprocessor: 'scrfd',
  extractMode: 'crop-roi',
  inputClasses: ['person'],
  outputClasses: ['face'],
  models: [...FACE_DETECTION_MODELS],
  // YuNet since 2026-09-26 (D645): MIT weights, verified live on camera 104 on
  // the hub's NPU and GPU. It is the only entry: SCRFD (InsightFace weights,
  // non-commercial research only) left the catalog.
  defaultModelId: 'yunet-2023mar',
  // Coral (`tflite`): YuNet's own Edge TPU build (D710), so the tflite default
  // is YuNet with no `defaultModelIdByFormat` entry (D657: such an entry may
  // only name a model with a build for that format,
  // `__tests__/guards/format-defaults-buildable.guard.ts`). A Coral-elected
  // camera therefore runs face detection ON its Coral unless the node sets
  // `jumpDeviceKey` — which a Coral running the root detector must (D724: at
  // 640 YuNet's activations leave no room for the root's cache).
  defaultConfidence: 0.5,
  defaultMinParentScore: 0.7,
  // PERIODIC (not improve): the live overlay shows the TRUE face box from the
  // latest detection — never a re-projection of a stale box onto the track's
  // current bbox — so the detector GEOMETRY is refreshed on a steady cadence to
  // stay glued to the moving face, even without a confidence improvement.
  //
  // This cadence applies to the DETECTOR step only. The nested `face-embedding`
  // child has NO cadence of its own on the detail plane — a nested child's
  // cadence is never consulted; it simply rides whatever chain the detector's
  // dispatch runs. So the recognition ride is composed by the DISPATCHER
  // (addon-post-analysis `TrackDetailDispatcher`), which chooses the `steps`
  // sent to `runDetailSubtree`: a PERIODIC tick on a track that ALREADY carries
  // an identity label runs `['face-detection']` GEOMETRY-ONLY (re-embedding a
  // known face every second is wasted ArcFace inference — 250-1900ms on N100
  // agents), while new-track / improve / retry dispatches send
  // `['face-detection','face-embedding']` so recognition still rides the fresh
  // crop. `runDetailSubtree`'s strict-`steps` pruning is what makes the omitted
  // embedding actually skip (see `pruneChildStepsToRequested`).
  cadence: { trigger: 'periodic', minIntervalMs: 1000 },
})

/**
 * `face-embedding` — carries the LANDMARK-PRECISION floor as its only operator
 * knob.
 *
 * It has to live here rather than beside the other face thresholds in
 * post-analysis's `face-settings.ts`: the gate is enforced in the runner's
 * executor, on the detection-frame measurement, BEFORE the native-size
 * substitution — and `child.settings` (hydrated from this schema by
 * `tree-builder`) is the only channel that reaches that code. A copy in
 * `face-settings.ts` would be a second knob that writes a store the gate never
 * reads, which this repo has shipped twice already.
 */
class FaceEmbeddingStep extends PipelineStepBase {
  getConfigSchema(): readonly ConfigField[] {
    return [
      {
        type: 'slider' as const,
        key: 'minLandmarkFaceSize',
        label: 'Min face size to embed (detection-frame px)',
        description:
          'Refuse to embed a face smaller than this IN THE DETECTION FRAME — not at native resolution. The 5 landmarks that align the crop are regressed at detection scale, so below this floor the aligned crop is not reliably a face, and a native-resolution cutout cannot fix it. Measured on 60 live crops: at 24px, 61% come out correctly aligned versus 20% with no floor, at the cost of about 70% of the volume. Lower it if you are losing too many faces; 0 disables the gate. A degenerate crop is worse than no crop — it scores high similarity against everyone and poisons the gallery.',
        min: 0,
        max: 64,
        step: 2,
        showValue: true,
        // Single source of truth with the executor's fallback: the schema
        // default is hydrated into `child.settings` by `tree-builder`, and the
        // gate falls back to the SAME constant when it is absent.
        default: DEFAULT_LANDMARK_PRECISION_FLOOR_PX,
      },
    ]
  }
}

const STEP_FACE_EMBEDDING = new FaceEmbeddingStep({
  id: 'face-embedding',
  name: 'Face Embedding',
  slot: 'classifier',
  postprocessor: 'arcface',
  extractMode: 'crop-roi',
  inputClasses: ['face'],
  outputClasses: ['identity'],
  // Tier 2 (4g): a recognized person is the finest thing sayable about the
  // subject. Nothing coarser may displace it.
  labelTier: 2,
  models: [...FACE_EMBEDDING_MODELS],
  // D651: AuraFace (Apache-2.0, a real R100) replaced the UNKNOWN-licence
  // `arcface-r100`, which has since left the catalog (it is the only entry).
  // Every format this cluster runs (onnx, openvino, coreml) has a build, so no
  // per-format override is declared. The
  // mirror in `@camstack/types` (`CLUSTER_MODEL_SCOPED_STEPS`) must equal this;
  // `scripts/check-cluster-model-scope.ts` refuses a drift.
  defaultModelId: 'auraface-r100',
  // CLUSTER-scoped: every vector this step produces lands in the ONE enrolled
  // face gallery and is scored by cosine against every other. A per-node model
  // would put two encoders in that gallery, and `face-matcher`'s same-model gate
  // could only ever drop the minority — see `pipeline/cluster-model-scope.ts`.
  modelScope: 'cluster',
  defaultConfidence: 0,
  // Embed only a face the detector is SURE of (D741). The face detector's own
  // floor moved to 0.70 (YuNet, measured), but 0.85 is where the faces that
  // reach the gallery and the matcher were chosen (D662: every auto-recognition
  // scored ≥ 0.85), so the embedding keeps it — a separate gate, on YuNet's
  // scale (the only face detector). A face between the two is a detection
  // with no embedding; the executor logs the skip.
  defaultMinParentScore: 0.85,
  cadence: { trigger: 'improve', minIntervalMs: 1000, stickyOnConfidence: 0.6 },
})

const STEP_CLIP_EMBEDDING = new PipelineStepBase({
  id: 'clip-embedding',
  name: 'CLIP Embedding',
  slot: 'classifier',
  postprocessor: 'clip',
  extractMode: 'crop-roi',
  // Scope to the object-detection macro classes so the step attaches as a
  // CHILD of object-detection (whose outputClasses are exactly these three)
  // and embeds each detected OBJECT crop — mirroring how face-embedding scopes
  // to ['face'] under face-detection. `null`/`[]` here makes the catalog
  // tree-builder (`buildTreeFromAddons`) treat clip as a ROOT and run it on
  // the FULL FRAME, producing one scene embedding instead of per-object
  // embeddings — which breaks text→object semantic search.
  inputClasses: ['person', 'vehicle', 'animal'],
  outputClasses: ['embedding'],
  models: [...CLIP_EMBEDDING_MODELS],
  // SigLIP2 B/16 (Apache-2.0): the only CLIP encoder in the catalog (MobileCLIP
  // S1/S2 left it). 768-d, so it lives in its own `object-clip-siglip2-b16-224` index.
  defaultModelId: 'siglip2-b16-224',
  // CLUSTER-scoped, for the same reason as face-embedding and one level down
  // from D52: `vec_object_clip` is ONE feature space. D52 unified the crop the
  // encoder sees; this unifies WHICH encoder sees it.
  modelScope: 'cluster',
  // ON by default: object embeddings power text→object semantic search. One
  // siglip2 inference PER OBJECT CROP (extractMode 'crop-roi',
  // best-per-track upsert) — naturally sampled well below the detector fps,
  // comparable in cost to the always-on arcface face-embedding.
  enabledByDefault: true,
  defaultConfidence: 0,
  // Skip embedding low-confidence (junk) object detections — the crop is
  // usually noise and a wasted siglip2 inference.
  defaultMinParentScore: 0.4,
  group: 'CLIP',
  cadence: { trigger: 'improve' },
})

const STEP_PLATE_DETECTION = new PipelineStepBase({
  id: 'plate-detection',
  name: 'Plate Detection',
  slot: 'cropper',
  postprocessor: 'yolo',
  extractMode: 'crop-roi',
  inputClasses: ['vehicle'],
  outputClasses: ['plate'],
  models: [...PLATE_DETECTION_MODELS],
  defaultModelId: 'yolox-tiny-plate',
  defaultConfidence: 0.5,
  defaultMinParentScore: 0.7,
  labels: ['plate'],
  // PERIODIC, not 'once' (2026-09-03). Under 'once' a non-null result is
  // TERMINAL — the scheduler never re-runs the chain — so the FIRST legible
  // frame won outright whatever it said, and `plate-vote.ts`, which exists to
  // reconcile disagreeing reads, could only ever be handed one. A vehicle
  // crossing the frame offers better angles after that first read and every one
  // of them was thrown away. Measured: 40 vehicle tracks on camera 102 in 24 h
  // ended with no plate at all.
  //
  // `maxPerTrack` is what keeps this affordable: periodic must not mean
  // unbounded on a car parked in view. 2 s spacing is a genuinely new view at
  // any road speed and still lets a fast pass yield several reads; the
  // dispatcher ticks at 1 s, so anything below that would only queue.
  cadence: { trigger: 'periodic', minIntervalMs: 2_000, maxPerTrack: 8 },
})

const STEP_PLATE_OCR = new PlateOcrStep({
  id: 'plate-ocr',
  name: 'Plate OCR',
  slot: 'classifier',
  postprocessor: 'ctc',
  extractMode: 'crop-roi',
  inputClasses: ['plate'],
  outputClasses: ['plate-text'],
  // Tier 2 (4g): the plate read (or the vehicle it names) IS the instance.
  labelTier: 2,
  models: [...PLATE_OCR_MODELS],
  // DEFAULT MOVED 2026-08-20: `vgg_english_g2` → `cct-s-v2-global`, the only
  // entry now (the VGG reader left the catalog). The incumbent was a generic English text recognizer that reads 4 of the 21 ground-truthed
  // cam-102 plates; the new default is a plate reader and takes 19 of 21 with
  // the same zero false positives on the 18 junk ROIs — including all seven
  // crops of the car the operator reported (DN-RO 309), which the old reader got
  // wrong on every frame.
  defaultModelId: 'cct-s-v2-global',
  defaultConfidence: 0,
  charset: [...VGG_G2_CHARSET],
  // Format-aware rescoring + plausibility-gate defaults forwarded to the Python
  // CTC postprocessor (mirrored by the step's getConfigSchema so UI + wire agree).
  plateRegion: PLATE_OCR_DEFAULT_REGION,
  minTextLength: PLATE_OCR_DEFAULT_MIN_TEXT_LENGTH,
  minTextConfidence: PLATE_OCR_DEFAULT_MIN_TEXT_CONFIDENCE,
  minCharProbability: PLATE_OCR_DEFAULT_MIN_CHAR_PROBABILITY,
  // Same cadence as the detector above, and for the same reason — a read that
  // is never revisited cannot be voted on.
  cadence: { trigger: 'periodic', minIntervalMs: 2_000, maxPerTrack: 8 },
})

// Dedicated package/parcel detector (design ADDENDUM 2026-07-17 + DECISION).
// A ROOT-plane detector (`inputClasses: null`) — a delivered package is
// STATIONARY, so it never gets a track and the per-track enrichment/crop-roi
// plane never sees it; package detection therefore needs its own root shape,
// NOT a crop-roi child. Output is the model-agnostic `package` class that feeds
// the existing PackageDropDetector (gates on className ∈ ['package']).
//
// `extractMode: 'crop-zone'` declares that this detector's INPUT is the
// device's drawn `package`-stage zone-rules polygons, not the full frame — this
// is what makes package zones an active input rather than a passive
// post-filter. That preparation is LIVE (landed e6aaad11e):
// `provider.runPipeline` resolves the zone-union bbox off the device's own
// state mirror (`resolvePackageCropBbox`, runtime + real device only) and hands
// it to the executor, which crops the frame to it (`prepareCropZoneInput`) and
// re-projects the detections back to frame space
// (`reprojectCropZoneDetections`). A degenerate bbox or a failed crop/encode
// falls back to the FULL FRAME with a throttled warn — a package frame is never
// dropped for a crop failure — which is also the benchmark/reference path,
// where no zones are bound.
//
// The motion-settle governor is live too: the runner's `MotionSettleGovernor`
// drops this step from the dispatched tree on frames where a stationary parcel
// cannot have changed, so it does not run per-frame like object-detection.
//
// Enablement is ZONE-DRIVEN, never a toggle. `enabledByDefault: false` is the
// catalog-side default; the resolver's `applyPackageZoneActivation` is the sole
// authority — an enabled `package`-stage zone rule with ≥1 zone appends the
// step, its removal strips it, and the per-camera `stepToggles` gate skips this
// id entirely. Model is selectable per node via the standard per-node model
// resolution; `rfdetr-package` is the DEFAULT (operator decision 2026-08-07,
// superseding yolov8n-package of 2026-07-17 — see the PACKAGE_DETECTION_MODELS
// block comment for the measured separation that drove it) and is only
// auto-loaded once the step is active — never auto-picked onto a camera (cf.
// Coral). It ships onnx / coreml / openvino, i.e. every format any node in the
// fleet runs, so `getDefaultModelForFormat` resolves it directly on all of
// them. The one hole is `tflite`/edgetpu, where a DETR head does not compile at
// all — and where the previous default had no build either, so nothing
// regressed: a tflite-format node has no package model, as before.
//
// Its per-camera confidence surface is on {@link PackageDetectionStep} — the
// key is `minConfidencePackage` because the executor's gate derives it from the
// macro class.
const STEP_PACKAGE_DETECTION = new PackageDetectionStep({
  id: 'package-detection',
  name: 'Package Detection',
  slot: 'detector',
  postprocessor: 'yolo',
  extractMode: 'crop-zone',
  inputClasses: null,
  outputClasses: ['package'],
  models: [...PACKAGE_DETECTION_MODELS],
  defaultModelId: 'rfdetr-package',
  enabledByDefault: false,
  defaultConfidence: 0.5,
  labels: ['package'],
})

const STEP_BIRD_CLASSIFIER = new ClassifierWithMinConfidence({
  id: 'bird-classifier',
  name: 'Bird Classifier',
  slot: 'classifier',
  postprocessor: 'softmax',
  extractMode: 'crop-roi',
  inputClasses: ['animal'],
  outputClasses: ['species'],
  // Tier 2 (4g): `Turdus migratorius` under the animal-classifier's `bird`.
  // The pair is exactly what one label slot could not hold.
  labelTier: 2,
  models: [...BIRD_CLASSIFIER_MODELS],
  defaultModelId: 'bird-classifier',
  // Specialized: operator opts in per deployment (not every install
  // wants bird-species telemetry out of the box).
  enabledByDefault: false,
  // Confidence gate (2026-07-19): the AIY bird model false-positives on
  // cats/people, so require a high top-1 (≥ 0.6) before a species is emitted.
  defaultConfidence: 0.6,
  // Reject the model's index-964 catch-all so `background` is never surfaced
  // as a species label (see result-assembler + the bird-classifier entry).
  // NOTE: this step runs on ANY `animal` detection today. Chaining it to only
  // fire when `animal-classifier` says `bird` (per the design) is a FOLLOW-UP
  // that needs cross-step ordering the tree-builder does not yet express — the
  // background-reject + high threshold are the shipped protection meanwhile.
  rejectClasses: ['background'],
  cadence: { trigger: 'once', maxPerTrack: 3, stickyOnConfidence: 0.7 },
})

/**
 * `vehicle-classifier` — the `minConfidence` slider plus the class allow-list.
 * When the step takes the root model's labels (`useRootModel`, D730) the same
 * allow-list filters which root labels become the vehicle type.
 */
class VehicleClassifierStep extends ClassifierWithMinConfidence {
  override getConfigSchema(model?: ModelCatalogEntry): readonly ConfigField[] {
    return [
      {
        type: 'multiselect' as const,
        key: 'enabledClasses',
        label: 'Vehicle types',
        description:
          'Which vehicle types to keep (empty = all). The classifier still scores every type but only the selected ones are returned on the detection. When the root model is the source, the same list decides which of its labels become the type; a switched-off type stays "vehicle".',
        options: VEHICLE_CLASSIFIER_LABELS.map((l) => ({ value: l, label: l })),
        default: [],
      },
      ...super.getConfigSchema(model),
    ]
  }
}

const STEP_VEHICLE_CLASSIFIER = new VehicleClassifierStep({
  id: 'vehicle-classifier',
  name: 'Vehicle Classifier',
  slot: 'classifier',
  postprocessor: 'softmax',
  extractMode: 'crop-roi',
  inputClasses: ['vehicle'],
  outputClasses: ['vehicle-type'],
  // Tier 1 (4g): `van`/`truck` is a SUB-CLASS of the `vehicle` macro; a plate
  // read or a named vehicle is the instance and lives in tier 2.
  labelTier: 1,
  models: [...VEHICLE_CLASSIFIER_MODELS],
  defaultModelId: 'vehicle-type-v1',
  // ON by default, sourced from the root model like the animal classifier
  // (D736): the classifier itself runs only when the root cannot name vehicles.
  enabledByDefault: true,
  // Confidence gate (2026-07-19): emit a vehicle type only on a confident
  // top-1 (≥ 0.5); the classifier is reliable on real vehicles so this floor
  // is conservative rather than aggressive.
  defaultConfidence: 0.5,
  cadence: { trigger: 'once', maxPerTrack: 3, stickyOnConfidence: 0.7 },
})

const STEP_SEGMENTATION = new PipelineStepBase({
  id: 'segmentation',
  name: 'Segmentation',
  slot: 'refiner',
  postprocessor: 'saliency',
  extractMode: 'crop-roi',
  inputClasses: null,
  outputClasses: ['mask'],
  models: [...SEGMENTATION_REFINER_MODELS],
  defaultModelId: 'u2netp',
  // Opt-in: one u2netp inference per detection crop.
  enabledByDefault: false,
  defaultConfidence: 0,
  group: 'Segmentation',
})

const STEP_INSTANCE_SEGMENTATION = new PipelineStepBase({
  id: 'instance-segmentation',
  name: 'Instance Segmentation',
  slot: 'refiner',
  postprocessor: 'yolo-seg',
  extractMode: 'full-frame',
  inputClasses: null,
  outputClasses: ['mask'],
  models: [...INSTANCE_SEGMENTATION_MODELS],
  defaultModelId: 'yolo26n-seg',
  // Instance segmentation is expensive — default OFF.
  enabledByDefault: false,
  defaultConfidence: 0.25,
  labels: COCO_80_LABELS.map((l) => l.id),
  classMap: COCO_TO_MACRO,
  group: 'Segmentation',
})

// ---------------------------------------------------------------------------
// Registry — all steps indexed by ID
// ---------------------------------------------------------------------------

const STEP_OBJECT_DETECTION_INSTANCE = new ObjectDetectionStep()
const STEP_AUDIO_CLASSIFIER_INSTANCE = new AudioClassifierStep()
const STEP_ANIMAL_CLASSIFIER_INSTANCE = new AnimalClassifierStep()

export const ALL_PIPELINE_STEPS: readonly IPipelineStep[] = [
  STEP_OBJECT_DETECTION_INSTANCE,
  STEP_FACE_DETECTION,
  STEP_FACE_EMBEDDING,
  STEP_CLIP_EMBEDDING,
  STEP_PLATE_DETECTION,
  STEP_PLATE_OCR,
  STEP_PACKAGE_DETECTION,
  STEP_ANIMAL_CLASSIFIER_INSTANCE,
  STEP_BIRD_CLASSIFIER,
  STEP_VEHICLE_CLASSIFIER,
  STEP_SEGMENTATION,
  STEP_AUDIO_CLASSIFIER_INSTANCE,
]

/**
 * Steps kept registered but OUT of the active pipeline (not in ALL_PIPELINE_STEPS,
 * not in the default tree). Re-enable instance segmentation later by moving
 * STEP_INSTANCE_SEGMENTATION back into ALL_PIPELINE_STEPS. Its catalog models
 * (INSTANCE_SEGMENTATION_MODELS) and the `yolo-seg` postprocessor stay registered.
 */
export const DORMANT_PIPELINE_STEPS: readonly IPipelineStep[] = [STEP_INSTANCE_SEGMENTATION]

/** Compat: flat array of StepDefinition for existing consumers */
export const ALL_STEPS: readonly StepDefinition[] = ALL_PIPELINE_STEPS.map((s) => s.definition)

const STEP_MAP = new Map(ALL_PIPELINE_STEPS.map((s) => [s.definition.id, s]))

/**
 * Look up a pipeline step by ID (class instance with getConfigSchema).
 * @throws if the step ID is not registered.
 */
export function getStep(stepId: string): IPipelineStep {
  const step = STEP_MAP.get(stepId)
  if (!step) {
    throw new Error(
      `Unknown pipeline step: "${stepId}". Available: ${ALL_PIPELINE_STEPS.map((s) => s.definition.id).join(', ')}`,
    )
  }
  return step
}

/**
 * Look up a step definition by ID (compat shortcut).
 * @throws if the step ID is not registered.
 */
export function getStepDefinition(stepId: string): StepDefinition {
  return getStep(stepId).definition
}

/**
 * Get the default model ID for a step given the current model format.
 *
 * Resolution order:
 *   1. `def.defaultModelIdByFormat?.[format]` — the step's declared
 *      per-format preference — if that model exists in `def.models` AND
 *      has a build for `format`.
 *   2. `def.defaultModelId` — the step's plain declared default — if it
 *      exists in `def.models` AND has a build for `format`.
 *   3. The smallest-by-size NON-legacy model among those with a `format`
 *      build (fallback, preserved for steps/formats with no declared
 *      preference reachable).
 *   4. When NO non-legacy model has a `format` build — an unloadable case
 *      flagged elsewhere, not resolved here — the declared per-format id if
 *      there is one, else `def.defaultModelId`, unchanged.
 */
export function getDefaultModelForFormat(stepId: string, format: ModelFormat): string {
  return getDefaultModelForFormatFromDef(getStepDefinition(stepId), format)
}

/**
 * {@link getDefaultModelForFormat} over an explicit {@link StepDefinition} —
 * the def-based seam callers with an INJECTED catalog use
 * (`resolveDefaultDetectionModel`'s `getStepDef` parameter must flow into the
 * fallback too, or a test-injected catalog silently falls back to the real
 * one). Identical resolution order; see the doc above.
 */
export function getDefaultModelForFormatFromDef(def: StepDefinition, format: ModelFormat): string {
  const hasFormatBuild = (modelId: string): boolean =>
    def.models.find((m) => m.id === modelId)?.formats[format] !== undefined

  const declaredForFormat = def.defaultModelIdByFormat?.[format]
  if (declaredForFormat !== undefined && hasFormatBuild(declaredForFormat)) {
    return declaredForFormat
  }

  if (hasFormatBuild(def.defaultModelId)) {
    return def.defaultModelId
  }

  // Exclude LEGACY entries from the smallest-by-size auto-pick — they are
  // superseded / consolidated models kept only for explicit re-selection, and
  // an older tiny lineage (e.g. yolov9t) must not silently win the format
  // default over the curated nano (yolo26n). A legacy id chosen EXPLICITLY is
  // still honored by `resolveModelForFormat`.
  const available = def.models.filter((m) => m.formats[format] && m.legacy !== true)
  // Nothing loadable for `format`: the answer is unloadable either way (flagged
  // elsewhere), but a DECLARED per-format id still outranks the generic default
  // — otherwise flipping `defaultModelId` silently moves a format that declared
  // its own answer.
  if (available.length === 0) return declaredForFormat ?? def.defaultModelId

  const sorted = [...available].toSorted((a, b) => {
    const sizeA = a.formats[format]?.sizeMB ?? Infinity
    const sizeB = b.formats[format]?.sizeMB ?? Infinity
    return sizeA - sizeB
  })
  return sorted[0]!.id
}

/**
 * The single node-local authority for turning a CHOSEN model (or none) into a
 * concrete model that has a build for this node's engine `format`. Fuses the
 * two previously-duplicated decisions (orchestrator `pickDefaultModelId` +
 * provider `substituteIncompatibleModels`):
 *
 *   - chosen === null            → the addon's default model for `format`.
 *   - chosen is a catalog model  → keep it if it has a `format` build AND is
 *                                  not `legacy`; a legacy pin falls back to
 *                                  the format default (no longer offered).
 *                                  Else the addon's default for `format`
 *                                  (a substitution — the caller surfaces it).
 *   - chosen is NOT in the catalog (custom/unknown) → returned unchanged; the
 *                                  operator owns a custom model's format compat.
 *   - unknown stepId             → chosen returned unchanged (never throws).
 */
export function resolveModelForFormat(
  stepId: string,
  chosenModelId: string | null,
  format: ModelFormat,
): string {
  let def: StepDefinition
  try {
    def = getStepDefinition(stepId)
  } catch {
    // Unknown/custom step — no catalog to resolve against.
    return chosenModelId ?? ''
  }
  if (chosenModelId === null) return getDefaultModelForFormat(stepId, format)
  const entry = def.models.find((m) => m.id === chosenModelId)
  if (!entry) return chosenModelId // custom model, not in catalog — leave as-is
  // Legacy = still on disk for an old pin, but no longer offered. Fall back
  // rather than keep running a hidden model the picker cannot name.
  if (entry.legacy === true) return getDefaultModelForFormat(stepId, format)
  if (entry.formats[format]) return chosenModelId // has a build for this format
  return getDefaultModelForFormat(stepId, format) // substitute the format default
}
