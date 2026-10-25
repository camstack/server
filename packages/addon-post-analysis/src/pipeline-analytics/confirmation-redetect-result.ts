/**
 * The executor's answer to a confirmation re-detect, turned into what the gate
 * judges. PURE — the one place the production mapping lives, so a spec can
 * hold it to the shape the executor really returns.
 *
 * Two halves of the `FrameResult` are read:
 *  - `detections`, the boxes the detector KEPT;
 *  - `discarded` entries with reason `below-threshold`, the boxes the
 *    detector's own per-class floor REFUSED (person 0.65, others 0.5). Without
 *    them a compatible subject scored between the gate's bar and that floor
 *    arrived as "nothing", and every suppression was recorded with no score
 *    (D922). The GATE'S bar decides both halves (D925): the per-class floor is
 *    the live tracker's bar, not the gate's. They stay marked
 *    `refusedByDetectorFloor` so a suppression can say which kind it was.
 *
 * A `class-filter`, `full-frame-guard` or `zone-gate` discard is not a score
 * the gate could have used and is left out.
 */
import type { ConfirmationDetection } from './confirmation-gate.js'

/** A box in the crop's own pixels, as the executor's survivors carry it. */
interface RedetectBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** One surviving detection of the re-detect run. */
interface RedetectDetection {
  readonly macroClass: string
  readonly score: number
  readonly bbox?: RedetectBox
}

/** One discarded box — `[x1, y1, x2, y2]` in the crop's pixels (`DiscardedDetection`). */
interface RedetectDiscard {
  readonly macroClass: string
  readonly score: number
  readonly reason: string
}

/**
 * The slice of the executor's `FrameResult` the confirmation gate reads back
 * from a crop: classes and scores, each kept box in the crop's own pixels and
 * the crop's decoded size (the two halves that place a secondary subject), and
 * the boxes the detector's floor refused.
 */
export interface ConfirmationRedetectResult {
  readonly width?: number
  readonly height?: number
  readonly detections?: readonly RedetectDetection[]
  readonly discarded?: readonly RedetectDiscard[]
  /** The root model the executor RAN (`FrameResult.rootModelId`) — checked
   *  against the session detector (D925). */
  readonly rootModelId?: string
  /** The device pool it ran on (`FrameResult.rootDeviceKey`, D925). */
  readonly rootDeviceKey?: string
}

/** Map a re-detect result to the gate's input; `null` when it carried no detections array. */
export function toConfirmationDetections(
  result: ConfirmationRedetectResult | null | undefined,
): readonly ConfirmationDetection[] | null {
  const detections = result?.detections
  if (!result || !detections) return null
  // The box, normalised to the CROP the executor decoded — its own
  // `width`/`height` are that crop's — so the gate can put a secondary
  // subject back into the frame without knowing the crop's pixel size.
  const cropWidth = result.width ?? 0
  const cropHeight = result.height ?? 0
  const kept = detections.map(
    (d): ConfirmationDetection => ({
      macroClass: d.macroClass,
      score: d.score,
      ...(d.bbox !== undefined && cropWidth > 0 && cropHeight > 0
        ? {
            bbox: {
              x: d.bbox.x / cropWidth,
              y: d.bbox.y / cropHeight,
              w: d.bbox.width / cropWidth,
              h: d.bbox.height / cropHeight,
            },
          }
        : {}),
    }),
  )
  const refused = (result.discarded ?? [])
    .filter((d) => d.reason === 'below-threshold')
    .map(
      (d): ConfirmationDetection => ({
        macroClass: d.macroClass,
        score: d.score,
        refusedByDetectorFloor: true,
      }),
    )
  return [...kept, ...refused]
}
