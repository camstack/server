/**
 * Which stored frame the summary shows the model, when the frame itself knows
 * where its subject was (D510).
 *
 * ## Why a pick at all
 *
 * Before D510 the only thing in this addon that could state a subject's
 * rectangle on a picture was `TrackSnapshot`, which carries `mediaId` and
 * `position.bbox` together — so `subjectShotFor` walked the track's snapshots
 * and took the one nearest the instant it wanted. That is a PAIRING, and it
 * has two failure modes the log counted: a track with no snapshot at all
 * (`no-snapshot`), and a snapshot whose instant is not the instant asked for.
 *
 * Now the whole-frame media rows carry their own box, recorded on that exact
 * frame. When one exists there is nothing to pair: the row IS the answer.
 * This module is only the ORDERING over the rows that qualify — deliberately
 * pure, so the rule is one function with one test and not a loop inside a
 * 15 000-line class.
 *
 * ## The ordering
 *
 * Nearest to the instant asked for wins, because that is the question. Ties
 * are real and routine — `keyFrame` and `keyFrameSmall` are two encodes of ONE
 * surface and share a timestamp exactly — so they are broken by
 * {@link SUBJECT_SHOT_KIND_RANK}: more pixels is a better picture for the
 * model, and the tie-break must be deterministic or two digests of the same
 * window would disagree about which image they sent.
 *
 * A kind not named in the rank is still eligible, ranked last: a future write
 * site that starts recording a box must not be silently unreachable here.
 */
import type { MediaKind, MediaSubjectBoxRow } from './media-store.js'

/** Preference among rows that tie on time. Lower is better. */
const SUBJECT_SHOT_KIND_RANK: Readonly<Partial<Record<MediaKind, number>>> = {
  keyFrame: 0,
  keyFrameSmall: 1,
  fullFrame: 2,
  snapshot: 3,
}

/** Rank of a kind; an unranked one sorts after every ranked one. */
function subjectShotKindRank(kind: MediaKind): number {
  return SUBJECT_SHOT_KIND_RANK[kind] ?? Number.MAX_SAFE_INTEGER
}

/**
 * The row whose frame is closest to `aroundMs`. `null` when none qualifies —
 * the caller then falls back to the snapshot pairing, which is what every row
 * written before the column existed will always need.
 */
export function pickSubjectShotRow(
  rows: readonly MediaSubjectBoxRow[],
  aroundMs: number,
): MediaSubjectBoxRow | null {
  let best: MediaSubjectBoxRow | null = null
  for (const row of rows) {
    if (best === null) {
      best = row
      continue
    }
    const d = Math.abs(row.timestamp - aroundMs)
    const bestD = Math.abs(best.timestamp - aroundMs)
    if (d < bestD) {
      best = row
      continue
    }
    if (d === bestD && subjectShotKindRank(row.kind) < subjectShotKindRank(best.kind)) best = row
  }
  return best
}

/** A track snapshot, reduced to the three facts this question needs. */
export interface SubjectShotSnapshot {
  readonly timestamp: number
  readonly mediaId: number
  readonly bbox: SubjectShotBox
}

/** A rectangle in the detection frame. */
export interface SubjectShotBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** The answer: WHICH stored image, and where the subject is on it. Structurally
 *  the `SummarySubjectShot` the producer consumes — declared here so the store
 *  side does not import the notification centre to state its own result. */
export type SubjectShotSource = 'media-box' | 'snapshot'

export interface SubjectShot {
  readonly mediaId: number
  /** WHICH of the two rules answered. Carried because the outcome of both is a
   *  rectangle, so a caller counting boxed frames cannot tell them apart — and
   *  the day the capture-time box stops being written, the count stays put. */
  readonly source: SubjectShotSource
  readonly bbox: SubjectShotBox
  readonly frameWidth: number
  readonly frameHeight: number
}

/** The two places an answer can come from, injected so the rule is testable
 *  without a store, a track and a live device behind it. */
export interface SubjectShotPorts {
  /** The track's media rows that carry their own box (D510). */
  readonly boxedMedia: (trackId: string, deviceId: number) => Promise<readonly MediaSubjectBoxRow[]>
  /** The track's snapshots — the pre-D510 pairing, for rows that carry none. */
  readonly trackSnapshots: (trackId: string) => Promise<readonly SubjectShotSnapshot[]>
  /** The device's last known frame size, which is what a snapshot's box was
   *  measured against and the only thing that can scale it. */
  readonly frameDims: (deviceId: number) => { readonly w: number; readonly h: number } | undefined
}

/**
 * Where the subject is, on a picture we can show the model.
 *
 * ## The order, and why it is this way round
 *
 * 1. **A media row that carries its own box.** Written at capture, on that
 *    exact frame, by a site holding both at once — exact by construction, no
 *    pairing, and no dependence on the device's *current* frame size.
 * 2. **The nearest snapshot.** What this did before D510, kept for every row
 *    written before the column existed. There is no migration and none is
 *    possible: a box is only knowable at the instant of capture.
 *
 * `null` when neither can answer. A missing box costs a hint; an invented one
 * asserts something false with total confidence, so every branch that cannot
 * state a rectangle returns nothing rather than a guess.
 */
export async function resolveSubjectShot(
  ports: SubjectShotPorts,
  trackId: string,
  deviceId: number,
  aroundMs: number,
): Promise<SubjectShot | null> {
  const boxed = pickSubjectShotRow(await ports.boxedMedia(trackId, deviceId), aroundMs)
  if (boxed !== null) {
    const box = boxed.subjectBox
    return {
      mediaId: boxed.mediaId,
      source: 'media-box',
      bbox: { x: box.x, y: box.y, w: box.w, h: box.h },
      frameWidth: box.frameWidth,
      frameHeight: box.frameHeight,
    }
  }
  const dims = ports.frameDims(deviceId)
  if (dims === undefined || dims.w <= 0 || dims.h <= 0) return null
  let best: SubjectShotSnapshot | undefined
  for (const snap of await ports.trackSnapshots(trackId)) {
    if (
      best === undefined ||
      Math.abs(snap.timestamp - aroundMs) < Math.abs(best.timestamp - aroundMs)
    ) {
      best = snap
    }
  }
  if (best === undefined) return null
  return {
    mediaId: best.mediaId,
    source: 'snapshot',
    bbox: { ...best.bbox },
    frameWidth: dims.w,
    frameHeight: dims.h,
  }
}
