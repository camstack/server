/**
 * `createKeyFrameCrop` — the DURABLE last-resort crop for a DISPLAY consumer
 * whose LIVE capture missed every tier.
 *
 * The plate gallery crop is captured on the DETAIL plane (async, after the OCR
 * result routes back from the owning runner). In a cross-node session the frame
 * handle can be EVICTED on the runner by the time the hub re-fetches it, so both
 * live tiers (native ROI + retained full frame) return null and the plate row
 * persists with no image — even though the track's native `keyFrame` (the clean
 * best-shot full frame) is durably persisted in the MediaStore.
 *
 * This helper cuts the subject ROI out of that persisted `keyFrame`. It is the
 * only frame guaranteed to survive to track close.
 *
 * ## The rectangle and the pixels come from DIFFERENT instants
 *
 * That is the whole hazard, and both defects the 2026-08-30 triage found are
 * the same shape: a rectangle measured on frame A, cut from the pixels of
 * frame B. Two bounds are applied, in this order:
 *
 *  1. **Motion** ({@link subjectAgreement}) — the track's own `positions` trail
 *     says whether the subject occupied the same box at both instants. When it
 *     does, the rectangle is honest against those pixels HOWEVER large the skew
 * is (`7613c0fa`: 2579 ms of skew, IoU 1.000, plate perfectly framed
 *     refused by the time bound alone, and it should not have been). When it
 * does not, the crop is refused however SMALL the skew is (`4126f977`:
 * 531 ms, IoU 0.318, stored gravel; `e9c024bb`: 1179 ms, IoU 0.063, stored
 *     a windshield). Time was never the quantity that separated those.
 *  2. **Temporal** (`maxSkewMs`) — the fallback for when the trail carries no
 *     evidence about one of the two instants (no positions, or a trail
 *     downsampled past the moment). An absent read changes nothing (D49): the
 *     caller keeps exactly the bound it had before the motion guard existed.
 *
 * A refusal is REPORTED, never silent — a dropped crop is a missing gallery
 * tile the operator will notice long before anyone reads a counter, and the
 * silently-skipped thumbnail is what produced the triage in the first place.
 *
 * Pure factory: all IO is injected so the guard + crop contract is unit-tested
 * in isolation from the addon boot closure.
 */
import type { IScopedLogger } from '@camstack/types'
import { padBbox } from './bbox-pad.js'
import { type SubjectPathSample, subjectAgreement } from './subject-agreement.js'

export interface KeyFrameCropInput {
  /** Owning device — every line this helper writes is asked per-camera. */
  readonly deviceId: number
  /** Media id (D482) of the track's persisted native `keyFrame`. */
  readonly mediaId: number
  /** Subject bbox in the DETAIL frame's own pixel space. */
  readonly bbox: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
  readonly frameWidth: number
  readonly frameHeight: number
  readonly padding: number
  /**
   * The instant the {@link bbox} was MEASURED (ms) — the plate read, or the
   * best-seen observation. NEVER the keyFrame's own timestamp: passing that
   * makes the skew 0 by construction and disarms the guard entirely, which is
   * exactly the 2026-08-24 regression this contract now names.
   */
  readonly timestamp: number
  /**
   * The track's position trail, for the motion guard. Absent (or empty) leaves
   * only the temporal bound — the pre-guard behaviour, never a silent pass.
   */
  readonly subjectPath?: readonly SubjectPathSample[]
}

export interface KeyFrameCropDeps {
  /** Fetch the persisted media row (JPEG bytes + its frame timestamp). No base64 (D867). */
  readonly getMedia: (mediaId: number) => Promise<{ bytes: Buffer; timestamp: number } | null>
  /** Decode a JPEG into raw RGB. */
  readonly decodeJpegToRgb: (
    jpeg: Uint8Array,
  ) => Promise<{ bytes: Buffer; width: number; height: number }>
  /** Crop a normalized region out of a full RGB frame and JPEG-encode it. */
  readonly cropRegionToJpeg: (
    bytes: Buffer,
    width: number,
    height: number,
    norm: { x: number; y: number; w: number; h: number },
  ) => Promise<Buffer>
  /** Max |keyFrame.ts − measured.ts| (ms) accepted when the position trail
   *  carries NO motion evidence about the two instants. */
  readonly maxSkewMs: number
  /** Subject-box IoU across the two instants at or above which the crop is
   *  accepted regardless of skew. */
  readonly minSubjectIou: number
  /** How far a trail sample may sit from an instant and still be evidence
   *  about it (beyond this the motion verdict is `unknown`). */
  readonly maxSubjectSampleGapMs: number
  readonly logger: IScopedLogger
}

/** What the guard concluded, carried out so the caller can log it on the ONE
 *  line it already writes about the derive. */
export type KeyFrameCropMotionVerdict = 'agrees' | 'unknown'

export interface KeyFrameCropResult {
  readonly jpeg: Buffer
  readonly skewMs: number
  /** `agrees` = the trail proved the subject stood still across the skew;
   *  `unknown` = no evidence, the crop passed on the temporal bound alone. */
  readonly motion: KeyFrameCropMotionVerdict
  /** Subject-box IoU across the two instants, absent when `motion` is
   *  `unknown` — never `0`, which would read as "measured, and it moved". */
  readonly subjectIou?: number
}

export type KeyFrameCropFn = (input: KeyFrameCropInput) => Promise<KeyFrameCropResult | null>

export function createKeyFrameCrop(deps: KeyFrameCropDeps): KeyFrameCropFn {
  return async (input) => {
    if (input.frameWidth <= 0 || input.frameHeight <= 0) return null
    const media = await deps.getMedia(input.mediaId)
    if (!media) return null
    const skewMs = Math.abs(media.timestamp - input.timestamp)
    const verdict = subjectAgreement({
      path: input.subjectPath ?? [],
      measuredAtMs: input.timestamp,
      cutFromMs: media.timestamp,
      minIou: deps.minSubjectIou,
      maxSampleGapMs: deps.maxSubjectSampleGapMs,
    })
    if (verdict.kind === 'moved') {
      deps.logger.info('keyframe crop refused — subject moved between the two instants', {
        tags: { deviceId: input.deviceId },
        meta: {
          mediaId: input.mediaId,
          skewMs,
          subjectIou: verdict.iou,
          minSubjectIou: deps.minSubjectIou,
          sampleGapMs: verdict.sampleGapMs,
        },
      })
      return null
    }
    if (verdict.kind === 'unknown' && skewMs > deps.maxSkewMs) {
      deps.logger.info('keyframe crop refused — temporal skew too large, no motion evidence', {
        tags: { deviceId: input.deviceId },
        meta: {
          mediaId: input.mediaId,
          skewMs,
          maxSkewMs: deps.maxSkewMs,
          unknownReason: verdict.reason,
        },
      })
      return null
    }
    try {
      const rgb = await deps.decodeJpegToRgb(media.bytes)
      if (rgb.width <= 0 || rgb.height <= 0) return null
      const norm = padBbox(
        {
          x: input.bbox.x / input.frameWidth,
          y: input.bbox.y / input.frameHeight,
          w: input.bbox.w / input.frameWidth,
          h: input.bbox.h / input.frameHeight,
        },
        input.padding,
      )
      const jpeg = await deps.cropRegionToJpeg(rgb.bytes, rgb.width, rgb.height, norm)
      return verdict.kind === 'agrees'
        ? { jpeg, skewMs, motion: 'agrees', subjectIou: verdict.iou }
        : { jpeg, skewMs, motion: 'unknown' }
    } catch (err) {
      deps.logger.debug('keyframe crop derive failed', {
        tags: { deviceId: input.deviceId },
        meta: { mediaId: input.mediaId, error: err instanceof Error ? err.message : String(err) },
      })
      return null
    }
  }
}
