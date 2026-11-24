/**
 * The next instant a wall-clock verdict flips. Kept apart from the judgement so
 * a caller that only asks "inside?" never pays for the search, and so the
 * search takes the verdict as a function: it holds no copy of the window rule.
 */
import { localMinuteOfDay } from './time-spec.js'

const MS_PER_MINUTE = 60_000
const MS_PER_HOUR = 60 * MS_PER_MINUTE
const MS_PER_DAY = 24 * MS_PER_HOUR
const MINUTES_PER_DAY = 24 * 60
/** Jumps are sampled from one day before a bucket to this many days after its start. */
const JUMP_SPAN_DAYS = 11
const JUMP_CACHE_LIMIT = 64

/** A DST change: the instant the wall clock jumped, and by how many ms (negative = repeated hour). */
export interface ClockJump {
  readonly atMs: number
  readonly deltaMs: number
}

/** A wall-clock minute the verdict can flip on, and where it falls on a given local day offset. */
export interface FlipBoundary {
  readonly minuteOfDay: number
  /** The first instant that boundary happens `dayOffset` days from the day of `nowMs`, or null. */
  readonly baseOn: (dayOffset: number) => number | null
}

export interface FlipSearch {
  readonly nowMs: number
  readonly timeZone: string
  readonly boundaries: readonly FlipBoundary[]
  /** Local days ahead (and one behind) whose boundaries are tried. */
  readonly lookaheadDays: number
  readonly verdictAt: (atMs: number) => boolean | null
}

/**
 * Wall-clock minus elapsed time between two instants, as minutes in (-720, 720]:
 * 0 while the zone's offset is unchanged, the shift once it has changed.
 */
function driftMinutes(fromMs: number, toMs: number, timeZone: string): number {
  const wall = localMinuteOfDay(toMs, timeZone) - localMinuteOfDay(fromMs, timeZone)
  const elapsed = Math.round((toMs - fromMs) / MS_PER_MINUTE)
  const d = (((wall - elapsed) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
  return d > MINUTES_PER_DAY / 2 ? d - MINUTES_PER_DAY : d
}

const jumpCache = new Map<string, readonly ClockJump[]>()

/**
 * The clock jumps of a zone around `nowMs`. The offset is only visible through
 * the wall clock, so it is sampled hourly and each jump located to the minute.
 * Cached per (zone, day bucket): a zone's rules do not change within a process,
 * and every call in a day shares the bucket.
 */
export function clockJumpsAround(nowMs: number, timeZone: string): readonly ClockJump[] {
  const bucket = Math.floor(nowMs / MS_PER_DAY)
  const key = `${timeZone}|${bucket}`
  const cached = jumpCache.get(key)
  if (cached !== undefined) return cached
  const jumps: ClockJump[] = []
  const origin = (bucket - 1) * MS_PER_DAY
  for (let h = 0; h < (JUMP_SPAN_DAYS + 1) * 24; h += 1) {
    const a = origin + h * MS_PER_HOUR
    const b = a + MS_PER_HOUR
    const total = driftMinutes(a, b, timeZone)
    if (total === 0) continue
    let lo = a
    let hi = b
    while (hi - lo > MS_PER_MINUTE) {
      const mid = Math.floor((lo + hi) / 2 / MS_PER_MINUTE) * MS_PER_MINUTE
      if (driftMinutes(a, mid, timeZone) === 0) lo = mid
      else hi = mid
    }
    jumps.push({ atMs: hi, deltaMs: total * MS_PER_MINUTE })
  }
  if (jumpCache.size >= JUMP_CACHE_LIMIT) jumpCache.clear()
  jumpCache.set(key, jumps)
  return jumps
}

/**
 * The first instant after `nowMs` at which the verdict differs from the verdict
 * at `nowMs`, or null when it does not within the lookahead. The verdict only
 * changes where the wall clock reads a boundary minute or jumps, so only those
 * instants are asked. A boundary minute a jump repeats is probed one jump-shift
 * from its first occurrence, whatever the shift (an hour, or half of one).
 */
export function nextVerdictFlip(search: FlipSearch): number | null {
  const { nowMs, timeZone, verdictAt } = search
  const current = verdictAt(nowMs)
  const jumps = clockJumpsAround(nowMs, timeZone)
  const shifts = [...new Set(jumps.map((j) => Math.abs(j.deltaMs)))]
  const candidates = new Set<number>(jumps.map((j) => j.atMs))
  for (let offset = -1; offset <= search.lookaheadDays + 1; offset += 1) {
    for (const boundary of search.boundaries) {
      const base = boundary.baseOn(offset)
      if (base === null) continue
      for (const t of [base, ...shifts.flatMap((s) => [base - s, base + s])]) {
        if (localMinuteOfDay(t, timeZone) === boundary.minuteOfDay) candidates.add(t)
      }
    }
  }
  const ordered = [...candidates].filter((t) => t > nowMs).sort((a, b) => a - b)
  return ordered.find((t) => verdictAt(t) !== current) ?? null
}
