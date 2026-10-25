/**
 * What a registry promotion does to the TRACKS it touches (D683 round 4,
 * operator 2026-09-30): the subject now lives in the registry. A track that
 * ever moved is a real track of a moving subject — it closes normally and a
 * later piece may be linked to it. One that never moved was never a moving
 * subject — D547's disposal, unchanged.
 *
 * "Moved" (fix round 1, review M1) is judged robustly, because a false
 * "moved" brings D547's parked-car rows back and a false "never moved"
 * deletes a real passage:
 *  - the REFERENCE is the median centre of the first
 *    {@link PROMOTION_EARLY_BOXES} boxes, and the span is
 *    `DEFAULT_STILL_SPAN_FRACTION` × their median SHORT side — the same
 *    subject-scaled stillness the state analyzer uses (D547), so one
 *    truncated first box (startup, night→day, a car cut by the frame edge)
 *    moves neither the reference nor the scale;
 *  - a move must be SUSTAINED: {@link PROMOTION_SUSTAINED_BOXES} consecutive
 *    boxes beyond the span. One mis-bound or merged box is not a move.
 *
 * The judgement is a fold over the boxes in time order ({@link MovedProbe}),
 * so the track store can keep it INCREMENTALLY on every sighting: the stored
 * trail is downsampled (every other box of the older half, each time it
 * fills), and after a long dwell a whole walk-in survives there as ONE box —
 * indistinguishable, on the trail alone, from a truncated first box.
 */
import type { BoundingBox } from '@camstack/types'
import { DEFAULT_STILL_SPAN_FRACTION } from '../tracker/state-analyzer.js'
import type { TrackDropReason } from '../tracker-v2/types.js'

/** How many early boxes fix the reference position and scale. */
export const PROMOTION_EARLY_BOXES = 5
/** How many CONSECUTIVE boxes beyond the span make a move. */
export const PROMOTION_SUSTAINED_BOXES = 3

export interface PromotionPlan {
  readonly dropReason: TrackDropReason
  readonly disposeLiveTrack: boolean
}

const MOVED_PLAN: PromotionPlan = { dropReason: 'stationary', disposeLiveTrack: false }
const NEVER_MOVED_PLAN: PromotionPlan = { dropReason: 'dropped', disposeLiveTrack: true }

export function planFromMoved(moved: boolean): PromotionPlan {
  return moved ? MOVED_PLAN : NEVER_MOVED_PLAN
}

interface MovedReference {
  readonly x: number
  readonly y: number
  readonly span: number
}

/** The running "has this track moved" judgement. Immutable: every step returns a new probe (or the same one when nothing changed). */
export interface MovedProbe {
  /** The first boxes, until {@link PROMOTION_EARLY_BOXES} of them fix the reference. */
  readonly early: readonly BoundingBox[]
  readonly reference: MovedReference | null
  /** Consecutive boxes beyond the span, ending at the latest box. */
  readonly run: number
  readonly moved: boolean
}

export const EMPTY_MOVED_PROBE: MovedProbe = Object.freeze({
  early: Object.freeze([]),
  reference: null,
  run: 0,
  moved: false,
})

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const hi = sorted[mid] ?? 0
  if (sorted.length % 2 === 1) return hi
  return ((sorted[mid - 1] ?? hi) + hi) / 2
}

function referenceOf(boxes: readonly BoundingBox[]): MovedReference {
  return {
    x: median(boxes.map((b) => b.x + b.w / 2)),
    y: median(boxes.map((b) => b.y + b.h / 2)),
    span: DEFAULT_STILL_SPAN_FRACTION * median(boxes.map((b) => Math.min(b.w, b.h))),
  }
}

function displaced(ref: MovedReference, b: BoundingBox): boolean {
  return Math.hypot(b.x + b.w / 2 - ref.x, b.y + b.h / 2 - ref.y) > ref.span
}

function judge(ref: MovedReference, run: number, b: BoundingBox): MovedProbe {
  const next = displaced(ref, b) ? run + 1 : 0
  return { early: [], reference: ref, run: next, moved: next >= PROMOTION_SUSTAINED_BOXES }
}

/** Judge `boxes` (in time order) against a reference fixed from their own head. */
function judgeAll(boxes: readonly BoundingBox[]): MovedProbe {
  const ref = referenceOf(boxes.slice(0, PROMOTION_EARLY_BOXES))
  let probe: MovedProbe = { early: [], reference: ref, run: 0, moved: false }
  for (const b of boxes) {
    if (probe.moved) return probe
    probe = judge(ref, probe.run, b)
  }
  return probe
}

function isMeasurableBox(box: BoundingBox | undefined): box is BoundingBox {
  return (
    box !== undefined &&
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.w) &&
    Number.isFinite(box.h)
  )
}

/**
 * One more box of the track, in time order. A box that cannot be measured is
 * not a sighting of anywhere and changes nothing: the probe is folded inside
 * the store's persist (`cloneTrack`), and a throw there would lose the row.
 */
export function stepMovedProbe(probe: MovedProbe, box: BoundingBox | undefined): MovedProbe {
  if (probe.moved || !isMeasurableBox(box)) return probe
  if (probe.reference !== null) {
    const next = judge(probe.reference, probe.run, box)
    return next.run === probe.run && !next.moved ? probe : next
  }
  const early = [...probe.early, box]
  if (early.length < PROMOTION_EARLY_BOXES) return { ...probe, early }
  // The reference is fixed now; the early boxes are judged against it too.
  return judgeAll(early)
}

/** Has the track moved? A track shorter than the early window is judged against what it has. */
export function probeMoved(probe: MovedProbe): boolean {
  if (probe.moved) return true
  if (probe.reference !== null || probe.early.length === 0) return false
  return judgeAll(probe.early).moved
}

/** The plan for a whole path, in time order (the probe's fold). */
export function planPromotion(path: readonly BoundingBox[]): PromotionPlan {
  let probe = EMPTY_MOVED_PROBE
  for (const b of path) probe = stepMovedProbe(probe, b)
  return planFromMoved(probeMoved(probe))
}

/**
 * A PERSISTED source's plan, from its row (Task 14 fix round 2, review R2):
 * the `moved` verdict the track judged on every box as it arrived — never the
 * stored trail, which has forgotten a walk-in after a long dwell.
 *  - no row at all: nothing of it is kept anywhere — never moved, as before
 *    (the cascade takes whatever it left behind);
 *  - a row that predates the verdict: `null`, the source is left alone. An
 *    absence is never read as "never moved".
 */
export function planForPersistedSource(
  row: { readonly moved?: boolean } | null,
): PromotionPlan | null {
  if (row === null) return NEVER_MOVED_PLAN
  return row.moved === undefined ? null : planFromMoved(row.moved)
}

/**
 * The SOURCE of the entry's best box, as the promotion sees it. `plan: null`
 * means its movement is not known — its read failed (D49), or its row
 * predates the `moved` verdict (R2) — and it is left alone.
 */
export interface PromotionSource {
  readonly trackId: string
  readonly plan: PromotionPlan | null
  /** It shares the live track's L2 chain root: the same subject (review M4). */
  readonly sameChainAsLive: boolean
}

export interface PromotionEffectsInput {
  readonly liveTrackId: string
  readonly live: PromotionPlan
  readonly source?: PromotionSource
}

export interface PromotionEffects {
  readonly liveDropReason: TrackDropReason
  /** The live track never reaches the ordinary close: run its per-track teardown now. */
  readonly tearDownLiveNow: boolean
  /** Close normally, never as a parked re-sighting (they moved). */
  readonly keepTrackIds: readonly string[]
  /** D547: row, media, events and vector go; the entry's key frame stays. */
  readonly disposeTrackIds: readonly string[]
  /** A source left alone because its movement is not known (`plan: null`). */
  readonly leftAloneSourceTrackId?: string
}

/**
 * Each track's fate, judged on its OWN path (review H3, operator ruling): a
 * track that moved is kept, one that never moved is disposed. A source in
 * the live chain is the same subject and shares the live track's fate.
 */
export function planPromotionEffects(input: PromotionEffectsInput): PromotionEffects {
  const { liveTrackId, live, source } = input
  const keep: string[] = []
  const dispose: string[] = []
  const place = (trackId: string, plan: PromotionPlan): void => {
    if (plan.disposeLiveTrack) dispose.push(trackId)
    else keep.push(trackId)
  }
  place(liveTrackId, live)
  let leftAloneSourceTrackId: string | undefined
  if (source !== undefined && source.trackId !== liveTrackId) {
    const plan = source.sameChainAsLive ? live : source.plan
    if (plan === null) leftAloneSourceTrackId = source.trackId
    else place(source.trackId, plan)
  }
  return {
    liveDropReason: live.dropReason,
    tearDownLiveNow: live.disposeLiveTrack,
    keepTrackIds: keep,
    disposeTrackIds: dispose,
    ...(leftAloneSourceTrackId !== undefined ? { leftAloneSourceTrackId } : {}),
  }
}

export interface PromotionExecutorDeps {
  /** Mark an active track as closing normally (`TrackStore.markKeptAtPromotion`). */
  readonly markKept: (trackId: string) => void
  /** Settles when the disposed tracks' recognizers have read their key frame. */
  readonly beforeDispose: Promise<unknown>
  readonly dispose: (trackIds: readonly string[]) => Promise<void>
}

/** Kept tracks are marked synchronously; disposal waits for `beforeDispose`. */
export async function executePromotionEffects(
  effects: PromotionEffects,
  deps: PromotionExecutorDeps,
): Promise<void> {
  for (const trackId of effects.keepTrackIds) deps.markKept(trackId)
  if (effects.disposeTrackIds.length === 0) return
  await deps.beforeDispose
  await deps.dispose(effects.disposeTrackIds)
}
