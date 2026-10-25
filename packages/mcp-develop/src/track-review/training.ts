/**
 * Which tracks already have a frame in the retrain corpus.
 *
 * ONE bounded read of the corpus (pages of 100, not a call per track): each
 * frame carries its `trackId` and the collections it belongs to. A suspect
 * already curated is not worth a reviewer's time again, and triage says how
 * many it skipped for that reason.
 */
import type { ReviewHub } from './hub-api.js'

export const TRAINING_PAGE_SIZE = 100
/** Stop reading the corpus after this many frames. */
export const MAX_TRAINING_FRAMES = 5_000

export interface InTraining {
  readonly collections: readonly string[]
}

export interface TrainingMembership {
  /** trackId to the names of the collections its frames are in (may be empty). */
  readonly byTrack: ReadonlyMap<string, readonly string[]>
  /** The corpus had more frames than were read: absence is then not proof. */
  readonly truncated: boolean
  readonly framesRead: number
}

export async function loadTrainingMembership(hub: ReviewHub): Promise<TrainingMembership> {
  const names = new Map((await hub.listCollections()).map((c) => [c.id, c.name]))
  const byTrack = new Map<string, Set<string>>()
  let framesRead = 0
  let truncated = false
  for (let page = 1; ; page += 1) {
    const answer = await hub.listRetrainCorpusPage({
      page,
      pageSize: TRAINING_PAGE_SIZE,
    })
    for (const frame of answer.frames) {
      if (frame.trackId === undefined) continue
      const set = byTrack.get(frame.trackId) ?? new Set<string>()
      for (const id of frame.collectionIds ?? []) set.add(names.get(id) ?? id)
      byTrack.set(frame.trackId, set)
    }
    framesRead += answer.frames.length
    if (answer.frames.length === 0 || framesRead >= answer.total) break
    if (framesRead >= MAX_TRAINING_FRAMES) {
      truncated = true
      break
    }
  }
  return {
    byTrack: new Map([...byTrack].map(([id, set]) => [id, [...set].sort()])),
    truncated,
    framesRead,
  }
}

export function inTrainingOf(trackId: string, m: TrainingMembership): InTraining | null {
  const collections = m.byTrack.get(trackId)
  return collections === undefined ? null : { collections }
}
