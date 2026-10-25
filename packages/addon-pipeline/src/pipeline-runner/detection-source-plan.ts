/**
 * WHICH root detector runs for a camera, and how the camera's own detections
 * are turned into one.
 *
 * The camera-native plane used to be a second door: the provider emitted
 * `detection.camera-native`, post-analysis ingested it on a path of its own,
 * and the pipeline never knew. Everything the pipeline plane gets for free was
 * lost on the way — the per-camera `detailSteps` announce, the subject tiles,
 * the birth evidence, and above all the PIXELS: the native converter set no
 * frame handle, because in post-analysis there are none to set. An onboard-born
 * track therefore had no face, no plate and no embedding, which is invisible
 * while the two planes run side by side and is the whole feature the moment one
 * replaces the other.
 *
 * So the decision moves to the runner, which is the one place that holds a
 * decoded frame and its detections at the same instant. The camera's boxes are
 * paired with that frame and handed to the SAME callback the root step feeds.
 * Downstream there is one plane, one result, one tracker pass — and the source
 * is a field on the payload rather than a door.
 */
import type { CameraNativeDetection, DetectionSources, ObjectDetection } from '@camstack/types'
import {
  macroGateVerdict,
  type MacroGateSettings,
} from '../detection-pipeline/pipeline/macro-gate.js'

/**
 * How far apart a camera's detection and a decoded frame may be and still
 * describe the same instant.
 *
 * An onboard detection is a statement about a moment; giving it pixels means
 * pairing it with a frame that is not exactly that moment. One second is a
 * bound, not a tuning knob: beyond it the subject has plausibly moved out of
 * its own box, and a stale rectangle painted onto a fresh frame is a lie
 * nothing downstream can detect — the tracker would coast it, the crop would
 * cut the wrong pixels, and the best shot would score them.
 *
 * Symmetric on purpose. The camera's clock and this node's are not the same
 * clock, so a push can be stamped slightly after the frame it belongs to;
 * refusing those would drop the freshest pairings of all.
 */
export const ONBOARD_PAIRING_MAX_AGE_MS = 1_000

/**
 * How often the onboard root step reports a decoded frame it produced nothing
 * for, per camera per reason. It fires at detection fps on a silent camera —
 * which is most of the time and is not a fault — so it is sampled rather than
 * suppressed: the reason has to be reachable when an operator asks why the
 * onboard source "does nothing".
 */
export const ONBOARD_ROOT_IDLE_REPORT_MS = 60_000

/** What the camera last told us, and when we heard it. */
export interface OnboardDetectionSlot {
  /** Wall clock at which this push was received. */
  readonly at: number
  readonly detections: readonly CameraNativeDetection[]
  /** Frame dimensions the camera reported, if any — unused for scaling (the
   *  boxes are normalised) and kept only for diagnostics. */
  readonly frameWidth?: number
  readonly frameHeight?: number
}

/** The decoded frame a slot is being paired with. */
export interface PairingFrame {
  readonly timestamp: number
  readonly width: number
  readonly height: number
}

/**
 * Outcome of pairing. Every non-paired case is NAMED rather than folded into
 * an empty array: a branch that accepts a camera's detections and produces
 * nothing must say which of the three reasons it was (D391), or "the onboard
 * source is on and nothing happens" has no answer.
 */
export type OnboardPairing =
  | {
      readonly kind: 'paired'
      readonly detections: readonly ObjectDetection[]
      /** How many the operator's gate refused alongside these, when any. */
      readonly refused?: number
    }
  /** Every box the firmware sent was refused by the operator's own gate — a
   *  DIFFERENT outcome from "the camera saw nothing", and the reason it has
   *  its own kind: a camera muted by its own settings must not read as idle. */
  | { readonly kind: 'gated'; readonly refused: number }
  | { readonly kind: 'none' }
  | { readonly kind: 'expired'; readonly ageMs: number }
  | { readonly kind: 'no-geometry'; readonly classes: readonly string[] }

/** Which root detectors this camera runs. */
export interface DetectionSourcePlan {
  readonly runsPipeline: boolean
  readonly runsOnboard: boolean
}

/**
 * Read the camera's `detectionSources`.
 *
 * ABSENT is the pipeline — a runner or an attach older than the field behaves
 * exactly as it always did. EMPTY is not the same thing and must never be
 * widened into "everything": it is a camera an operator left with no root
 * detector, and inventing one for them is how a default acts without anybody
 * choosing it.
 */
export function planDetectionSources(sources: DetectionSources | undefined): DetectionSourcePlan {
  if (sources === undefined) return { runsPipeline: true, runsOnboard: false }
  return {
    runsPipeline: sources.includes('pipeline'),
    runsOnboard: sources.includes('onboard'),
  }
}

/** Clamp a denormalised box into the frame; a firmware box may exceed it. */
function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(value, max))
}

/**
 * Pair the camera's last detections with a decoded frame, in the FRAME's pixel
 * space.
 *
 * The old converter denormalised against a nominal 1000×1000 when the push
 * carried no dimensions, and documented that consumers should treat a native
 * bbox as relative. That was survivable while nothing cut pixels from it. Here
 * the boxes travel with a real frame and a real handle, so they are scaled to
 * that frame — the same space every other detection on this plane lives in.
 */
export function onboardRootDetections(
  slot: OnboardDetectionSlot | null,
  frame: PairingFrame,
  gate?: MacroGateSettings,
): OnboardPairing {
  if (slot === null || slot.detections.length === 0) return { kind: 'none' }

  const ageMs = Math.abs(frame.timestamp - slot.at)
  if (ageMs > ONBOARD_PAIRING_MAX_AGE_MS) return { kind: 'expired', ageMs }

  const boxed = slot.detections.filter(
    (d): d is CameraNativeDetection & { bbox: readonly [number, number, number, number] } =>
      d.bbox != null,
  )
  if (boxed.length === 0) {
    return { kind: 'no-geometry', classes: slot.detections.map((d) => d.class) }
  }

  const detections: ObjectDetection[] = boxed.map((d, i) => {
    const [nx, ny, nw, nh] = d.bbox
    const x = clamp(nx * frame.width, frame.width)
    const y = clamp(ny * frame.height, frame.height)
    return {
      id: `onboard-${String(slot.at)}-${String(i)}`,
      kind: 'first-level',
      macroClass: d.class,
      // A firmware that ships no confidence is not a firmware that is certain.
      // 1 is what the native path has always used and what the thresholds on
      // this fleet were tuned against; changing it here would retune every
      // camera silently, so it stays and the honesty lives in `confidence`
      // being optional upstream.
      score: d.confidence ?? 1,
      labels: [],
      bbox: {
        x,
        y,
        width: clamp(nw * frame.width, frame.width - x),
        height: clamp(nh * frame.height, frame.height - y),
      },
    }
  })
  // THE OPERATOR'S GATE, on the path that never had it.
  //
  // `enabledMacroClasses` and the `minConfidence<Macro>` floors are applied by
  // the executor, and the firmware's boxes never enter it. Until now they
  // reached the tracker ungated: on device 106 that meant a "vehicle" at 0.30
  // spanning the whole frame, reported on every single frame, plus classes the
  // operator had never enabled. It is also why the recorder refused to act on
  // them at all — acting would have been a SECOND TRUTH, the sliders
  // describing one detection and the recording following another.
  //
  // Same authority the executor asks (`macroGateVerdict`), so the two roots
  // cannot drift apart. An absent gate passes everything, which is what a
  // camera with no root-step settings has always done.
  const admitted = detections.filter(
    (d) => macroGateVerdict(d.macroClass, d.score, gate) === 'pass',
  )
  if (admitted.length === 0) {
    return { kind: 'gated', refused: detections.length }
  }
  return {
    kind: 'paired',
    detections: admitted,
    ...(admitted.length < detections.length
      ? { refused: detections.length - admitted.length }
      : {}),
  }
}
