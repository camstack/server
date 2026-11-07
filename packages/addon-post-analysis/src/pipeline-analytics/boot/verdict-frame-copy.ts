/**
 * A verdict tap lands a TRAINING FRAME, not only a mark.
 *
 * The mark (`markForTrain`) puts a track in retrain staging; both retrain
 * screens read only the copied-frames corpus, so a marked track with no copy is
 * invisible there. After the mark, the frame the operator judged is copied
 * (`selectRetrainFrames`, copy-on-select): the stored row the notification's
 * picture was built from when the grant froze one, else the track's best
 * whole-frame candidate (`autoPickRetrainFrame`).
 *
 * Never throws: the verdict and the mark already stand, a copy that cannot be
 * taken is a named outcome and a log line carrying the camera.
 */

import type {
  IScopedLogger,
  MediaFileKind,
  RetrainFrameList,
  RetrainFrameSelection,
} from '@camstack/types'
import { errMsg } from '@camstack/types'
import {
  autoPickRetrainFrame,
  isRetrainFrameKind,
} from '../retrain/retrain-frame-selection.js'

/** The slice of `pipelineAnalytics` the copy calls. */
export interface VerdictFrameCopyApi {
  listRetrainFrames(input: { trackId: string }): Promise<RetrainFrameList>
  selectRetrainFrames(input: {
    deviceId: number
    trackId: string
    mediaIds: number[]
  }): Promise<RetrainFrameSelection>
}

export interface VerdictFrameCopyInput {
  readonly deviceId: number
  readonly trackId: string
  /** The row the notification's picture was built from, when the grant froze one. */
  readonly sourceMedia?: { readonly mediaId: number; readonly kind: MediaFileKind }
}

export type VerdictFrameCopyOutcome =
  | { readonly ok: true; readonly via: 'frozen' | 'auto-pick'; readonly mediaId: number }
  | { readonly ok: false; readonly reason: string }

/** Copy ONE frame of the track into the retrain corpus; see the file header. */
export async function copyVerdictFrame(
  api: VerdictFrameCopyApi,
  logger: IScopedLogger,
  input: VerdictFrameCopyInput,
): Promise<VerdictFrameCopyOutcome> {
  const tags = { deviceId: input.deviceId }
  const refuse = (reason: string, meta: Record<string, unknown>): VerdictFrameCopyOutcome => {
    logger.warn('verdict frame not copied — the track stays marked without a training frame', {
      tags,
      meta: { trackId: input.trackId, reason, ...meta },
    })
    return { ok: false, reason }
  }
  try {
    const frozen = input.sourceMedia
    if (frozen !== undefined && !isRetrainFrameKind(frozen.kind)) {
      logger.info('verdict frame — the frozen frame is not a clean whole frame, using the best one', {
        tags,
        meta: { trackId: input.trackId, mediaId: frozen.mediaId, kind: frozen.kind },
      })
    }
    if (frozen !== undefined && isRetrainFrameKind(frozen.kind)) {
      const picked = await api.selectRetrainFrames({
        deviceId: input.deviceId,
        trackId: input.trackId,
        mediaIds: [frozen.mediaId],
      })
      if (picked.copied.length > 0) {
        logger.info('verdict frame copied — the frame the notification showed', {
          tags,
          meta: { trackId: input.trackId, mediaId: frozen.mediaId, kind: frozen.kind },
        })
        return { ok: true, via: 'frozen', mediaId: frozen.mediaId }
      }
      logger.info('verdict frame — the frozen frame was refused, falling back to the best frame', {
        tags,
        meta: {
          trackId: input.trackId,
          mediaId: frozen.mediaId,
          refused: picked.refused.map((r) => r.reason),
        },
      })
    }
    const listing = await api.listRetrainFrames({ trackId: input.trackId })
    const best = autoPickRetrainFrame(
      listing.candidates.filter((c) => c.mediaId !== frozen?.mediaId),
    )
    if (best === null) {
      return refuse('no-candidate-frame', {
        frozen: frozen !== undefined,
        candidates: listing.candidates.length,
      })
    }
    const picked = await api.selectRetrainFrames({
      deviceId: input.deviceId,
      trackId: input.trackId,
      mediaIds: [best.mediaId],
    })
    if (picked.copied.length === 0) {
      return refuse(picked.refused[0]?.reason ?? 'copy-refused', {
        mediaId: best.mediaId,
        refused: picked.refused.map((r) => r.reason),
      })
    }
    logger.info('verdict frame copied — the track\'s best frame', {
      tags,
      meta: { trackId: input.trackId, mediaId: best.mediaId, kind: best.kind },
    })
    return { ok: true, via: 'auto-pick', mediaId: best.mediaId }
  } catch (err: unknown) {
    return refuse('copy-threw', { error: errMsg(err) })
  }
}
