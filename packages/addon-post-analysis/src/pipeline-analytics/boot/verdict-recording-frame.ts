/**
 * The recording fallback of a notification verdict (D948 follow-up): the track
 * the operator answered about is gone, so the frame at the notification's
 * instant is read back from the camera's recording into ONE retrain collection,
 * "Notification verdicts" — camera-agnostic, created on first need.
 *
 * The collection is found by NAME on every call (names are unique,
 * case-insensitively, so a lookup never finds two, and a create racing a
 * create answers `duplicate-name`, which is re-listed). Nothing is cached, so
 * a collection the operator renamed or deleted is simply found or created
 * again.
 */

import type { IScopedLogger, RetrainCollection, RetrainVerdictSubject } from '@camstack/types'
import type { NcVerdictFrameOutcome } from '../../notification-center/center-deps.js'

export const VERDICT_COLLECTION_NAME = 'Notification verdicts'

/** The slice of `ctx.api.pipelineAnalytics` this fallback calls. */
export interface VerdictFrameApi {
  listRetrainCollections(): Promise<readonly RetrainCollection[]>
  createRetrainCollection(
    name: string,
  ): Promise<
    | { readonly kind: 'created'; readonly collection: RetrainCollection }
    | { readonly kind: 'refused'; readonly reason: 'empty-name' | 'duplicate-name' }
  >
  addRetrainFrameFromRecording(input: {
    readonly collectionId: string
    readonly deviceId: number
    readonly epochMs: number
    readonly verdictSubject?: RetrainVerdictSubject
  }): Promise<
    | { readonly kind: 'added' }
    | {
        readonly kind: 'refused'
        readonly reason:
          | 'unknown-collection'
          | 'still-unavailable'
          | 'still-busy'
          | 'unreadable-image'
          | 'write-failed'
        readonly detail?: string
      }
  >
}

async function findOrCreate(api: VerdictFrameApi): Promise<string | null> {
  const wanted = VERDICT_COLLECTION_NAME.toLowerCase()
  const find = async (): Promise<string | null> =>
    (await api.listRetrainCollections()).find((c) => c.name.toLowerCase() === wanted)?.id ?? null
  const existing = await find()
  if (existing !== null) return existing
  const created = await api.createRetrainCollection(VERDICT_COLLECTION_NAME)
  if (created.kind === 'created') return created.collection.id
  // A concurrent create won the name: the collection exists now.
  return created.reason === 'duplicate-name' ? find() : null
}

export async function addVerdictFrameFromRecording(
  api: VerdictFrameApi,
  logger: IScopedLogger,
  input: {
    readonly deviceId: number
    readonly epochMs: number
    readonly subject?: RetrainVerdictSubject
  },
): Promise<NcVerdictFrameOutcome> {
  const collectionId = await findOrCreate(api)
  if (collectionId === null) {
    logger.warn('verdict frame dropped — the "Notification verdicts" collection is unavailable', {
      tags: { deviceId: input.deviceId },
    })
    return { ok: false, reason: 'failed', detail: 'collection-unavailable' }
  }
  const result = await api.addRetrainFrameFromRecording({
    collectionId,
    deviceId: input.deviceId,
    epochMs: input.epochMs,
    ...(input.subject !== undefined ? { verdictSubject: input.subject } : {}),
  })
  if (result.kind === 'added') return { ok: true }
  const reason =
    result.reason === 'still-unavailable' || result.reason === 'still-busy'
      ? result.reason
      : 'failed'
  return { ok: false, reason, detail: result.detail ?? result.reason }
}
