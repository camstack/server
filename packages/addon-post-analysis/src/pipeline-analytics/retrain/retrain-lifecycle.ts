/**
 * The two lifecycle moves that belong to the RETRAIN PAGE and to nothing else.
 *
 * [D81](../../../../../docs/decisions/adr-0081.md) gave the track three states
 * and then deliberately left one of them unreachable: `setTrackFlags` refuses
 * `markForTrain` in either direction against a `trained` track, and nothing
 * anywhere writes `'trained'` in the first place. That was not an omission —
 * it is the statement that finishing with a track is an act of curation, not a
 * checkbox, and that the surface which produced the dataset entries is the only
 * one entitled to say the track has been used.
 *
 * So: **`complete` is the first and only writer of `'trained'`**, and
 * **`restage` is the deliberate return** the generic toggle is not allowed to
 * make. Both are decided here, from the store contract alone, so the rules can
 * be tested without booting the addon.
 *
 * ## Why completing REQUIRES a copied frame
 *
 * `trained` makes the track's media evictable again. That is only safe because
 * the dataset already holds copies of the frames it wanted — so a track
 * completed with NO copies would hand retention permission to delete material
 * nobody ever extracted anything from. The refusal is the whole safety argument
 * of D81, expressed as a precondition instead of a paragraph.
 *
 * A track with copies but ZERO annotations is a different case and is ALLOWED:
 * a frame whose correct ground truth is "nothing here" is a real and useful
 * training example. It is logged, loudly, because the far likelier explanation
 * is that somebody clicked Complete on a track they had not annotated yet.
 */

import type { IScopedLogger, RetrainStatus } from '@camstack/types'

/** Why a lifecycle move was refused. */
export type RetrainTransitionRefusal =
  /** No such track in the active map or the table. */
  | 'unknown-track'
  /** `complete` on a track the dataset holds no frames from. */
  | 'no-frames-copied'
  /** `complete` on a track that is not in `staging`. */
  | 'not-staging'
  /** `restage` on a track that is not `trained`. */
  | 'not-trained'

export type RetrainTransitionResult =
  | { readonly kind: 'moved'; readonly from: RetrainStatus; readonly to: RetrainStatus }
  /** Already in the target state — an idempotent repeat, never an error. */
  | { readonly kind: 'unchanged'; readonly status: RetrainStatus }
  | {
      readonly kind: 'refused'
      readonly reason: RetrainTransitionRefusal
      readonly status?: RetrainStatus
    }

/** The store surface these moves need — nothing more. */
export interface RetrainLifecycleStore {
  readonly readStatus: (trackId: string) => Promise<RetrainStatus | null>
  readonly setStatus: (trackId: string, status: RetrainStatus) => Promise<void>
}

export interface RetrainLifecycleDeps {
  readonly store: RetrainLifecycleStore
  readonly logger: IScopedLogger
  /** How many frames the dataset holds from this track. */
  readonly countFrames: (trackId: string) => Promise<number>
  /** How many annotations the dataset holds from this track. */
  readonly countAnnotations: (trackId: string) => Promise<number>
}

export interface RetrainTransitionInput {
  readonly deviceId: number
  readonly trackId: string
}

/**
 * Finish with a track: `staging → trained`.
 *
 * Refuses `none` as well as an unknown track. A `none` track was never marked,
 * so "completing" it would move material into the dataset's accounting that the
 * operator never selected — and would do it through a path that reports
 * success.
 */
export async function completeRetrainTrack(
  deps: RetrainLifecycleDeps,
  input: RetrainTransitionInput,
): Promise<RetrainTransitionResult> {
  const { deviceId, trackId } = input
  const status = await deps.store.readStatus(trackId)
  if (status === null) {
    deps.logger.warn('retrain complete refused — unknown track', {
      tags: { deviceId },
      meta: { trackId },
    })
    return { kind: 'refused', reason: 'unknown-track' }
  }
  if (status === 'trained') return { kind: 'unchanged', status }
  if (status !== 'staging') {
    deps.logger.warn('retrain complete refused — track is not in staging', {
      tags: { deviceId },
      meta: { trackId, status },
    })
    return { kind: 'refused', reason: 'not-staging', status }
  }
  const frames = await deps.countFrames(trackId)
  if (frames === 0) {
    // The single most important refusal on this surface. `trained` un-pins the
    // track's media; with no copy taken, completing it is a delete order for
    // material nothing extracted anything from.
    deps.logger.warn('retrain complete refused — no frame was ever copied into the dataset', {
      tags: { deviceId },
      meta: { trackId, status },
    })
    return { kind: 'refused', reason: 'no-frames-copied', status }
  }
  const annotations = await deps.countAnnotations(trackId)
  await deps.store.setStatus(trackId, 'trained')
  if (annotations === 0) {
    deps.logger.warn('retrain track completed with ZERO annotations — every frame is background', {
      tags: { deviceId },
      meta: { trackId, frames },
    })
  } else {
    deps.logger.info('retrain track completed', {
      tags: { deviceId },
      meta: { trackId, frames, annotations },
    })
  }
  return { kind: 'moved', from: 'staging', to: 'trained' }
}

/**
 * The deliberate return: `trained → staging`.
 *
 * Rare and explicit. The generic toggle refuses it (D81) because re-staging
 * from a checkbox is how the same material gets annotated twice under two
 * ground truths; doing it from here means the operator is looking at the
 * annotations that already exist while they decide.
 *
 * The existing copies and annotations are LEFT ALONE. Deleting them would make
 * "put this back in staging" a destructive operation that reads as a
 * navigational one — and the copies are the only durable record of what the
 * frames looked like, whatever retention did to the track since.
 */
export async function restageRetrainTrack(
  deps: RetrainLifecycleDeps,
  input: RetrainTransitionInput,
): Promise<RetrainTransitionResult> {
  const { deviceId, trackId } = input
  const status = await deps.store.readStatus(trackId)
  if (status === null) {
    deps.logger.warn('retrain restage refused — unknown track', {
      tags: { deviceId },
      meta: { trackId },
    })
    return { kind: 'refused', reason: 'unknown-track' }
  }
  if (status === 'staging') return { kind: 'unchanged', status }
  if (status !== 'trained') {
    deps.logger.warn('retrain restage refused — track was never trained', {
      tags: { deviceId },
      meta: { trackId, status },
    })
    return { kind: 'refused', reason: 'not-trained', status }
  }
  await deps.store.setStatus(trackId, 'staging')
  deps.logger.info('retrain track returned to staging', {
    tags: { deviceId },
    meta: { trackId },
  })
  return { kind: 'moved', from: 'trained', to: 'staging' }
}
