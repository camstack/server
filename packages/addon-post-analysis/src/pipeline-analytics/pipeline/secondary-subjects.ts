/**
 * Secondary subjects — what the confirmation gate found in a crop BESIDES the
 * candidate it was confirming, handed to the tracker as detections of their
 * own on the frames that follow.
 *
 * The gate re-runs the detector on the native crop of every birth. On camera
 * 101 that crop of a PERSON held the dog at 0.74–0.91 five times while the
 * full-frame pass had produced no `animal` at all; the score was logged as
 * `bestIncompatibleScore` and nothing else happened. This module is the
 * "something else": a promoted subject waits here, briefly, and rides the
 * next frames of the same (device, source) as a first-level detection, so the
 * tracker births it, the gate confirms it on its own crop, and
 * `co-moving-subjects.ts` records it next to the track it was found beside.
 * No rule, no zone, no class list decides any of this — the tracker's own
 * discipline does.
 *
 * ## Why it rides more than one frame
 *
 * The tracker (v2, D683) confirms a track for emission at `minHits` (default 3) — a
 * SINGLE synthetic detection mints a tentative track that never emits, ages
 * out and produces nothing. A promotion that rides one frame is a mechanism
 * that reads as implemented and does nothing at all, which is worse than not
 * having it. So a promotion rides up to {@link SECONDARY_SUBJECT_MAX_RIDES}
 * consecutive frames — exactly the default `minHits`, ~300 ms at 10 fps — and
 * stops the moment a REAL detection of its class covers it: the runner's
 * native-crop recovery pass, or the full-frame pass finding the subject again.
 * The box does not move between rides; that is the same bounded extrapolation
 * a coasting track already makes, over a far shorter window.
 *
 * Pure: a queue with a clock argument and one frame transform.
 */
import type { FrameResult, ObjectDetection } from '@camstack/types'
import type { SecondarySubject } from '../confirmation-gate.js'

/**
 * How long a promoted subject may keep riding. Rides are consumed within
 * ~300 ms at 10 fps; this bound is what stops a promotion made just before a
 * stall from riding a frame that belongs to a scene that has moved on.
 */
export const SECONDARY_SUBJECT_TTL_MS = 3_000
/**
 * Consecutive frames one promotion rides — the tracker's default `minHits`,
 * the fewest that can birth a track. One more would be an invention the
 * measurement does not support; one fewer births nothing.
 */
export const SECONDARY_SUBJECT_MAX_RIDES = 3
/**
 * A pending subject that overlaps a detection of its own class this much on
 * the frame it would ride is already there — the runner's native crop pass
 * found it too — and is dropped rather than doubled.
 */
const SECONDARY_SUBJECT_DUPLICATE_IOU = 0.5

interface PendingSubject {
  readonly id: string
  readonly subject: SecondarySubject
  readonly foundBesideTrackId: string
  readonly expiresAt: number
  readonly ridesLeft: number
}

/** A subject taken from the queue, with where it came from. */
export interface TakenSubject {
  /** Queue id — what {@link SecondarySubjectQueue.drop} takes back. */
  readonly id: string
  readonly subject: SecondarySubject
  readonly foundBesideTrackId: string
}

export class SecondarySubjectQueue {
  private readonly byKey = new Map<string, readonly PendingSubject[]>()
  private nextId = 0

  add(key: string, subject: SecondarySubject, foundBesideTrackId: string, now: number): void {
    const pending = this.byKey.get(key) ?? []
    this.nextId += 1
    this.byKey.set(key, [
      ...pending,
      {
        id: `s${this.nextId}`,
        subject,
        foundBesideTrackId,
        expiresAt: now + SECONDARY_SUBJECT_TTL_MS,
        ridesLeft: SECONDARY_SUBJECT_MAX_RIDES,
      },
    ])
  }

  /**
   * Every subject still owed a ride for `key`, one ride spent. An entry out of
   * rides or past its TTL is forgotten here rather than served.
   */
  take(key: string, now: number): readonly TakenSubject[] {
    const pending = this.byKey.get(key)
    if (!pending) return []
    const live = pending.filter((entry) => entry.expiresAt > now && entry.ridesLeft > 0)
    const remaining = live
      .map((entry) => ({ ...entry, ridesLeft: entry.ridesLeft - 1 }))
      .filter((entry) => entry.ridesLeft > 0)
    if (remaining.length === 0) this.byKey.delete(key)
    else this.byKey.set(key, remaining)
    return live.map((entry) => ({
      id: entry.id,
      subject: entry.subject,
      foundBesideTrackId: entry.foundBesideTrackId,
    }))
  }

  /** A subject a real detection has taken over rides no further. */
  drop(key: string, id: string): void {
    const pending = this.byKey.get(key)
    if (!pending) return
    const remaining = pending.filter((entry) => entry.id !== id)
    if (remaining.length === 0) this.byKey.delete(key)
    else this.byKey.set(key, remaining)
  }

  forget(key: string): void {
    this.byKey.delete(key)
  }
}

function iou(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.width) - Math.max(a.x, b.x))
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.height) - Math.max(a.y, b.y))
  const inter = w * h
  const union = a.w * a.h + b.width * b.height - inter
  return union > 0 ? inter / union : 0
}

/** The frame the tracker sees, and what became of each pending subject. */
export interface SecondaryInjection {
  /** The runner's frame, plus one synthetic detection per riding subject. */
  readonly frame: FrameResult
  /** Ids a REAL detection of the same class already covers — they ride no further. */
  readonly covered: readonly string[]
}

/**
 * The runner's detections plus one synthetic first-level detection per pending
 * subject that no same-class detection already covers. The synthetic box
 * carries the gate's score — a measurement on a native crop, not an invention
 * — and an id that says where it came from. The original result is not
 * mutated.
 */
export function injectSecondarySubjects(
  frame: FrameResult,
  pending: readonly TakenSubject[],
): SecondaryInjection {
  if (pending.length === 0) return { frame, covered: [] }
  const added: ObjectDetection[] = []
  const covered: string[] = []
  for (const { id, subject, foundBesideTrackId } of pending) {
    const already = [...frame.detections, ...added].some(
      (d) =>
        d.kind === 'first-level' &&
        d.macroClass === subject.className &&
        iou(subject.bbox, d.bbox) >= SECONDARY_SUBJECT_DUPLICATE_IOU,
    )
    if (already) {
      covered.push(id)
      continue
    }
    added.push({
      id: `secondary-${id}-${foundBesideTrackId}`,
      kind: 'first-level',
      macroClass: subject.className,
      score: subject.score,
      labels: [],
      bbox: { x: subject.bbox.x, y: subject.bbox.y, width: subject.bbox.w, height: subject.bbox.h },
    })
  }
  if (added.length === 0) return { frame, covered }
  return { frame: { ...frame, detections: [...frame.detections, ...added] }, covered }
}
