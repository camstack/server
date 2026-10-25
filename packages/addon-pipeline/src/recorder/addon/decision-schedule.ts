/**
 * WHEN could the recorder's live gate change its mind? — the pure arithmetic
 * behind the controller's event-driven wake-ups.
 *
 * `shouldRecordAt(config, triggers, at)` is a function of three things. Two of
 * them move on their own:
 *
 *  - **an `events` band's demand window**, which closes at
 *    `lastTrigger + postBufferSec` and is otherwise only ever re-opened by a
 *    trigger (an event the controller already receives);
 *  - **the band covering `at`**, which changes at a wall-clock instant that the
 *    band model states in advance.
 *
 * Everything else (`enabled`, the band list) arrives as a config RPC, which the
 * controller converges on directly.
 *
 * So the loop does not have to POLL to find out that a window closed or a band
 * ended: it can compute the exact next instant and sleep until it. That is what
 * this module returns, and it is deliberately pure — the timer that consumes it
 * lives in `device-wakeups.ts` and the decision it re-triggers lives in the
 * controller.
 *
 * Until 2026-08-18 the ONLY thing that ever closed an `events` window was the
 * 30 s convergence pass, so an isolated trigger kept a 4K camera pulled, decoded
 * and written for up to a full tick past the operator's `postBufferSec`.
 *
 * ## The band edge is computed, never scanned
 *
 * `bandActiveAt` reads the LOCAL calendar (`getDay()`, `getHours()`,
 * `getMinutes()`), so the active band can only change at one of a small, known
 * set of instants: each band's `start` and `end` on each of the next few local
 * days, plus each local midnight (where `days` membership flips). Every
 * candidate is built with the same local-calendar constructor the engine reads,
 * so DST and week wrap are handled by the platform rather than by arithmetic
 * here. Candidates are then filtered through `activeBandAt` itself — the timer
 * and the gate can never disagree about what an edge IS, because only one of
 * them defines it.
 */
import type { RecordingBand, RecordingConfig } from '@camstack/types'
import { activeBandAt } from '../band-engine.js'
import {
  bandTriggerSources,
  effectiveBands,
  heldSinceMs,
  latestTriggerMs,
  resolveBandBufferMs,
  type EffectiveBand,
  type TriggerState,
} from './band-decision.js'

/**
 * The live gate is INCLUSIVE at its upper bound: `eventsBandDemanded` tests
 * `atMs - lastMs <= postMs`, so recording is still demanded AT
 * `lastTrigger + postBufferSec`. The first instant it is not is one millisecond
 * later, and that is what a detach must be armed for — arming at the bound
 * itself would wake, re-decide "still recording", and re-arm at the same
 * instant forever.
 */
export const GATE_INCLUSIVE_EPSILON_MS = 1

/**
 * How far ahead a band edge is searched, in local days. A band repeats weekly,
 * so 8 days covers every reachable edge (7 for the weekly cycle, +1 so a band
 * that only applies to today's weekday still finds its next occurrence from any
 * instant inside today). Beyond it there is nothing new to find, and returning
 * `null` is honest: the reconcile is the backstop for anything this cannot see.
 */
export const BAND_EDGE_HORIZON_DAYS = 8

/** Why a wake-up was armed — carried into the log line so a spurious wake is attributable. */
export type DecisionChangeReason = 'window-close' | 'band-edge'

/** The next instant at which {@link nextDecisionChangeAt} expects a different answer. */
export interface DecisionChange {
  readonly atMs: number
  readonly reason: DecisionChangeReason
}

/** Everything the schedule is a function of — the same inputs as the live gate. */
export interface DecisionScheduleInput {
  readonly config: RecordingConfig
  readonly triggers: TriggerState
  readonly nowMs: number
}

/** Local-calendar instant for `HH:MM` on the given local Y/M/D (day may overflow). */
function localInstantMs(year: number, month: number, day: number, hhmm: string): number {
  const [hours, minutes] = hhmm.split(':')
  return new Date(year, month, day, Number(hours), Number(minutes), 0, 0).getTime()
}

/**
 * Every instant inside the horizon at which `bandActiveAt` COULD change value:
 * each band's start and end on each local day, plus each local midnight (the
 * `days` membership boundary). A superset — cheap to compute (a few dozen
 * entries) and filtered against `activeBandAt` below.
 */
function candidateEdgesMs(bands: readonly RecordingBand[], nowMs: number): readonly number[] {
  const base = new Date(nowMs)
  const year = base.getFullYear()
  const month = base.getMonth()
  const day = base.getDate()
  const out: number[] = []
  for (let offset = 0; offset <= BAND_EDGE_HORIZON_DAYS; offset++) {
    out.push(new Date(year, month, day + offset, 0, 0, 0, 0).getTime())
    for (const band of bands) {
      out.push(localInstantMs(year, month, day + offset, band.start))
      out.push(localInstantMs(year, month, day + offset, band.end))
    }
  }
  return out
}

/**
 * The next instant at which a DIFFERENT band (or no band) covers the clock, or
 * `null` when none exists inside {@link BAND_EDGE_HORIZON_DAYS} — the always-on
 * band (`start === end`, empty `days`) being the common case that legitimately
 * has no edge at all.
 *
 * Identity is by band REFERENCE, which is what makes this exact: two distinct
 * band objects with the same fields yield an edge that changes nothing, which
 * costs one wasted wake-up and never costs footage.
 */
export function nextBandEdgeMs(config: RecordingConfig, nowMs: number): number | null {
  const bands = effectiveBands(config)
  if (bands.length === 0) return null
  const current = activeBandAt({ bands }, new Date(nowMs))
  const candidates = [...new Set(candidateEdgesMs(bands, nowMs))]
    .filter((ms) => ms > nowMs)
    .toSorted((a, b) => a - b)
  for (const ms of candidates) {
    if (activeBandAt({ bands }, new Date(ms)) !== current) return ms
  }
  return null
}

/**
 * The first instant an `events` band's demand window is CLOSED, given the
 * triggers it listens for, or `null` when no window is open at `nowMs`.
 *
 * Demand is an OR across the listened trigger kinds, so an open window ends
 * with the LATEST of them — a motion trigger followed by an audio trigger 5 s
 * later keeps the camera attached until the audio one expires, exactly as the
 * sliding window already behaved.
 */
export function eventsWindowCloseMs(
  band: EffectiveBand,
  triggers: TriggerState,
  nowMs: number,
): number | null {
  if (band.mode !== 'events') return null
  const { postMs } = resolveBandBufferMs(band)
  const sources = bandTriggerSources(band)
  // A HELD source has no close instant: only its release (an event the
  // controller receives, or the reconcile's bound) can end the demand, and
  // arming a timer for "never" would be a wake-up that re-decides nothing.
  if (sources.some((source) => heldSinceMs(triggers, source) !== null)) return null
  // The NEWEST window of each listened source closes last, so only it can hold
  // the live gate open — the older windows in the history exist for the KEEP
  // gate, which reads pre-trigger footage the live gate never re-opens for.
  const open = sources
    .map((source) => latestTriggerMs(triggers, source))
    .filter((ms): ms is number => ms !== null)
    .map((ms) => ms + postMs)
    .filter((ms) => ms >= nowMs)
  if (open.length === 0) return null
  return Math.max(...open) + GATE_INCLUSIVE_EPSILON_MS
}

/**
 * THE next instant the controller must re-evaluate this device, or `null` when
 * nothing can change without an event the controller already receives (a
 * trigger or a config write).
 *
 * Whichever of the two sources comes first wins, and the reason is carried so
 * the wake-up is attributable in the log without correlating timestamps.
 */
export function nextDecisionChangeAt(input: DecisionScheduleInput): DecisionChange | null {
  const { config, triggers, nowMs } = input
  // A disabled config records nothing whatever the clock does; it re-enters
  // through `onConfigChanged`, which is an RPC and cannot be dropped.
  if (!config.enabled) return null
  const bands = effectiveBands(config)
  if (bands.length === 0) return null
  const band = activeBandAt({ bands }, new Date(nowMs))
  const edgeMs = nextBandEdgeMs(config, nowMs)
  const closeMs = band === null ? null : eventsWindowCloseMs(band, triggers, nowMs)
  if (closeMs === null) return edgeMs === null ? null : { atMs: edgeMs, reason: 'band-edge' }
  if (edgeMs === null || closeMs <= edgeMs) return { atMs: closeMs, reason: 'window-close' }
  return { atMs: edgeMs, reason: 'band-edge' }
}
