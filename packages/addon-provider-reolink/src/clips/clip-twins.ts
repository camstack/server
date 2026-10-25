/**
 * Pair the sub-stream file with its main-stream twin.
 *
 * A `FileInfoList` search names ONE stream, so a day's catalog is two lists of
 * the same recordings under different names (`RecS…` / `RecM…`). The app runs
 * both; measured on 592 (20 September) the two sets were twins whose start
 * seconds differ by 0–4 s, 168 of 170 within 3 s, main ≈ 33× the bytes.
 *
 * The catalog row is the SUB file — it is what the thumbnail comes from and
 * what `low | mid` plays — and its main twin is matched BY START TIME, never
 * by name (the names differ by more than a prefix on some firmwares). Both ids
 * land on the row so a quality change never re-searches the camera (D549 15).
 *
 * A sub file with no twin keeps `main: undefined`. That is the whole point of
 * pairing here rather than guessing at playback time: "there is no main copy"
 * is an answer, and serving the sub as if it were `high` would be a lie the
 * operator cannot see.
 */

import type { CamProfile } from '@camstack/types'

/** The library's `RecordingFile`, narrowed to what pairing reads. */
export interface TwinCandidate {
  readonly fileName: string
  readonly startTime?: Date
  readonly endTime?: Date
  readonly sizeBytes?: number
  readonly recordType?: string
  readonly supportSub?: boolean
  readonly id?: string
}

export interface TwinPair<T extends TwinCandidate = TwinCandidate> {
  readonly sub: T
  readonly main?: T
}

/**
 * How far apart two twins' starts may be. 3 s covers 168 of the 170 measured
 * pairs; the two that did not are 4 s apart and simply keep no twin, which is
 * the honest outcome — a 4 s window starts overlapping the NEXT recording on a
 * busy camera, and handing the operator the wrong minute of footage is worse
 * than telling them there is no high-quality copy.
 */
export const TWIN_MATCH_TOLERANCE_MS = 3_000

export function pairTwins<T extends TwinCandidate>(
  subs: readonly T[],
  mains: readonly T[],
): readonly TwinPair<T>[] {
  const datedSubs = subs.filter((f) => f.startTime instanceof Date)
  const datedMains = mains
    .filter((f) => f.startTime instanceof Date)
    .toSorted((a, b) => startOf(a) - startOf(b))

  const claimed = new Set<number>()
  const pairs: TwinPair<T>[] = []
  // Oldest first while claiming, so "closest wins" is evaluated in a stable
  // order and two adjacent subs cannot both take the same main.
  for (const sub of datedSubs.toSorted((a, b) => startOf(a) - startOf(b))) {
    const subStart = startOf(sub)
    let bestIndex = -1
    let bestDelta = Number.POSITIVE_INFINITY
    for (const [index, candidate] of datedMains.entries()) {
      if (claimed.has(index)) continue
      const delta = Math.abs(startOf(candidate) - subStart)
      if (delta > TWIN_MATCH_TOLERANCE_MS) continue
      if (delta < bestDelta) {
        bestDelta = delta
        bestIndex = index
      }
    }
    if (bestIndex === -1) {
      pairs.push({ sub })
      continue
    }
    claimed.add(bestIndex)
    const main = datedMains[bestIndex]
    pairs.push(main === undefined ? { sub } : { sub, main })
  }

  return pairs.toSorted((a, b) => startOf(b.sub) - startOf(a.sub))
}

function startOf(file: TwinCandidate): number {
  return file.startTime?.getTime() ?? 0
}

/**
 * Which of a recording's two files a call means.
 *
 * A day's catalog is two lists of the same recordings: the SUB file is the
 * catalog row, its MAIN twin is roughly 33× the bytes.
 */
export type ClipTwin = 'sub' | 'main'

/** What a caller needs from the row to resolve a twin. */
export interface TwinChoiceRow {
  readonly subFileName: string
  readonly mainFileName?: string
}

export interface TwinChoice {
  readonly twin: ClipTwin
  /** The camera-side handle to open. `''` when the row carries none. */
  readonly fileName: string
  /** What the caller will ACTUALLY be served — never what it asked for. */
  readonly served: CamProfile
  /**
   * `high` was asked and this recording has no main twin, so the sub copy is
   * being served in its place. The caller LOGS it; it is not an error, but it
   * must never pass unremarked — the operator asked for quality and is getting
   * something else.
   */
  readonly downgraded: boolean
}

/**
 * The ONE place that turns a requested profile into a twin.
 *
 * Three call sites used to decide this independently — `getClipPlayback`,
 * `readClipBytes` and the stream dial — and they did not agree: the dial
 * REFUSED `high` outright while the other two served the sub copy with a
 * warning. Same question, three answers, and the one that refused made `high`
 * look unsupported rather than unavailable for that recording.
 *
 * The mapping is the profile ladder the rest of the system already uses:
 * `high` reaches for the main twin, everything else is the sub. A `high` with
 * no main twin degrades to the sub and SAYS SO through `served` and
 * `downgraded` — "there is no high-quality copy" is an answer (`pairTwins`
 * models it as `main: undefined`), and a silent substitution is what D576
 * forbids. Refusing was the other way of getting it wrong.
 *
 * An ABSENT profile is not `high`: a caller that stated no preference gets the
 * cheap copy, which is what all three call sites did before this function
 * existed (`profile === 'high'` on `undefined` is false).
 */
export function chooseClipTwin(profile: CamProfile | undefined, row: TwinChoiceRow): TwinChoice {
  const wantsMain = profile === 'high'
  const mainFileName = wantsMain ? row.mainFileName : undefined
  if (mainFileName !== undefined)
    return { twin: 'main', fileName: mainFileName, served: 'high', downgraded: false }
  return {
    twin: 'sub',
    fileName: row.subFileName,
    served: 'low',
    downgraded: wantsMain,
  }
}
