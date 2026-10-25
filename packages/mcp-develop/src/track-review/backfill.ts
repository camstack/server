/**
 * `track_review_backfill_origin` — give annotations saved BEFORE origins
 * existed the origin they can honestly be reconstructed to.
 *
 * Dry-run by default: the answer says, per frame, which rows WOULD get an
 * origin (and which) and which stay unmatched. Nothing is written without
 * `confirm: true`. A row is matched only by an EXACT rectangle against the
 * pipeline box the hub re-derives for that frame; a row that matches nothing
 * stays `origin: null`, which keeps its review verdict approximate — it is
 * never given a guessed origin.
 *
 * The write is `backfillRetrainOrigins`, which sets `origin` and nothing else
 * (ids, creation time and the export stamp survive; a re-save would reset all
 * three) and skips any row that already has one.
 */
import { isAuthRejection } from './apply.js'
import type {
  RetrainAnnotation,
  RetrainCollection,
  RetrainFrame,
  RetrainOrigin,
  ReviewHub,
} from './hub-api.js'

/** Two rectangles within this on every edge are the same rectangle. */
const EXACT_EDGE_EPSILON = 1e-6
/** Frames read per corpus page (the hub's maximum). */
const CORPUS_PAGE_SIZE = 100
/** Annotation rows fetched per `listRetrainAnnotations` call. */
const ANNOTATION_CHUNK = 200
/** A backfill touches at most this many frames per call. */
export const MAX_BACKFILL_FRAMES = 2000

export interface BackfillOptions {
  readonly confirm: boolean
  readonly collectionName?: string
  readonly frameIds?: readonly string[]
}

export type BackfillOutcome = 'dry-run' | 'written' | 'failed' | 'nothing-to-set'

export interface FrameBackfill {
  readonly frameId: string
  readonly deviceId: number
  /** The frame's track; absent on a recording still. */
  readonly trackId?: string
  readonly revision: number | null
  /** Rows that would get (or got) this origin. */
  readonly matched: readonly { readonly annotationId: string; readonly origin: RetrainOrigin }[]
  /** Rows with no origin and no exact pipeline box: they stay approximate. */
  readonly unmatched: readonly string[]
  readonly alreadyHaveOrigin: number
  readonly outcome: BackfillOutcome
  readonly reason?: string
}

export interface BackfillResult {
  readonly dryRun: boolean
  readonly refused?: string
  readonly frames: readonly FrameBackfill[]
  readonly totals: {
    readonly frames: number
    readonly matched: number
    readonly unmatched: number
    readonly alreadyHaveOrigin: number
  }
}

const EMPTY_TOTALS = { frames: 0, matched: 0, unmatched: 0, alreadyHaveOrigin: 0 }

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function sameRect(a: RetrainOrigin['bbox'], b: RetrainOrigin['bbox']): boolean {
  return (
    Math.abs(a.x - b.x) <= EXACT_EDGE_EPSILON &&
    Math.abs(a.y - b.y) <= EXACT_EDGE_EPSILON &&
    Math.abs(a.w - b.w) <= EXACT_EDGE_EPSILON &&
    Math.abs(a.h - b.h) <= EXACT_EDGE_EPSILON
  )
}

/** The pipeline box a row's rectangle equals, as an origin snapshot. */
export function reconstructOrigin(
  annotation: RetrainAnnotation,
  frame: Pick<RetrainFrame, 'pipelineBoxes'>,
): RetrainOrigin | null {
  const box = (frame.pipelineBoxes ?? []).find((b) => sameRect(b.bbox, annotation.bbox))
  if (box === undefined) return null
  return {
    source: 'pipeline',
    ref: `pipeline:${box.trackId}`,
    bbox: box.bbox,
    macroClass: box.macroClass,
    ...(box.label !== undefined ? { label: box.label } : {}),
    ...(box.score !== undefined ? { score: box.score } : {}),
    ...(box.modelId !== undefined ? { modelId: box.modelId } : {}),
  }
}

interface FrameInput {
  readonly frame: Pick<RetrainFrame, 'frameId' | 'deviceId' | 'pipelineBoxes' | 'revision'> & {
    readonly trackId?: string
  }
  readonly annotations: readonly RetrainAnnotation[]
}

/** Pure: what a frame's backfill would set. */
export function planFrameBackfill(input: FrameInput): FrameBackfill {
  const matched: { annotationId: string; origin: RetrainOrigin }[] = []
  const unmatched: string[] = []
  let alreadyHaveOrigin = 0
  for (const a of input.annotations) {
    if (a.origin !== null && a.origin !== undefined) {
      alreadyHaveOrigin += 1
      continue
    }
    const origin = reconstructOrigin(a, input.frame)
    if (origin === null) unmatched.push(a.id)
    else matched.push({ annotationId: a.id, origin })
  }
  const trackId = input.frame.trackId ?? input.annotations.find((a) => a.trackId)?.trackId
  return {
    frameId: input.frame.frameId,
    deviceId: input.frame.deviceId,
    ...(trackId !== undefined && trackId !== '' ? { trackId } : {}),
    revision: input.frame.revision ?? null,
    matched,
    unmatched,
    alreadyHaveOrigin,
    outcome: matched.length > 0 ? 'dry-run' : 'nothing-to-set',
  }
}

async function annotationsOf(
  hub: ReviewHub,
  frameIds: readonly string[],
): Promise<ReadonlyMap<string, readonly RetrainAnnotation[]>> {
  const grouped = new Map<string, RetrainAnnotation[]>()
  for (let i = 0; i < frameIds.length; i += ANNOTATION_CHUNK) {
    for (const a of await hub.listRetrainAnnotations(frameIds.slice(i, i + ANNOTATION_CHUNK))) {
      const list = grouped.get(a.mediaKey)
      if (list === undefined) grouped.set(a.mediaKey, [a])
      else list.push(a)
    }
  }
  return grouped
}

async function framesOfCollection(
  hub: ReviewHub,
  collection: RetrainCollection,
): Promise<readonly RetrainFrame[]> {
  const frames: RetrainFrame[] = []
  for (let page = 1; frames.length < MAX_BACKFILL_FRAMES; page += 1) {
    const answer = await hub.listRetrainCorpusPage({
      collectionId: collection.id,
      page,
      pageSize: CORPUS_PAGE_SIZE,
    })
    frames.push(...answer.frames)
    if (answer.frames.length === 0 || frames.length >= answer.total) break
  }
  return frames.slice(0, MAX_BACKFILL_FRAMES)
}

/** Frames named by id: the frame row comes from its track's list. */
async function framesById(
  hub: ReviewHub,
  frameIds: readonly string[],
  annotations: ReadonlyMap<string, readonly RetrainAnnotation[]>,
): Promise<readonly FrameInput['frame'][]> {
  const byTrack = new Map<string, Promise<readonly RetrainFrame[]>>()
  const out: FrameInput['frame'][] = []
  for (const frameId of frameIds) {
    const first = annotations.get(frameId)?.[0]
    const trackId = first?.trackId
    if (first === undefined) continue
    if (trackId === undefined || trackId === '') {
      // A recording still has no track and so no pipeline evidence: its rows
      // can only stay approximate.
      out.push({ frameId, deviceId: first.deviceId })
      continue
    }
    if (!byTrack.has(trackId)) {
      byTrack.set(
        trackId,
        hub.listRetrainFrames(trackId).then((list) => list.copies),
      )
    }
    const copy = (await byTrack.get(trackId))?.find((c) => c.frameId === frameId)
    out.push(copy ?? { frameId, deviceId: first.deviceId })
  }
  return out
}

function totalsOf(frames: readonly FrameBackfill[]): BackfillResult['totals'] {
  return frames.reduce(
    (t, f) => ({
      frames: t.frames + 1,
      matched: t.matched + f.matched.length,
      unmatched: t.unmatched + f.unmatched.length,
      alreadyHaveOrigin: t.alreadyHaveOrigin + f.alreadyHaveOrigin,
    }),
    EMPTY_TOTALS,
  )
}

export async function backfillOrigins(
  hub: ReviewHub,
  options: BackfillOptions,
): Promise<BackfillResult> {
  const name = options.collectionName?.trim() ?? ''
  const ids = options.frameIds ?? []
  if (name === '' && ids.length === 0) {
    return {
      dryRun: options.confirm !== true,
      refused: 'name a collection or give frameIds — a backfill never walks the whole corpus',
      frames: [],
      totals: EMPTY_TOTALS,
    }
  }
  const planned: FrameBackfill[] = []
  if (name !== '') {
    const collection = (await hub.listCollections()).find((c) => c.name === name)
    if (collection === undefined) {
      return {
        dryRun: options.confirm !== true,
        refused: `no collection named "${name}"`,
        frames: [],
        totals: EMPTY_TOTALS,
      }
    }
    const frames = await framesOfCollection(hub, collection)
    const notes = await annotationsOf(
      hub,
      frames.map((f) => f.frameId),
    )
    for (const frame of frames) {
      planned.push(planFrameBackfill({ frame, annotations: notes.get(frame.frameId) ?? [] }))
    }
  }
  const named = ids.filter((id) => !planned.some((p) => p.frameId === id))
  if (named.length > 0) {
    const notes = await annotationsOf(hub, named)
    for (const frame of await framesById(hub, named, notes)) {
      planned.push(planFrameBackfill({ frame, annotations: notes.get(frame.frameId) ?? [] }))
    }
  }

  if (options.confirm !== true) {
    return { dryRun: true, frames: planned, totals: totalsOf(planned) }
  }
  const written: FrameBackfill[] = []
  for (const plan of planned) {
    if (plan.matched.length === 0) {
      written.push(plan)
      continue
    }
    try {
      await hub.backfillRetrainOrigins(
        plan.deviceId,
        plan.trackId,
        plan.frameId,
        plan.matched,
        plan.revision ?? undefined,
      )
      written.push({ ...plan, outcome: 'written' })
    } catch (err) {
      if (isAuthRejection(err)) throw err
      written.push({ ...plan, outcome: 'failed', reason: describe(err) })
    }
  }
  return { dryRun: false, frames: written, totals: totalsOf(written) }
}
