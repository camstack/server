/**
 * debug-crop-capture — cuts the rectangle {@link planDebugCrop} chose, burns
 * the attribution into it, stores it, and NAMES every way it can decline.
 *
 * ## The gate is first, and it is free
 *
 * Nothing here runs for a track the operator has not marked. {@link
 * DebugCropCaptureDeps.isDebugMarked} is a lookup in the per-track resident map
 * the frame path already holds — no store read, no frame fetch, no log line —
 * so a camera with no marked track pays one map hit per decision and stops. It
 * lives HERE rather than at each call site so a fourth decision site cannot
 * forget it, and it returns silently on purpose: a designed no-op is not
 * dropped work, and a line per frame per camera is precisely what the gate
 * exists to avoid.
 *
 * ## The order of operations
 *
 * The frame is fetched only after the gate and the per-track cap have both said
 * yes — a cross-process full-frame fetch is the expensive thing in this file,
 * and fetching one we have already decided not to use would make a marked track
 * cost the transport something for the whole of its life.
 *
 * Then the crop is cut RAW first ({@link extractCropRaw}) and the boxes are
 * drawn on the CROP, not on the frame. Drawing on the frame and then cutting
 * would render a 3 px stroke and a caption sized for a 1920 px scene into a
 * 200 px window — the caption would be a smear and the stroke would swallow a
 * small subject.
 *
 * ## The two coordinate spaces, and the scale between them
 *
 * The subject/rival boxes arrive in the DETECTION frame's pixel space. The
 * frame that comes back is capped to {@link DebugCropCaptureDeps.fetchFrameRgb}'s
 * own width and is generally SMALLER. The plan is therefore computed in the
 * detection space and travels as its NORMALIZED rectangle, which addresses
 * either surface (the cap preserves aspect); the drawn boxes are then scaled by
 * the ratio the actual cut reports. Skipping that scale draws every box at
 * twice its size, beside the subject rather than on it.
 *
 * ## Every exit that stores nothing says why
 *
 * Six of them ({@link DebugCropSkipReason}), each logged with
 * `tags: { deviceId }` and the crop's own attribution. Before this they would
 * all have looked identical from the outside: no crop. That
 * indistinguishability is what D391 is about, and it is what made the
 * 2026-09-18 traces cost a morning.
 *
 * Pure factory: all IO is injected, so the refusal vocabulary, the bound and
 * the scale are unit-tested without sharp, the transport or the media store.
 */

import type { FrameHandle, IScopedLogger } from '@camstack/types'
import type { FrameBox } from '../../shared/frame/box-drawer.js'
import {
  DEBUG_CROPS_PER_TRACK_MAX,
  type DebugCropAttribution,
  type DebugCropDecision,
  type DebugCropEvidence,
  type DebugCropNormRegion,
  debugCropLabel,
  debugCropMeta,
  planDebugCrop,
} from './debug-crop-plan.js'
import type { PixelBox } from './edge-clear.js'

/** A full frame in raw RGB — what the cut needs. */
export interface DebugCropFrameRgb {
  readonly bytes: Buffer
  readonly width: number
  readonly height: number
}

/**
 * The full-frame fetch by handle, capped. `null` on any miss — an expired
 * lease, a node that went away, version skew, or a scheduler shed.
 *
 * `deviceId` / `trackId` travel with it because the host routes this through
 * the `CaptureScheduler` (S4: ALL native capture pressure is scheduler-owned)
 * and both are part of the coalesce key — two decisions on one frame of one
 * track must cost ONE fetch, not two.
 */
export type DebugCropFetchFrameFn = (
  handle: FrameHandle,
  deviceId: number,
  trackId: string,
) => Promise<DebugCropFrameRgb | null>

/** The raw cut (`shared/frame/crop-extractor.ts#extractCropRaw`). */
export type DebugCropExtractRawFn = (
  frameData: Buffer,
  frameWidth: number,
  frameHeight: number,
  bbox: DebugCropNormRegion,
) => Promise<{ data: Buffer; width: number; height: number }>

/** The annotate+encode (`shared/frame/box-drawer.ts#drawBoxedFrame`). */
export type DebugCropDrawFn = (
  frameData: Buffer,
  frameWidth: number,
  frameHeight: number,
  boxes: readonly FrameBox[],
  options?: { maxWidth?: number; quality?: number },
) => Promise<Buffer>

/** What the store is handed. A media row carries no note column, which is why
 *  the attribution is in the pixels and on the log line rather than here. */
export interface DebugCropStoreInput {
  readonly deviceId: number
  readonly trackId: string
  readonly timestamp: number
  readonly data: Buffer
}

export type DebugCropStoreFn = (input: DebugCropStoreInput) => Promise<number>

export interface DebugCropCaptureDeps {
  /** The operator's flag, from `TrackResidentState`. A map lookup — see the
   *  module doc: this is what keeps an unmarked fleet free. */
  readonly isDebugMarked: (trackId: string) => boolean
  readonly fetchFrameRgb: DebugCropFetchFrameFn
  readonly extractCropRaw: DebugCropExtractRawFn
  readonly drawBoxedFrame: DebugCropDrawFn
  readonly putDebugCrop: DebugCropStoreFn
  readonly logger: IScopedLogger
}

export interface DebugCropCaptureInput {
  readonly deviceId: number
  readonly trackId: string
  readonly decision: DebugCropDecision
  /** The box the decision was about, in the DETECTION frame's pixel space. */
  readonly subject: PixelBox
  /** The competing box, same space, when the decision picked between two. */
  readonly rival?: PixelBox
  /** The other track's id, when the rival is one. */
  readonly rivalTrackId?: string
  readonly frameHandle: FrameHandle
  /** The DETECTION frame's dims — the space {@link subject} is expressed in. */
  readonly frameWidth: number
  readonly frameHeight: number
  readonly timestamp: number
  /** The numbers the decision rested on, from the deciding site. */
  readonly evidence: DebugCropEvidence
}

/** Why nothing was stored. Each value is a real branch, and each one used to be
 *  indistinguishable from the others. */
export type DebugCropSkipReason =
  | 'degenerate-frame'
  | 'degenerate-subject'
  | 'per-track-cap'
  | 'frame-unavailable'
  | 'render-failed'
  | 'store-failed'

export type DebugCropCaptureFn = (input: DebugCropCaptureInput) => Promise<number | null>

/** Stroke colour of the box the decision was ABOUT. */
const SUBJECT_COLOR = '#00e5ff'
/** Stroke colour of the box it was weighed AGAINST — a different colour,
 *  because "which one is which" is the first question a two-box crop raises. */
const RIVAL_COLOR = '#ff9500'
/** Encode quality: a debug crop is read by a person looking for a defect, so it
 *  is encoded above the timeline-tile default (80) — a JPEG artefact that reads
 *  as a mirror edge would waste the very investigation this exists for. */
const DEBUG_CROP_QUALITY = 92

/** Bound the per-track counters so a long-lived process never leaks them. */
const MAX_TRACKED_TRACKS = 2_000

export function createDebugCropCapture(deps: DebugCropCaptureDeps): DebugCropCaptureFn {
  const storedPerTrack = new Map<string, number>()
  const cappedAnnounced = new Set<string>()

  const skip = (
    input: DebugCropCaptureInput,
    reason: DebugCropSkipReason,
    extra: DebugCropEvidence,
  ): null => {
    deps.logger.info('debug crop not stored', {
      tags: { deviceId: input.deviceId },
      meta: {
        reason,
        decision: input.decision,
        trackId: input.trackId,
        timestamp: input.timestamp,
        ...extra,
      },
    })
    return null
  }

  return async (input) => {
    // THE FREE GATE. First, silent, and before anything that costs.
    if (!deps.isDebugMarked(input.trackId)) return null

    const already = storedPerTrack.get(input.trackId) ?? 0
    if (already >= DEBUG_CROPS_PER_TRACK_MAX) {
      // ONCE per track: the cap fires on every later frame of a busy marked
      // track, and a line per frame would bury the crops it is guarding.
      if (cappedAnnounced.has(input.trackId)) return null
      if (cappedAnnounced.size >= MAX_TRACKED_TRACKS) cappedAnnounced.clear()
      cappedAnnounced.add(input.trackId)
      return skip(input, 'per-track-cap', { stored: already, cap: DEBUG_CROPS_PER_TRACK_MAX })
    }

    // The PLAN is computed in the detection space, before the fetch: it is free,
    // and a degenerate box must not cost a full-frame round trip.
    const plan = planDebugCrop({
      decision: input.decision,
      subject: input.subject,
      ...(input.rival === undefined ? {} : { rival: input.rival }),
      frameWidth: input.frameWidth,
      frameHeight: input.frameHeight,
    })
    if (plan.kind === 'refused') return skip(input, plan.reason, {})

    const attribution: DebugCropAttribution = {
      decision: input.decision,
      trackId: input.trackId,
      ...(input.rivalTrackId === undefined ? {} : { rivalTrackId: input.rivalTrackId }),
      timestamp: input.timestamp,
      evidence: input.evidence,
    }
    const meta = debugCropMeta(plan, attribution)

    const frame = await deps.fetchFrameRgb(input.frameHandle, input.deviceId, input.trackId)
    if (frame === null || frame.width <= 0 || frame.height <= 0) {
      return skip(input, 'frame-unavailable', { nodeId: input.frameHandle.nodeId })
    }

    let jpeg: Buffer
    try {
      // The normalized rectangle addresses the fetched surface whatever its
      // width — the cap preserves aspect.
      const cut = await deps.extractCropRaw(frame.bytes, frame.width, frame.height, plan.norm)
      // …but the BOXES are detection-space pixels, so they need the ratio the
      // cut actually came back with. Drawing them unscaled puts every box
      // beside its subject instead of on it.
      const scale = plan.rect.w > 0 ? cut.width / plan.rect.w : 1
      // The subject box carries the whole caption; the rival carries only its
      // role, so two captions never overlap on a small crop.
      const boxes: readonly FrameBox[] = plan.boxes.map((b) => {
        const geometry = { x: b.x * scale, y: b.y * scale, w: b.w * scale, h: b.h * scale }
        return b.role === 'subject'
          ? { ...geometry, color: SUBJECT_COLOR, label: debugCropLabel(plan, attribution) }
          : { ...geometry, color: RIVAL_COLOR, label: 'rival' }
      })
      jpeg = await deps.drawBoxedFrame(cut.data, cut.width, cut.height, boxes, {
        quality: DEBUG_CROP_QUALITY,
      })
    } catch (err) {
      return skip(input, 'render-failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }

    try {
      const mediaId = await deps.putDebugCrop({
        deviceId: input.deviceId,
        trackId: input.trackId,
        timestamp: input.timestamp,
        data: jpeg,
      })
      if (storedPerTrack.size >= MAX_TRACKED_TRACKS) storedPerTrack.clear()
      storedPerTrack.set(input.trackId, already + 1)
      // The crop's own numbers, greppable. The caption says the same thing to
      // anyone who only has the picture; this says it to anyone who only has
      // the log, and the two are built from ONE bag so they cannot disagree.
      deps.logger.info('debug crop stored', {
        tags: { deviceId: input.deviceId },
        meta: { ...meta, mediaId, deviceId: input.deviceId },
      })
      return mediaId
    } catch (err) {
      // A warn, not a debug: the operator asked for this crop by marking the
      // track, and a crop they asked for and did not get is the failure mode
      // this whole module exists to end.
      deps.logger.warn('debug crop store failed', {
        tags: { deviceId: input.deviceId },
        meta: { ...meta, error: err instanceof Error ? err.message : String(err) },
      })
      return null
    }
  }
}
