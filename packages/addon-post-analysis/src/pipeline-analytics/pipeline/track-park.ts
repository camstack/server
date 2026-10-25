/**
 * What the hub ORDERS parked the instant a frame is judged a track's best
 * ([D422](../../../../../docs/decisions/adr-0422-a-relevant-frame-is-parked-when-it-becomes-relevant.md)).
 *
 * The decision itself is `BestDetectionTracker`'s — the single "best per
 * track" policy — and this module adds no opinion about what "best" means
 * (D62). It only turns an accepted frame into the two parcels every later
 * consumer reads by `(deviceId, trackId, kind)`:
 *
 *  - `keyFrame` — the WHOLE frame at the native cap. The clean best full
 *    frame `keyFrame` + `keyFrameSmall` are written from, and the image the
 *    detail plane's full-frame rung and the embedding rebuild cut from. Full
 *    frame on purpose: the runner derives every detail rectangle itself
 *    (D52), so the parcel must hold the whole scene.
 *  - `thumbnail` — the best-shot subject slab, cut by the runner to the SAME
 *    16:9 central-square window the best shot has always been framed with
 *    (`deliveredWideCentralSquareLayout`). One framing rule; the layout rides
 *    on the order so the hub can compose the parcel onto its canvas later.
 *
 * Pure. The client that sends these (`runtime/parked-frame-client.ts`) is
 * where the RPC, the in-flight coalescing and the failure log live.
 */
import type { FrameHandle, ParkedFrameKind } from '@camstack/types'
import {
  deliveredWideCentralSquareLayout,
  type WideCentralSquareLayout,
} from '../../shared/frame/wide-central-square-crop.js'
import { KEYFRAME_NATIVE_MAX_WIDTH } from './key-frame-capture.js'

/** A pixel-space box in the detection frame the tracker ran on. */
export interface ParkSubjectBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** A normalized [0,1] window in the frame's own space. */
export interface ParkWindow {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/**
 * Where the subject was in the frame being parked, in DETECTION space. Kept
 * beside the parcel on the hub so a later consumer that needs a rectangle on
 * the parked image (the detail plane) can scale this box into the parcel's
 * pixel space — the parcel is native-resolution, the box is not.
 */
export interface ParkSubject {
  readonly bbox: ParkSubjectBox
  readonly frameWidth: number
  readonly frameHeight: number
}

/** One PARK the hub sends to the node that owns the handle. */
export interface ParkOrder {
  readonly deviceId: number
  readonly trackId: string
  readonly kind: ParkedFrameKind
  readonly handle: FrameHandle
  /** The window the RUNNER cuts. `{0,0,1,1}` = the whole frame. */
  readonly bbox: ParkWindow
  /** Width cap for a full-frame park; absent = uncapped native. */
  readonly maxWidth?: number
  /** The frame instant (hub clock) — orders parks for one key on the node. */
  readonly timestamp: number
  readonly subject: ParkSubject
  /** The thumbnail's framing, kept so the parcel can be composed later. */
  readonly layout?: WideCentralSquareLayout
}

/** The accepted best frame, as `buildSnapshotTargets` sees it. */
export interface ParkDecision {
  readonly deviceId: number
  readonly trackId: string
  readonly timestamp: number
  readonly frameHandle: FrameHandle
  readonly bbox: ParkSubjectBox
  readonly frameWidth: number
  readonly frameHeight: number
}

/** The whole frame — what a `keyFrame` park cuts. */
const FULL_FRAME: ParkWindow = { x: 0, y: 0, w: 1, h: 1 }

/** The two parcels a best-frame decision orders, in a fixed order. */
export function buildParkOrders(decision: ParkDecision): readonly ParkOrder[] {
  const subject: ParkSubject = {
    bbox: { ...decision.bbox },
    frameWidth: decision.frameWidth,
    frameHeight: decision.frameHeight,
  }
  const layout = deliveredWideCentralSquareLayout(decision.bbox, {
    W: decision.frameWidth,
    H: decision.frameHeight,
  })
  const base = {
    deviceId: decision.deviceId,
    trackId: decision.trackId,
    handle: decision.frameHandle,
    timestamp: decision.timestamp,
    subject,
  }
  return [
    { ...base, kind: 'keyFrame', bbox: FULL_FRAME, maxWidth: KEYFRAME_NATIVE_MAX_WIDTH },
    { ...base, kind: 'thumbnail', bbox: layout.fetch, layout },
  ]
}

/**
 * The subject's box in the PARCEL's pixel space. The box was measured on the
 * ≤640 detection raster; the parcel is native-resolution. Both show the same
 * scene at the same aspect, so a uniform per-axis scale places the box on the
 * parcel — the runner then derives the crop rectangle from it (D52).
 */
export function scaleSubjectIntoParcel(
  subject: ParkSubject,
  parcelWidth: number,
  parcelHeight: number,
): ParkSubjectBox {
  const sx = parcelWidth / subject.frameWidth
  const sy = parcelHeight / subject.frameHeight
  return {
    x: subject.bbox.x * sx,
    y: subject.bbox.y * sy,
    w: subject.bbox.w * sx,
    h: subject.bbox.h * sy,
  }
}
