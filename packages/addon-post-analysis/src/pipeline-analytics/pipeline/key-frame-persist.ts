/**
 * ONE track's native `keyFrame` write — the exec body of `persistKeyFrames`,
 * lifted out of the addon so its outcome is a value instead of a side effect.
 *
 * ## What it reads, since D422
 *
 * The track's PARKED key frame, by `(deviceId, trackId)`. The pixels were
 * copied on the owning node the instant `BestDetectionTracker` judged the
 * frame the track's best
 * ([D422](../../../../../docs/decisions/adr-0422-a-relevant-frame-is-parked-when-it-becomes-relevant.md)),
 * so nothing here can miss on AGE — there is no frame handle in this file,
 * and a retrieval keyed by a track never falls back to one
 * (`scripts/check-parked-frame-no-handle-fallback.ts`).
 *
 * The parcel is the runner's own JPEG and is stored VERBATIM: one encode, on
 * the node, at the instant it mattered. The web companion `keyFrameSmall` is
 * derived from those same bytes — never a second fetch, the same property the
 * by-handle version had (`encodeKeyFrameVariants`: "one native surface, two
 * outputs"), now with one fewer encode.
 *
 * ## Why it moved (unchanged)
 *
 * The capture has drop branches, and one of them was invisible. On
 * 2026-08-06, 403 of the day's key-frame misses were a THROW swallowed at
 * `debug`. Inside a 7,000-line class none of that was assertable; here every
 * branch is one test, and the outcome feeds BOTH the retry bookkeeping and
 * the per-device window (`key-frame-metrics.ts`) from one value.
 */

import type { IScopedLogger } from '@camstack/types'
import { errMsg } from '@camstack/types'
import type { MediaSubjectBox } from '../store/media-store.js'

/**
 * How a key-frame write ended.
 *
 * `parcel-missing` is the one loss this path can still suffer: the park at
 * the best instant was refused (already logged there, with the handle's age)
 * or the node evicted the parcel (logged by the client, with the node). The
 * bounded retry (`key-frame-retry.ts`) parks a LATER frame and comes back.
 */
export type KeyFrameCaptureOutcome =
  | { readonly kind: 'landed'; readonly keyFrameMediaId: number }
  | { readonly kind: 'parcel-missing' }
  | { readonly kind: 'error'; readonly error: string }

/** The one media-store operation this write performs, structurally. */
export interface KeyFrameMediaWriter {
  putReplacing(input: {
    readonly deviceId: number
    readonly ownerKind: 'track'
    readonly ownerId: string
    readonly kind: 'keyFrame' | 'keyFrameSmall'
    readonly timestamp: number
    readonly data: Buffer
    /** Where the subject was on THIS frame (D510). Omitted when the park's
     *  mirror could not say. */
    readonly subjectBox?: MediaSubjectBox
  }): Promise<number>
}

/** The parked key frame as the client hands it over — bytes plus provenance. */
export interface ParkedKeyFrame {
  readonly jpeg: Buffer
  readonly width: number
  readonly height: number
  /** The frame instant the parcel shows — what the media row is stamped with. */
  readonly timestamp: number
  /** The node that held the pixels, for the per-node gap question. */
  readonly nodeId: string
  /**
   * The subject's box on the frame that was parked, in DETECTION space — the
   * `ParkSubject` the hub kept beside the parcel when it ordered the park
   * (D422), handed on here so the media row can carry it (D510).
   *
   * This is the whole point of writing it HERE rather than pairing later: the
   * parcel and the box are two halves of ONE instant. Optional because a
   * parcel from a runner that predates the mirror carries none, and a row with
   * no box is exactly the pre-D510 behaviour.
   */
  readonly subject?: MediaSubjectBox
}

export interface KeyFramePersistDeps {
  /** The track's parked key frame, by track. `null` = none parked. */
  fetchParkedKeyFrame(deviceId: number, trackId: string): Promise<ParkedKeyFrame | null>
  /** `keyFrameSmall` from the SAME bytes — never a second fetch. */
  deriveSmall(jpeg: Buffer): Promise<Buffer>
  readonly media: KeyFrameMediaWriter
  readonly logger: IScopedLogger
}

export interface KeyFramePersistInput {
  readonly deviceId: number
  readonly trackId: string
  /** True when this fires from the bounded retry path, not a new-best peak.
   *  Carried into every log line so a per-camera recovery rate is readable. */
  readonly retry: boolean
}

/**
 * A box is written only when it can be USED — a degenerate rectangle, or one
 * measured on a degenerate frame, says nothing and would read back as a box at
 * the origin. Absent is the honest answer; the reader then pairs a snapshot,
 * exactly as it did before D510.
 *
 * Its result is spread into BOTH writes: the small companion is derived from
 * the very bytes of the native one, so it is the same scene at the same
 * instant and the box maps into it by ratio like any other scale of the frame.
 * A box on one row and not the other would make the summary's answer depend on
 * which row a reader happened to pick.
 */
function isStatableSubject(subject: MediaSubjectBox | undefined): subject is MediaSubjectBox {
  if (subject === undefined) return false
  return subject.w > 0 && subject.h > 0 && subject.frameWidth > 0 && subject.frameHeight > 0
}

/**
 * Read, derive and store one track's key frame + its web companion.
 *
 * PARCEL-OR-NOTHING: no parcel writes nothing and the caller's bounded retry
 * parks a later frame. The `keyFrame` write lands FIRST and its media id (D482)
 * is what the outcome carries — a `keyFrameSmall` failure afterwards must not
 * re-arm a retry that would re-shoot a key frame the rebuild can already read.
 */
export async function persistTrackKeyFrame(
  deps: KeyFramePersistDeps,
  input: KeyFramePersistInput,
): Promise<KeyFrameCaptureOutcome> {
  const { deviceId, trackId, retry } = input
  // Every line below carries `tags: { deviceId }`. A key-frame gap is always
  // asked per camera ("why is 102 worse than 101?").
  const drop = { tags: { deviceId }, meta: { trackId, retry } }
  try {
    const parcel = await deps.fetchParkedKeyFrame(deviceId, trackId)
    if (parcel === null || parcel.jpeg.byteLength === 0) {
      // The park was refused at the best instant (logged there, with the
      // handle's age) or the node let the parcel go (logged by the client).
      // This is the write that did not happen because of it.
      deps.logger.error('key-frame parcel missing — nothing to write, retry parks a later frame', {
        ...drop,
      })
      return { kind: 'parcel-missing' }
    }
    const subjectBox = isStatableSubject(parcel.subject) ? { subjectBox: parcel.subject } : {}
    const keyFrameMediaId = await deps.media.putReplacing({
      deviceId,
      ownerKind: 'track',
      ownerId: trackId,
      kind: 'keyFrame',
      timestamp: parcel.timestamp,
      data: parcel.jpeg,
      ...subjectBox,
    })
    try {
      const keyFrameSmall = await deps.deriveSmall(parcel.jpeg)
      await deps.media.putReplacing({
        deviceId,
        ownerKind: 'track',
        ownerId: trackId,
        kind: 'keyFrameSmall',
        timestamp: parcel.timestamp,
        data: keyFrameSmall,
        ...subjectBox,
      })
    } catch (err) {
      // The native key frame — the only thing a rebuild reads — is already
      // durable. Losing the web companion is a display regression, not a
      // re-embeddability one, so it must not reopen the retry.
      deps.logger.warn('keyFrameSmall write failed — the native keyFrame is stored', {
        ...drop,
        meta: { ...drop.meta, nodeId: parcel.nodeId, error: errMsg(err) },
      })
    }
    deps.logger.debug('key frame written from the parked parcel', {
      ...drop,
      meta: {
        ...drop.meta,
        nodeId: parcel.nodeId,
        width: parcel.width,
        height: parcel.height,
        bytes: parcel.jpeg.byteLength,
        parkedTimestamp: parcel.timestamp,
      },
    })
    return { kind: 'landed', keyFrameMediaId }
  } catch (err) {
    // FIX (2026-08-06): this was `debug`. 403 of the day's misses were a
    // CapRouteError thrown here and nothing said so.
    const error = errMsg(err)
    deps.logger.warn('key-frame write failed', { ...drop, meta: { ...drop.meta, error } })
    return { kind: 'error', error }
  }
}
