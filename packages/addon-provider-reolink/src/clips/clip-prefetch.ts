/**
 * The still prefetch: what one pass may spend, and when it must stop asking.
 *
 * D549-16 designed this — a bound, a second queue lane, a sulking-host rule,
 * a headroom that forbids eviction — and D574 found that nothing outside a
 * test ever called it. This module is the half that decides; the pass itself
 * lives in `clip-service.ts` and the caller is the catalog refresh
 * (`clip-refresh.ts`), which already runs per camera on a topology-aware
 * schedule, already asks whether a host is busy, and already defers to
 * interactive work.
 *
 * ## What a still costs, per topology (measured 2026-09-21, live)
 *
 * | shape | route | one cold still | the prefetch |
 * | --- | --- | --- | --- |
 * | mains standalone (592) | its own socket | 194–212 ms | runs |
 * | hub child (3628) | the PARENT's one shared session | 212–522 ms | runs |
 * | standalone battery (640, 4263) | a login, which IS the wake | — | never |
 *
 * A standalone battery camera is refused in BOTH of its refresh modes.
 * `mark-stale` read no catalog at all, so there is nothing to prefetch
 * against. `forced-wake` did read one — but the operator's own switch text
 * says "one interval buys exactly one wake", and it bought it for the
 * CATALOG; sixty CoverPreviews on top of that is a second meaning for a knob
 * that already names what it buys (D62). A standalone battery camera's stills
 * are minted the way they always were: by an operator opening a tile, which
 * is somebody waiting for the answer.
 *
 * ## Why the budget is on MINTS and not on rows
 *
 * It was on rows (`slice(0, limit)`), and that bound cannot backfill. 592
 * recorded 396 clips in 24 h on 2026-09-21 and held a vouched still for 25.3 %
 * of the 1 188 rows in its cache: the newest 20 were always warm, so every
 * pass examined twenty warm rows and minted nothing, for ever. The budget is
 * now the number of stills a pass may MINT, and the scan walks the whole
 * catalog newest-first behind them — so a pass both keeps up with the live
 * edge and fills in what the pass before it could not reach.
 *
 * ## Why a pass stops on the FIRST refusal
 *
 * `ClipThumbQueue`'s host backoff arms only on a camera REFUSAL — a
 * `400 rejected` — and that is the right rule for the lane. It does not cover
 * a camera that simply does not answer: 108, a mains standalone, took
 * 30 041 / 30 017 / 30 020 ms for three cold stills on 2026-09-21 and answered
 * `camera-refused` / `final` each time, with the queue's backoff never arming.
 * A budget of sixty there is half an hour of the host's lane per pass, minting
 * nothing. So the pass stops at the first refusal of any kind and names it,
 * and the scheduler turns a stopped pass into a quiet period that DOUBLES —
 * because a prefetch that keeps trying a host that is refusing is exactly the
 * shape a backoff exists to prevent, and this one is not covered by the
 * lane's.
 */
import type { ClipStillDisposition, ClipStillRefusalCode } from '@camstack/types'
import type { ClipRefreshMode } from './clip-refresh.js'

/**
 * How many stills ONE pass may MINT for one device.
 *
 * Sixty, because sixty is the operator's first screen: D574 measured a first
 * paint of 60 tiles on 592, of which 43 were told to come back. A budget under
 * the first screen guarantees a cold first paint whatever else is true, and
 * 20 — the value D549-16 shipped — could not even reach the second row of it.
 * The cost is bounded by the same measurement: 60 × ~200 ms is 12 s of a mains
 * camera's own socket per pass, once per refresh interval (0.7 % of a 30-minute
 * interval), and it yields to an interactive mint between every one of them
 * because the lane drains `interactive` before `prefetch`.
 */
export const PREFETCH_BATCH = 60

/**
 * How many mints a pass may make between two headroom reads.
 *
 * `hasHeadroomForPrefetch` is a `readdir` plus a `stat` per file, so reading it
 * after every mint makes a pass quadratic in the size of the cache — 60 mints
 * against 592's 2 000-file bound is 120 000 `stat` calls for a question whose
 * answer cannot have moved. The headroom it defends is 10 % of 64 MiB (6.4 MiB,
 * some 200 stills at the 32–35 KiB measured on 592), so sixteen mints can never
 * cross it between two reads.
 */
export const PREFETCH_HEADROOM_RECHECK = 16

/** The longest a device may stay quiet after refusals, whatever its interval. */
export const PREFETCH_QUIET_MAX_MS = 12 * 60 * 60_000

/**
 * How long a device that refused stays un-asked, in INTERVALS rather than
 * wall-clock: the refresh interval is an operator setting (5 min – 24 h), and
 * a quiet period in minutes would be either no gap at all at one end or a day
 * at the other. One refusal skips the next two passes, two skips four, and so
 * on, capped.
 */
export function prefetchQuietMs(consecutiveRefusals: number, intervalMs: number): number {
  if (consecutiveRefusals <= 0) return 0
  const doubled = intervalMs * 2 ** consecutiveRefusals
  return Number.isFinite(doubled) ? Math.min(doubled, PREFETCH_QUIET_MAX_MS) : PREFETCH_QUIET_MAX_MS
}

/** Why a pass ended. Every one of them is a bound; none of them is "it ran out
 *  of patience", because a pass has none to run out of. */
export type ClipPrefetchStop =
  /** The mint budget is spent, and rows remain. */
  | 'budget'
  /** Every row the catalog holds for this device is now vouched for. */
  | 'rows-exhausted'
  /** The device's LRU is inside its headroom. A prefetch never evicts. */
  | 'no-headroom'
  /** A mint was refused. The pass stops there rather than meeting the same
   *  wall once per remaining row. */
  | 'refused'

/** The refusal that stopped a pass, named per kind so an operator complaint
 *  about one camera is one complaint (D391/D400). */
export interface ClipPrefetchRefusal {
  readonly code: ClipStillRefusalCode
  readonly disposition: ClipStillDisposition
  readonly clipKey: string
}

/** What one pass really did. A count alone cannot tell "nothing to do" from
 *  "stopped on the first row", and those want opposite reactions. */
export interface ClipPrefetchOutcome {
  readonly minted: number
  /** Catalog rows looked at, cached ones included. */
  readonly scanned: number
  /** Rows that already had a vouched still — the pass paid a `stat`, no mint. */
  readonly alreadyHeld: number
  readonly stop: ClipPrefetchStop
  readonly refusal: ClipPrefetchRefusal | null
}

/** Why a pass was not attempted at all. */
export type ClipPrefetchSkipReason =
  /** `forced-wake`: the wake the operator authorised bought the catalog. */
  | 'battery-wake-cost'
  /** An operator-facing mint holds this host's lane. */
  | 'host-busy'
  /** This device refused recently and is on the quiet ladder. */
  | 'quiet-after-refusal'

export type ClipPrefetchDecision =
  | { readonly kind: 'run' }
  | { readonly kind: 'skip'; readonly reason: ClipPrefetchSkipReason }

/**
 * The modes a prefetch may even be ASKED about.
 *
 * `mark-stale` is excluded by the type rather than by a clause, because a
 * clause handling a mode that cannot arrive is a leftover that reads as
 * verification: the timer's `mark-stale` branch read no catalog, so it returns
 * before any of this and already says on its own line that nothing was read.
 * A refresh that FAILED is the same and returns the same way. So the only
 * question left here is about a camera whose catalog really landed.
 */
export type ClipPrefetchMode = Exclude<ClipRefreshMode, 'mark-stale'>

export interface ClipPrefetchInput {
  /** The mode the refresh for this camera ran in. */
  readonly mode: ClipPrefetchMode
  /** Asked AGAIN after the refresh: a refresh is not instantaneous, and the
   *  operator who took the lane during it must not queue behind a prefetch. */
  readonly hostBusy: boolean
  readonly quiet: boolean
}

/**
 * May this camera's stills be prefetched right now?
 *
 * The topology comes first and is absolute: no amount of idle host or empty
 * ladder makes a still on a standalone battery camera free.
 */
export function decideClipPrefetch(input: ClipPrefetchInput): ClipPrefetchDecision {
  if (input.mode === 'forced-wake') return { kind: 'skip', reason: 'battery-wake-cost' }
  if (input.quiet) return { kind: 'skip', reason: 'quiet-after-refusal' }
  if (input.hostBusy) return { kind: 'skip', reason: 'host-busy' }
  return { kind: 'run' }
}
