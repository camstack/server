import type { ReolinkDetectionEvent, ReolinkDetectionBox } from '@apocaliss92/nodelink-js'
import type { CameraNativeDetection, CameraNativeDetectionPayload } from '@camstack/types'
import { AI_CLASS_MAP } from './schema'

/**
 * Fallback class for a detection box the camera reported WITHOUT a
 * `label`. Boxes are still useful (geometry-only zoning/tracking in the
 * analyzer), so we keep them rather than drop them — but the analyzer's
 * native normalizer DROPS entries with no bbox, not no class, so a
 * labelled fallback keeps the box flowing. `'other'` is part of the
 * loose `CameraNativeDetection.class` vocabulary documented in
 * `event-bus.ts`.
 */
export const NATIVE_BOX_FALLBACK_CLASS = 'other'

/** How often the forwarding gate reports a dropped class, per class. */
export const NATIVE_DETECTION_SUPPRESSED_LOG_MS = 60_000

/**
 * Map a single lib `ReolinkDetectionBox` → the canonical
 * `CameraNativeDetection` the analyzer consumes.
 *
 * - `class`: the box's own `label` when present, normalised through
 *   `AI_CLASS_MAP` when the label happens to be a Baichuan simple-event
 *   name (`people` → `person`). The lib documents box labels as already
 *   cap-shaped (`person`/`vehicle`), in which case `AI_CLASS_MAP` has no
 *   key for it and we pass the label through verbatim (loose-string
 *   contract). When the camera reports no label we fall back to
 *   `NATIVE_BOX_FALLBACK_CLASS` so the box is never dropped for lack of a
 *   class.
 * - `timestamp`: caller-supplied epoch ms (`Date.now()` at receipt) —
 *   the lib's `microseconds` is a stream PTS, NOT epoch, so it is NEVER
 *   used as the event time.
 * - `confidence`: passed through when the camera exposes it.
 * - `bbox`: the box's `[x, y, w, h]`, already normalised to `[0, 1]`.
 */
export function mapDetectionBox(box: ReolinkDetectionBox, nowMs: number): CameraNativeDetection {
  const rawLabel = box.label
  const mappedClass =
    rawLabel !== undefined && rawLabel.length > 0
      ? (AI_CLASS_MAP[rawLabel] ?? rawLabel)
      : NATIVE_BOX_FALLBACK_CLASS
  return {
    class: mappedClass,
    timestamp: nowMs,
    confidence: box.confidence,
    bbox: [box.x, box.y, box.width, box.height],
  }
}

/**
 * Map a whole lib `ReolinkDetectionEvent` (one frame's boxes) → the
 * `CameraNativeDetectionPayload` we emit on `detection.camera-native`.
 * One payload per event, all boxes inside it, `source: 'onboard'`.
 *
 * `frameWidth`/`frameHeight` ride the payload when the lib decoded them
 * from the BcMedia header so the analyzer can denormalize the `[0, 1]`
 * bboxes to real pixels (it falls back to a nominal frame otherwise).
 *
 * `nowMs` is stamped once and shared by every box in the event — they
 * all arrived on the same frame, at the same instant on the wire.
 */
export function mapDetectionEvent(
  event: ReolinkDetectionEvent,
  cameraId: number,
  nowMs: number,
): CameraNativeDetectionPayload {
  return {
    cameraId,
    source: 'onboard',
    detections: event.boxes.map((box) => mapDetectionBox(box, nowMs)),
    frameWidth: event.frameWidth,
    frameHeight: event.frameHeight,
  }
}

/**
 * Single source of truth for the onboard object-detection forwarding
 * gate. Reads the `native-object-detection` runtime-state slice and
 * decides whether onboard AI detections (both the boxed substream and
 * the flag-only simple-event push) should be forwarded onto
 * `detection.camera-native`.
 *
 * Default is **OFF (opt-in)**: when the slice is absent (`null`/
 * `undefined`, e.g. cold start before the operator ever toggled the cap)
 * forwarding is suppressed. Onboard AI is noisy/sparse and churns the
 * tracker, so it must only flow once the operator explicitly enables it
 * for the device. This `=== true` semantics (vs the historical
 * `!== false`) keeps the boxed-substream path consistent with the
 * already-opt-in simple-event push path.
 */
export function isNativeObjectForwardingEnabled(
  capState: { enabled?: boolean } | null | undefined,
): boolean {
  return capState?.enabled === true
}

/**
 * The classes this firmware can detect, from the cmd-299 probe
 * (`deviceCache.aiDetectTypes`), mapped through {@link AI_CLASS_MAP}.
 *
 * Module-level and exported because the version of this that lived as a
 * closure inside `registerNativeObjectDetectionCap` had a test that
 * RE-IMPLEMENTED it — and the copy encoded the `dog_cat` gap as intent
 * ("skips unknown Baichuan type names"), so the suite stayed green while
 * camera 108 reported it could not detect a class it was detecting. One
 * function, one test, no copy.
 *
 * An absent probe is not an empty answer: it means nobody has asked the camera
 * yet, and the honest fallback is the full mapped value-set rather than "this
 * camera detects nothing".
 */
export function buildSupportedNativeClasses(
  aiDetectTypes: readonly string[] | undefined,
  isSupportedClass: (value: string) => boolean,
): readonly string[] {
  if (!aiDetectTypes || aiDetectTypes.length === 0) {
    return [...new Set(Object.values(AI_CLASS_MAP))].filter(isSupportedClass)
  }
  const classes: string[] = []
  for (const libName of aiDetectTypes) {
    const mapped = AI_CLASS_MAP[libName]
    // De-duplicated: two probe names can map to one class (`animal` and
    // `dog_cat`), and a class listed twice is a UI defect, not a capability.
    if (mapped !== undefined && isSupportedClass(mapped) && !classes.includes(mapped)) {
      classes.push(mapped)
    }
  }
  return classes
}
