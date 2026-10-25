import type { LabelDefinition, ClassMapDefinition } from '../types/labels.js'

export const COCO_80_LABELS: readonly LabelDefinition[] = [
  { id: 'person', name: 'Person' },
  { id: 'bicycle', name: 'Bicycle' },
  { id: 'car', name: 'Car' },
  { id: 'motorcycle', name: 'Motorcycle' },
  { id: 'airplane', name: 'Airplane' },
  { id: 'bus', name: 'Bus' },
  { id: 'train', name: 'Train' },
  { id: 'truck', name: 'Truck' },
  { id: 'boat', name: 'Boat' },
  { id: 'traffic light', name: 'Traffic Light' },
  { id: 'fire hydrant', name: 'Fire Hydrant' },
  { id: 'stop sign', name: 'Stop Sign' },
  { id: 'parking meter', name: 'Parking Meter' },
  { id: 'bench', name: 'Bench' },
  { id: 'bird', name: 'Bird' },
  { id: 'cat', name: 'Cat' },
  { id: 'dog', name: 'Dog' },
  { id: 'horse', name: 'Horse' },
  { id: 'sheep', name: 'Sheep' },
  { id: 'cow', name: 'Cow' },
  { id: 'elephant', name: 'Elephant' },
  { id: 'bear', name: 'Bear' },
  { id: 'zebra', name: 'Zebra' },
  { id: 'giraffe', name: 'Giraffe' },
  { id: 'backpack', name: 'Backpack' },
  { id: 'umbrella', name: 'Umbrella' },
  { id: 'handbag', name: 'Handbag' },
  { id: 'tie', name: 'Tie' },
  { id: 'suitcase', name: 'Suitcase' },
  { id: 'frisbee', name: 'Frisbee' },
  { id: 'skis', name: 'Skis' },
  { id: 'snowboard', name: 'Snowboard' },
  { id: 'sports ball', name: 'Sports Ball' },
  { id: 'kite', name: 'Kite' },
  { id: 'baseball bat', name: 'Baseball Bat' },
  { id: 'baseball glove', name: 'Baseball Glove' },
  { id: 'skateboard', name: 'Skateboard' },
  { id: 'surfboard', name: 'Surfboard' },
  { id: 'tennis racket', name: 'Tennis Racket' },
  { id: 'bottle', name: 'Bottle' },
  { id: 'wine glass', name: 'Wine Glass' },
  { id: 'cup', name: 'Cup' },
  { id: 'fork', name: 'Fork' },
  { id: 'knife', name: 'Knife' },
  { id: 'spoon', name: 'Spoon' },
  { id: 'bowl', name: 'Bowl' },
  { id: 'banana', name: 'Banana' },
  { id: 'apple', name: 'Apple' },
  { id: 'sandwich', name: 'Sandwich' },
  { id: 'orange', name: 'Orange' },
  { id: 'broccoli', name: 'Broccoli' },
  { id: 'carrot', name: 'Carrot' },
  { id: 'hot dog', name: 'Hot Dog' },
  { id: 'pizza', name: 'Pizza' },
  { id: 'donut', name: 'Donut' },
  { id: 'cake', name: 'Cake' },
  { id: 'chair', name: 'Chair' },
  { id: 'couch', name: 'Couch' },
  { id: 'potted plant', name: 'Potted Plant' },
  { id: 'bed', name: 'Bed' },
  { id: 'dining table', name: 'Dining Table' },
  { id: 'toilet', name: 'Toilet' },
  { id: 'tv', name: 'TV' },
  { id: 'laptop', name: 'Laptop' },
  { id: 'mouse', name: 'Mouse' },
  { id: 'remote', name: 'Remote' },
  { id: 'keyboard', name: 'Keyboard' },
  { id: 'cell phone', name: 'Cell Phone' },
  { id: 'microwave', name: 'Microwave' },
  { id: 'oven', name: 'Oven' },
  { id: 'toaster', name: 'Toaster' },
  { id: 'sink', name: 'Sink' },
  { id: 'refrigerator', name: 'Refrigerator' },
  { id: 'book', name: 'Book' },
  { id: 'clock', name: 'Clock' },
  { id: 'vase', name: 'Vase' },
  { id: 'scissors', name: 'Scissors' },
  { id: 'teddy bear', name: 'Teddy Bear' },
  { id: 'hair drier', name: 'Hair Drier' },
  { id: 'toothbrush', name: 'Toothbrush' },
] as const

export const MACRO_LABELS: readonly LabelDefinition[] = [
  { id: 'person', name: 'Person' },
  { id: 'vehicle', name: 'Vehicle' },
  { id: 'animal', name: 'Animal' },
  // `package` macro — the class the package-drop detector gates on
  // (see docs/superpowers/specs/2026-07-17-package-zones-design.md). It is
  // MODEL-AGNOSTIC: a dedicated parcel model emits `className: 'package'`
  // natively; the COCO suitcase/backpack/handbag mapping below is only an
  // interim test vector until that model lands.
  { id: 'package', name: 'Package' },
] as const

/**
 * The class names a per-class COUNT can ever be keyed on — the macro ids, and
 * only those.
 *
 * `preserveOriginal: false` below is the whole reason this set exists: the
 * executor maps each raw COCO label onto its macro and DROPS everything else,
 * so a tracked detection's `className` is always one of {@link MACRO_LABELS}.
 * Any surface that indexes counts by class name — the ZoneAnalytics occupancy
 * snapshot's `byClass`, and therefore every occupancy rule — can match nothing
 * else. Derived from the catalog, never hand-listed, so a new macro joins it by
 * being declared once.
 *
 * Cost of not having it, 2026-08-12: the notification rule editor offered the
 * full taxonomy for an occupancy class (occupancy is the one condition that
 * does not go through the engine's macro-expanding `expandClassSelector`), two
 * live rules were authored on `car`, and both counters read 0 forever.
 */
export const DETECTION_MACRO_CLASSES: ReadonlySet<string> = new Set(MACRO_LABELS.map((l) => l.id))

/** True when `className` is a macro the detector can actually emit (and hence a
 *  class a count can be keyed on) — see {@link DETECTION_MACRO_CLASSES}. */
export function isDetectionMacroClass(className: string): boolean {
  return DETECTION_MACRO_CLASSES.has(className.trim().toLowerCase())
}

export const COCO_TO_MACRO: ClassMapDefinition = {
  mapping: {
    person: 'person',
    bicycle: 'vehicle',
    car: 'vehicle',
    motorcycle: 'vehicle',
    airplane: 'vehicle',
    bus: 'vehicle',
    train: 'vehicle',
    truck: 'vehicle',
    boat: 'vehicle',
    bird: 'animal',
    cat: 'animal',
    dog: 'animal',
    horse: 'animal',
    sheep: 'animal',
    cow: 'animal',
    elephant: 'animal',
    bear: 'animal',
    zebra: 'animal',
    giraffe: 'animal',
    // INTERIM PACKAGE VECTOR (model-agnostic goal). A dedicated parcel
    // model — benchmarked in parallel — emits a native `package` class;
    // until it ships, COCO's luggage-like proxies stand in so the
    // package-drop detector can be exercised end-to-end. These three keys
    // are the ONLY package coupling to COCO and should be dropped (or kept
    // as a fallback) once the dedicated model is selected per camera.
    // Design §3.2 / §4 (Option A).
    suitcase: 'package',
    backpack: 'package',
    handbag: 'package',
  },
  // The pipeline supports the mapped macro classes only
  // (person, vehicle, animal, package). Any other COCO class (carrot,
  // umbrella, spoon, …) is dropped upstream in the executor instead of
  // leaking through as a `macroClass: "carrot"` detection with no child
  // routing. When support for additional COCO classes lands, either add
  // them to `mapping` (mapped to a new macro) or flip this back to `true`
  // and teach `macroFilterVerdict` to handle the raw-COCO case.
  preserveOriginal: false,
}
