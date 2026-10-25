/**
 * Share placement (D748): which node — or which device of a node — a NEW
 * detection session goes to when the cluster's `sessionPlacement` policy is
 * `share`. Pure.
 *
 * A share is a share of PARALLEL sessions. At each session start the
 * candidate furthest below its share of the sessions running once this one
 * starts wins:
 *
 *     deficit_i = share_i / Σshare × (Σrunning + 1) − running_i
 *
 * so with 70/20/10 and an empty cluster the first session goes to the 70,
 * and ten concurrent sessions settle at 7/2/1. Sessions a pin placed count
 * toward their candidate like any other — a pinned node is not owed extra.
 *
 * Work-conserving: when the turn holder has no room — at an EXPLICIT cap
 * (`maxSessions` / `maxCameras`) or drowning (its pool at the shed cap) — the
 * session goes to the free candidate with the most spare explicit capacity,
 * then the largest deficit. Never onto a saturated one. A capacity derived
 * from the measured latency table is advisory only and never enters here: it
 * would turn a suggestion into a de-facto cap.
 *
 * When every uncapped candidate is saturated the turn holder keeps the
 * session: excluding the whole set would silently disable placement.
 */

export interface ShareCandidate {
  readonly key: string
  /** Relative share (any scale; ≤ 0 = wanted last). */
  readonly share: number
  /** Sessions running on this candidate now. */
  readonly running: number
  /**
   * Recent elections that are not running now, decayed over time (default 0).
   * Sessions that never overlap leave `running` at 0 at every election, so the
   * deficits tie forever and the key order hands every session to the same
   * candidate; counting history makes the CUMULATIVE split follow the shares.
   */
  readonly recent?: number
  /** At an explicit cap — never elected. */
  readonly capped: boolean
  /** Drowning (pool queue at its shed cap) — stepped over while another is free. */
  readonly saturated: boolean
  /** Spare sessions under an explicit cap; absent = no explicit cap. */
  readonly spare?: number
}

export type ShareYieldReason = 'at-cap' | 'saturated'

export type ShareElection =
  | { readonly kind: 'elected'; readonly key: string; readonly reason: 'share' }
  | {
      readonly kind: 'elected'
      readonly key: string
      readonly reason: 'yield'
      /** The candidate whose turn it was. */
      readonly turnKey: string
      readonly yieldReason: ShareYieldReason
    }
  | { readonly kind: 'none' }

interface Scored {
  readonly candidate: ShareCandidate
  readonly deficit: number
}

/** Deficits equal up to float noise (0.7 × 2 − 1 is 0.3999…, not 0.4). */
const DEFICIT_EPSILON = 1e-9

function byDeficit(a: Scored, b: Scored): number {
  const diff = b.deficit - a.deficit
  return (
    (Math.abs(diff) < DEFICIT_EPSILON ? 0 : diff) ||
    b.candidate.share - a.candidate.share ||
    a.candidate.key.localeCompare(b.candidate.key)
  )
}

function spareOf(c: ShareCandidate): number {
  return c.spare ?? Number.POSITIVE_INFINITY
}

function loadOf(c: ShareCandidate): number {
  return Math.max(c.running, 0) + Math.max(c.recent ?? 0, 0)
}

/** Every candidate with its deficit, the turn holder first. */
function scoreShares(candidates: readonly ShareCandidate[]): readonly Scored[] {
  const shareSum = candidates.reduce((s, c) => s + Math.max(c.share, 0), 0)
  const running = candidates.reduce((s, c) => s + loadOf(c), 0)
  return candidates
    .map(
      (candidate): Scored => ({
        candidate,
        deficit:
          (shareSum > 0 ? Math.max(candidate.share, 0) / shareSum : 1 / candidates.length) *
            (running + 1) -
          loadOf(candidate),
      }),
    )
    .toSorted(byDeficit)
}

export function electByShare(candidates: readonly ShareCandidate[]): ShareElection {
  if (candidates.length === 0) return { kind: 'none' }
  return electFromScored(scoreShares(candidates))
}

function electFromScored(scored: readonly Scored[]): ShareElection {
  const turn = scored[0]!.candidate
  if (!turn.capped && !turn.saturated) return { kind: 'elected', key: turn.key, reason: 'share' }

  const free = scored
    .filter((s) => !s.candidate.capped && !s.candidate.saturated)
    .toSorted((a, b) => spareOf(b.candidate) - spareOf(a.candidate) || byDeficit(a, b))
  const yieldReason: ShareYieldReason = turn.capped ? 'at-cap' : 'saturated'
  if (free.length > 0) {
    return {
      kind: 'elected',
      key: free[0]!.candidate.key,
      reason: 'yield',
      turnKey: turn.key,
      yieldReason,
    }
  }
  // Nobody is free. A capped turn holder still cannot take it; the first
  // uncapped candidate (all saturated) keeps it rather than disabling placement.
  const uncapped = scored.find((s) => !s.candidate.capped)
  if (uncapped === undefined) return { kind: 'none' }
  return { kind: 'elected', key: uncapped.candidate.key, reason: 'share' }
}

/**
 * Affinity (D916, amends D913): a camera's sessions are short and frequent, and
 * every election is a fresh one — with the recency memory rotating on purpose,
 * one camera hopped node on 11 of 14 sessions in ten minutes, each hop a stream
 * dial, a decode-worker fork and a cold pre-roll. The candidate a camera ran on
 * last is kept while its deficit is within {@link SHARE_AFFINITY_TOLERANCE_SESSIONS}
 * of the turn holder's, and while it has room (offered, not capped, not
 * drowning). It moves only when the share is really off — and because a kept
 * session still counts toward its candidate, the cumulative split still follows
 * the shares: no candidate runs more than about one session over its share
 * before its cameras leave.
 */
export const SHARE_AFFINITY_TOLERANCE_SESSIONS = 1

export type ShareAffinityReason =
  /** The camera has no remembered placement (first session, or it expired). */
  | 'no-previous'
  /** The previous candidate is not offered this time (offline, ineligible, in backoff). */
  | 'previous-ineligible'
  /** The previous candidate is at its cap or drowning. */
  | 'previous-no-room'
  /** The share rule elected the previous candidate anyway. */
  | 'previous-is-turn'
  /** Kept: the previous candidate is within the tolerance of the turn holder. */
  | 'within-one-session'
  /** Moved: the previous candidate is more than the tolerance over its share. */
  | 'share-off'

/** One candidate as the election saw it — what the election line logs. */
export interface ShareScoredCandidate {
  readonly key: string
  readonly share: number
  readonly running: number
  readonly recent: number
  readonly deficit: number
}

export interface ShareAffinityElection {
  readonly election: ShareElection
  /** True when the elected candidate is the previous one. */
  readonly sticky: boolean
  readonly affinityReason: ShareAffinityReason
  readonly previousKey: string | null
  /** The candidate the plain share rule elected (null when nothing was). */
  readonly turnKey: string | null
  readonly scored: readonly ShareScoredCandidate[]
}

function toScoredCandidate(s: Scored): ShareScoredCandidate {
  return {
    key: s.candidate.key,
    share: s.candidate.share,
    running: s.candidate.running,
    recent: s.candidate.recent ?? 0,
    deficit: s.deficit,
  }
}

/** {@link electByShare}, keeping the previous candidate while the share allows it. */
export function electByShareWithAffinity(
  candidates: readonly ShareCandidate[],
  previousKey: string | null,
  toleranceSessions: number = SHARE_AFFINITY_TOLERANCE_SESSIONS,
): ShareAffinityElection {
  const scored = candidates.length === 0 ? [] : scoreShares(candidates)
  const plain: ShareElection = scored.length === 0 ? { kind: 'none' } : electFromScored(scored)
  const turnKey = plain.kind === 'elected' ? plain.key : null
  const result = (
    election: ShareElection,
    sticky: boolean,
    affinityReason: ShareAffinityReason,
  ): ShareAffinityElection => ({
    election,
    sticky,
    affinityReason,
    previousKey,
    turnKey,
    scored: scored.map(toScoredCandidate),
  })
  if (previousKey === null) return result(plain, false, 'no-previous')
  if (turnKey === previousKey) return result(plain, true, 'previous-is-turn')
  const previous = scored.find((s) => s.candidate.key === previousKey)
  if (previous === undefined) return result(plain, false, 'previous-ineligible')
  if (previous.candidate.capped || previous.candidate.saturated) {
    return result(plain, false, 'previous-no-room')
  }
  const elected = scored.find((s) => s.candidate.key === turnKey)
  if (elected === undefined) return result(plain, false, 'share-off')
  if (previous.deficit >= elected.deficit - toleranceSessions - DEFICIT_EPSILON) {
    return result(
      { kind: 'elected', key: previousKey, reason: 'share' },
      true,
      'within-one-session',
    )
  }
  return result(plain, false, 'share-off')
}
