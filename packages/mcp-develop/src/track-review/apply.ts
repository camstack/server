/**
 * Execute a write plan against the hub — the ONLY place the track-review tools
 * write. Gated, idempotent, and per-track isolated:
 *
 *  - nothing is sent (not even a read) unless `confirm === true` and the
 *    collection name is non-blank;
 *  - a frame already copied is reused, a frame already annotated is left alone
 *    unless `overwrite` is set (a save REPLACES every annotation on the frame);
 *  - one track failing does not stop the others, except an auth rejection,
 *    which stops the run: every later write would be refused for the same reason.
 */
import { z } from 'zod'
import { HubHttpError, HubRpcError } from '@camstack/develop'
import type {
  MediaKind,
  RetrainAnnotationDraft,
  RetrainCorpusKpi,
  RetrainFrame,
  RetrainFrameList,
  ReviewHub,
} from './hub-api.js'
import { SubjectSpecSchema, VerdictKindSchema } from './plan.js'

export const ApplyPlanSchema = z.object({
  /** Carried by `track_review_plan`; the tool's own argument wins over it. */
  collectionName: z.string().optional(),
  tracks: z.array(
    z.object({
      trackId: z.string().min(1),
      deviceId: z.number().int(),
      verdict: VerdictKindSchema,
      subjects: z.array(SubjectSpecSchema).min(1),
      markComplete: z.boolean(),
    }),
  ),
})
export type ApplyPlan = z.infer<typeof ApplyPlanSchema>

export interface ApplyOptions {
  readonly confirm: boolean
  /** Wins over `plan.collectionName`; one of the two must name a collection. */
  readonly collectionName?: string
  readonly overwrite: boolean
}

export type TrackOutcome = 'done' | 'failed' | 'not-attempted'

export interface TrackLog {
  readonly trackId: string
  readonly outcome: TrackOutcome
  readonly actions: readonly string[]
  readonly reason?: string
}

export interface ApplyResult {
  readonly refused?: string
  readonly collection?: {
    readonly id: string
    readonly name: string
    readonly created: boolean
  }
  readonly tracks: readonly TrackLog[]
  readonly kpiBefore?: RetrainCorpusKpi
  readonly kpiAfter?: RetrainCorpusKpi
}

const KEY_FRAME_KINDS: readonly MediaKind[] = ['keyFrame']

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The hub said no to the credential itself: the rest of the run cannot succeed. */
export function isAuthRejection(err: unknown): boolean {
  if (err instanceof HubHttpError) return err.status === 401 || err.status === 403
  if (err instanceof HubRpcError) {
    return (
      err.code === 'UNAUTHORIZED' ||
      err.code === 'FORBIDDEN' ||
      err.status === 401 ||
      err.status === 403
    )
  }
  return false
}

function pickMediaId(list: RetrainFrameList): number | undefined {
  if (list.autoPickMediaId !== undefined) return list.autoPickMediaId
  const key = list.candidates.find((c) => KEY_FRAME_KINDS.includes(c.kind))
  return (key ?? list.candidates[0])?.mediaId
}

/** Subjects to drafts. A `boxOf` with no matching pipeline box on the frame is an error. */
export function resolveSubjects(
  subjects: ApplyPlan['tracks'][number]['subjects'],
  frame: RetrainFrame,
): readonly RetrainAnnotationDraft[] {
  const boxes = frame.pipelineBoxes ?? []
  return subjects.map((s, index) => {
    if (s.bbox !== undefined && s.macroClass !== undefined) {
      return {
        bbox: s.bbox,
        macroClass: s.macroClass,
        kind: s.kind ?? 'subject',
        source: 'operator',
        // Drawn by the reviewer, not proposed by a machine: nothing to diff against.
        origin: {
          source: 'operator',
          ref: `operator:${String(index)}`,
          bbox: s.bbox,
          macroClass: s.macroClass,
        },
        ...(s.label !== undefined ? { label: s.label } : {}),
        ...(s.subLabel !== undefined ? { subLabel: s.subLabel } : {}),
      }
    }
    const box = boxes.find((b) => b.trackId === s.boxOf)
    if (box === undefined) {
      throw new Error(`no pipeline box of track ${s.boxOf} on frame ${frame.frameId}`)
    }
    const label = s.label ?? (s.kind === 'model_error' ? box.label : undefined)
    // The pipeline drew this box. It is saved as the pipeline's, with the model
    // and score that drew it and the snapshot it was offered as, so the review
    // can tell "kept as drawn" from "reclassified" — copying it as an operator
    // box (what this did) erased exactly that.
    return {
      bbox: box.bbox,
      macroClass: s.macroClass ?? box.macroClass,
      kind: s.kind ?? 'subject',
      source: 'pipeline',
      origin: {
        source: 'pipeline',
        ref: `pipeline:${box.trackId}`,
        bbox: box.bbox,
        macroClass: box.macroClass,
        ...(box.label !== undefined ? { label: box.label } : {}),
        ...(box.score !== undefined ? { score: box.score } : {}),
        ...(box.modelId !== undefined ? { modelId: box.modelId } : {}),
      },
      ...(box.modelId !== undefined ? { assistModelId: box.modelId } : {}),
      ...(box.score !== undefined ? { assistScore: box.score } : {}),
      ...(label !== undefined ? { label } : {}),
      ...(s.subLabel !== undefined ? { subLabel: s.subLabel } : {}),
    }
  })
}

async function ensureFrame(
  hub: ReviewHub,
  deviceId: number,
  trackId: string,
  actions: string[],
): Promise<RetrainFrame> {
  let list = await hub.listRetrainFrames(trackId)
  let frame = list.copies.find((c) => c.trackId === trackId)
  if (frame === undefined) {
    const mediaId = pickMediaId(list)
    if (mediaId === undefined) throw new Error('the track has no frame to copy')
    const selection = await hub.selectRetrainFrames(deviceId, trackId, [mediaId])
    if (selection.copied.length === 0) {
      throw new Error(`frame selection refused: ${JSON.stringify(selection.refused).slice(0, 200)}`)
    }
    actions.push(`selected media ${mediaId}`)
    list = await hub.listRetrainFrames(trackId)
    frame = list.copies.find((c) => c.trackId === trackId) ?? selection.copied[0]
  } else {
    actions.push('frame already copied')
  }
  if (frame === undefined) throw new Error('the copied frame is not listed')
  return frame
}

async function annotate(
  hub: ReviewHub,
  t: ApplyPlan['tracks'][number],
  frame: RetrainFrame,
  overwrite: boolean,
  actions: string[],
): Promise<boolean> {
  const existing = await hub.listRetrainAnnotations([frame.frameId])
  if (existing.length > 0 && !overwrite) {
    actions.push(`kept ${existing.length} existing annotation(s)`)
    return false
  }
  const drafts = resolveSubjects(t.subjects, frame)
  // The revision the frame had when we read it: another surface that saved in
  // between makes the hub refuse this write instead of being overwritten by it.
  const saved = await hub.saveRetrainAnnotations(
    t.deviceId,
    t.trackId,
    frame.frameId,
    drafts,
    frame.revision,
  )
  if (saved.length !== drafts.length) {
    throw new Error(`saved ${saved.length} annotation(s), expected ${drafts.length}`)
  }
  actions.push(`${existing.length > 0 ? 'replaced' : 'saved'} ${saved.length} annotation(s)`)
  return true
}

async function applyTrack(
  hub: ReviewHub,
  t: ApplyPlan['tracks'][number],
  collectionId: string,
  overwrite: boolean,
): Promise<TrackLog> {
  const actions: string[] = []
  try {
    await hub.setTrackFlags(t.deviceId, t.trackId, true)
    actions.push('flagged markForTrain')
    const frame = await ensureFrame(hub, t.deviceId, t.trackId, actions)
    const wrote = await annotate(hub, t, frame, overwrite, actions)
    if (t.markComplete && wrote && !frame.complete) {
      await hub.setRetrainFrameComplete(t.deviceId, t.trackId, frame.frameId, true)
      actions.push('marked complete')
    }
    const added = await hub.addFramesToCollection(collectionId, [frame.frameId])
    if (added.unknownFrameIds.length > 0) throw new Error('the collection does not know the frame')
    actions.push(added.added > 0 ? 'added to collection' : 'already in collection')
    return { trackId: t.trackId, outcome: 'done', actions }
  } catch (err) {
    if (isAuthRejection(err)) throw err
    return {
      trackId: t.trackId,
      outcome: 'failed',
      actions,
      reason: describe(err),
    }
  }
}

async function ensureCollection(
  hub: ReviewHub,
  name: string,
): Promise<{ id: string; name: string; created: boolean }> {
  const existing = (await hub.listCollections()).find((c) => c.name === name)
  if (existing !== undefined) return { id: existing.id, name, created: false }
  const made = await hub.createCollection(name)
  if (made.kind === 'created') return { id: made.collection.id, name, created: true }
  throw new Error(`collection "${name}" was refused: ${made.reason}`)
}

export async function applyPlan(
  hub: ReviewHub,
  plan: ApplyPlan,
  options: ApplyOptions,
): Promise<ApplyResult> {
  if (options.confirm !== true) {
    return {
      refused: 'confirm: true is required — show the operator the plan first',
      tracks: [],
    }
  }
  const name = (options.collectionName ?? plan.collectionName ?? '').trim()
  if (name === '') {
    return {
      refused: 'a non-blank collection name is required (argument or plan.collectionName)',
      tracks: [],
    }
  }
  const logs: TrackLog[] = []
  let kpiBefore: RetrainCorpusKpi | undefined
  let collection: ApplyResult['collection']
  try {
    kpiBefore = await hub.getCorpusKpi()
    collection = await ensureCollection(hub, name)
    for (const t of plan.tracks) {
      logs.push(await applyTrack(hub, t, collection.id, options.overwrite))
    }
  } catch (err) {
    const stopped = `stopped: ${describe(err)}`
    const done = new Set(logs.map((l) => l.trackId))
    for (const t of plan.tracks) {
      if (!done.has(t.trackId)) {
        logs.push({
          trackId: t.trackId,
          outcome: 'not-attempted',
          actions: [],
          reason: stopped,
        })
      }
    }
    return {
      refused: stopped,
      ...(collection ? { collection } : {}),
      tracks: logs,
      ...(kpiBefore ? { kpiBefore } : {}),
    }
  }
  const kpiAfter = await hub.getCorpusKpi()
  return { collection, tracks: logs, kpiBefore, kpiAfter }
}
