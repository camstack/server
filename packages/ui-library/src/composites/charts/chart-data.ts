/**
 * Data shaping for the chart family — pure, no DOM, no uPlot.
 *
 * uPlot draws from ONE shared x array with one y array per series. Two kinds
 * of "no value" must stay distinct when several series are joined onto it:
 *
 *  - `undefined` — this series has no sample at an x another series has. The
 *    line is JOINED across it (alignment filler, not a claim).
 *  - `null` — nobody measured here: an explicit unknown sample, or a hole
 *    longer than the series' `gapMs`. The line BREAKS and is never drawn as 0.
 */

/** One sample. `null` is unknown, never zero. */
export interface TimePoint {
  readonly t: number
  readonly v: number | null
  /** Optional spread of a rolled-up bucket — drawn as a band. */
  readonly min?: number | null
  readonly max?: number | null
}

export interface AlignInput {
  readonly points: readonly TimePoint[]
  /** Longest interval between two samples that may be joined; omit for change-only (held) series. */
  readonly gapMs?: number
}

export type AlignedValue = number | null | undefined

export interface AlignedSeries {
  /** Ascending, unique, epoch ms. */
  readonly xs: readonly number[]
  readonly ys: readonly (readonly AlignedValue[])[]
  readonly mins: readonly (readonly AlignedValue[])[]
  readonly maxs: readonly (readonly AlignedValue[])[]
}

/** Join several series onto one x array, inserting a `null` inside every hole wider than its `gapMs`. */
export function alignSeries(inputs: readonly AlignInput[]): AlignedSeries {
  const sorted = inputs.map((s) => [...s.points].sort((a, b) => a.t - b.t))
  const breaks = sorted.map((pts, i) => gapBreaks(pts, inputs[i]?.gapMs))
  const xset = new Set<number>()
  for (const pts of sorted) for (const p of pts) xset.add(p.t)
  for (const b of breaks) for (const t of b) xset.add(t)
  const xs = [...xset].sort((a, b) => a - b)
  const index = new Map<number, number>()
  xs.forEach((x, i) => index.set(x, i))
  const blank = (): AlignedValue[] => xs.map(() => undefined)
  const ys: AlignedValue[][] = []
  const mins: AlignedValue[][] = []
  const maxs: AlignedValue[][] = []
  sorted.forEach((pts, si) => {
    const y = blank()
    const lo = blank()
    const hi = blank()
    // A hole breaks the line AND its band: a filler would let the band span it.
    for (const t of breaks[si] ?? []) {
      const i = index.get(t)
      if (i !== undefined) {
        y[i] = null
        lo[i] = null
        hi[i] = null
      }
    }
    for (const p of pts) {
      const i = index.get(p.t)
      if (i === undefined) continue
      y[i] = p.v
      if (p.min !== undefined) lo[i] = p.min
      if (p.max !== undefined) hi[i] = p.max
    }
    ys.push(y)
    mins.push(lo)
    maxs.push(hi)
  })
  return { xs, ys, mins, maxs }
}

/** The x of a `null` placed inside every hole: one millisecond after the sample before it. */
function gapBreaks(points: readonly TimePoint[], gapMs: number | undefined): readonly number[] {
  if (gapMs === undefined || !(gapMs > 0)) return []
  const out: number[] = []
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]
    const cur = points[i]
    if (prev && cur && cur.t - prev.t > gapMs) out.push(prev.t + 1)
  }
  return out
}

/** A time range nobody measured, for shading. */
export interface GapSpan {
  readonly from: number
  readonly to: number
}

/**
 * The holes every series shares (the intersection), so the chart shades only
 * what NOBODY measured. Series without `gapMs` never contribute a hole and so
 * make the intersection empty: a held value is not unmeasured.
 */
export function sharedGapSpans(inputs: readonly AlignInput[]): readonly GapSpan[] {
  if (inputs.length === 0) return []
  let acc: GapSpan[] | null = null
  for (const s of inputs) {
    const own = ownGaps(s)
    acc = acc === null ? own : intersectSpans(acc, own)
    if (acc.length === 0) return []
  }
  return acc ?? []
}

function ownGaps(s: AlignInput): GapSpan[] {
  const gapMs = s.gapMs
  if (gapMs === undefined || !(gapMs > 0)) return []
  const pts = [...s.points].sort((a, b) => a.t - b.t)
  const out: GapSpan[] = []
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1]
    const cur = pts[i]
    if (prev && cur && cur.t - prev.t > gapMs) out.push({ from: prev.t, to: cur.t })
  }
  return out
}

function intersectSpans(a: readonly GapSpan[], b: readonly GapSpan[]): GapSpan[] {
  const out: GapSpan[] = []
  for (const x of a) {
    for (const y of b) {
      const from = Math.max(x.from, y.from)
      const to = Math.min(x.to, y.to)
      if (to > from) out.push({ from, to })
    }
  }
  return out
}

/**
 * Cumulative sums for a stacked area: `out[i] = ys[0] + … + ys[i]`. A stack
 * level is unknown (`null`) as soon as any layer under it is unknown, and an
 * alignment filler stays a filler.
 */
export function stackSeries(ys: readonly (readonly AlignedValue[])[]): AlignedValue[][] {
  const out: AlignedValue[][] = []
  ys.forEach((row, si) => {
    const below = si === 0 ? null : out[si - 1]
    out.push(
      row.map((v, i) => {
        if (v === undefined) return undefined
        if (v === null) return null
        if (below === null || below === undefined) return v
        const b = below[i]
        if (b === null) return null
        if (b === undefined) return v
        return b + v
      }),
    )
  })
  return out
}

/**
 * The value a reader sees at index `idx`: the nearest sample at or before it
 * that is not an alignment filler. A `null` there is answered as unknown.
 */
export function valueAtOrBefore(
  xs: readonly number[],
  ys: readonly AlignedValue[],
  idx: number,
): number | null {
  for (let i = Math.min(idx, xs.length - 1); i >= 0; i--) {
    const v = ys[i]
    if (v !== undefined) return v
  }
  return null
}

// ── States ──────────────────────────────────────────────────────────────

/** A state held from `from` until `to`. `state: null` is unknown (not recorded), never a state. */
export interface StateSegment {
  readonly from: number
  readonly to: number
  readonly state: string | null
}

/** One state change, as a history read answers it: the state from `t` on. */
export interface StateChange {
  readonly t: number
  readonly state: string | null
}

/**
 * Turn change points into segments clipped to [from, to]. `before` is the
 * state in force when the window opens (the last change before it); without
 * it the window starts unknown until the first change.
 */
export function segmentsFromChanges(
  changes: readonly StateChange[],
  from: number,
  to: number,
  before: string | null = null,
): readonly StateSegment[] {
  const sorted = [...changes].filter((c) => c.t < to).sort((a, b) => a.t - b.t)
  const out: StateSegment[] = []
  let cursor = from
  let state: string | null = before
  for (const c of sorted) {
    if (c.t <= from) {
      state = c.state
      continue
    }
    if (c.state === state) continue
    out.push({ from: cursor, to: c.t, state })
    cursor = c.t
    state = c.state
  }
  if (to > cursor) out.push({ from: cursor, to, state })
  return out.filter((s) => s.to > s.from && s.state !== null)
}

/** Total milliseconds per state over the segments (unknown spans are not counted). */
export function timeInState(segments: readonly StateSegment[]): ReadonlyMap<string, number> {
  const out = new Map<string, number>()
  for (const s of segments) {
    if (s.state === null) continue
    out.set(s.state, (out.get(s.state) ?? 0) + Math.max(0, s.to - s.from))
  }
  return out
}

/** The state in force at `t`, or `null` when nothing was recorded there. */
export function stateAt(segments: readonly StateSegment[], t: number): string | null {
  for (const s of segments) if (t >= s.from && t < s.to) return s.state
  return null
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** `2h 14m`, `3d 4h`, `45s` — two units at most, for a legend. */
export function formatSpan(ms: number): string {
  if (!(ms > 0)) return '0s'
  if (ms < MINUTE) return `${String(Math.round(ms / 1000))}s`
  if (ms < HOUR) return `${String(Math.floor(ms / MINUTE))}m`
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR)
    const m = Math.floor((ms % HOUR) / MINUTE)
    return m > 0 ? `${String(h)}h ${String(m)}m` : `${String(h)}h`
  }
  const d = Math.floor(ms / DAY)
  const h = Math.floor((ms % DAY) / HOUR)
  return h > 0 ? `${String(d)}d ${String(h)}h` : `${String(d)}d`
}

// ── Time axis ───────────────────────────────────────────────────────────

const TIME_HM: Readonly<Intl.DateTimeFormatOptions> = { hour: '2-digit', minute: '2-digit' }
const TIME_HMS: Readonly<Intl.DateTimeFormatOptions> = {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
}
const DATE_DM: Readonly<Intl.DateTimeFormatOptions> = { day: '2-digit', month: 'short' }
const DATE_MY: Readonly<Intl.DateTimeFormatOptions> = { month: 'short', year: '2-digit' }

/**
 * A wall-clock label at the precision the window's length justifies:
 * seconds under ten minutes, `HH:MM` within two days, the date past that,
 * month + year past ~4 months.
 */
export function formatTimeLabel(t: number, spanMs: number): string {
  const d = new Date(t)
  if (spanMs < 10 * MINUTE) return d.toLocaleTimeString(undefined, TIME_HMS)
  if (spanMs <= 2 * DAY) return d.toLocaleTimeString(undefined, TIME_HM)
  if (spanMs <= 120 * DAY) return d.toLocaleDateString(undefined, DATE_DM)
  return d.toLocaleDateString(undefined, DATE_MY)
}

/** A cursor readout time: always the full instant at the window's precision. */
export function formatCursorTime(t: number, spanMs: number): string {
  const d = new Date(t)
  if (spanMs <= 2 * DAY)
    return d.toLocaleTimeString(undefined, spanMs < 10 * MINUTE ? TIME_HMS : TIME_HM)
  return `${d.toLocaleDateString(undefined, DATE_DM)} ${d.toLocaleTimeString(undefined, TIME_HM)}`
}
