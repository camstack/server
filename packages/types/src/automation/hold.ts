/**
 * Hold semantics — "for N seconds" on a leaf of the `when` tree (#498).
 *
 * ONE primitive, `for: { ms, mode, tolerance? }`, shared by `device-becomes`,
 * `device-is` and `expression`:
 *
 *  - `held`: the condition stays true for `ms`;
 *  - `stable`: the value does not move by more than `tolerance` (absolute, in
 *    the field's base unit) for `ms` while the condition holds.
 *
 * {@link HoldCore} is the pure state machine (an input observation → a reading).
 * {@link HoldTracker} keys cores by a leaf path for the STATE leaves the tree
 * evaluator judges. {@link BecomesWatch} wraps a core with a timer for the
 * `device-becomes` EVENT leaf: the deadline is armed when the hold starts and
 * cancelled when it breaks, and the leaf fires ONCE per episode.
 *
 * Hold state is memory only. A hold that is already running when the watcher
 * first looks (a restart) is INHERITED: nobody knows when it began, so it never
 * fires for that episode and a state leaf reads it as unknown until the window
 * has elapsed from the moment the watcher started (D49: not-known is not false).
 */

import { z } from 'zod'
import type { AutomationConditionOperator } from './when.js'

export const HOLD_MAX_MS = 86_400_000

export const HoldModeSchema = z.enum(['held', 'stable'])
export type HoldMode = z.infer<typeof HoldModeSchema>

export const HoldSpecSchema = z.object({
  /** How long the condition (or the value) must hold. */
  ms: z.number().int().min(1).max(HOLD_MAX_MS),
  mode: HoldModeSchema,
  /** `stable` only: the largest move of the value that still counts as unchanged (absolute, base unit). */
  tolerance: z.number().min(0).optional(),
})
export type HoldSpec = z.infer<typeof HoldSpecSchema>

/** What a trace says about a hold. */
export const HoldTraceSchema = z.object({
  phase: z.enum(['pending', 'cancelled', 'fired', 'reseeded']),
  ms: z.number().int(),
  mode: HoldModeSchema,
  /** When the hold started (ms epoch). */
  since: z.number().optional(),
  /** When it completes (ms epoch), for a pending hold. */
  deadline: z.number().optional(),
})
export type HoldTrace = z.infer<typeof HoldTraceSchema>

/** The legacy fields of a `device-becomes` leaf, read through {@link holdOf}. */
export interface LegacyHoldFields {
  readonly for?: HoldSpec
  readonly forMs?: number
}

/**
 * The ONE reader of a leaf's hold. A leaf stored before #498 carries `forMs`
 * (a `held` window); it reads as `for: { ms, mode: 'held' }`. `0` is no hold.
 */
export function holdOf(leaf: LegacyHoldFields): HoldSpec | undefined {
  if (leaf.for !== undefined) return leaf.for
  if (leaf.forMs !== undefined && leaf.forMs > 0) return { ms: leaf.forMs, mode: 'held' }
  return undefined
}

/** `30 s`, `5 min`, `1 h 5 min` — a hold window for a human. */
export function describeHoldMs(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  const rest = s % 60
  if (m < 60) return rest === 0 ? `${m} min` : `${m} min ${rest} s`
  const h = Math.floor(m / 60)
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`
}

// ── comparison, shared with the state-leaf evaluator ──────────────────────

/** The operators a `device-becomes` leaf may carry: a threshold or a range. */
export const BecomesOperatorSchema = z.enum([
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  /** value is `[low, high]`: the field is inside it (inclusive). */
  'between',
  /** value is `[low, high]`: the field is outside it. */
  'outside',
])
export type BecomesOperator = z.infer<typeof BecomesOperatorSchema>

export function compareValues(
  actual: unknown,
  operator: AutomationConditionOperator | BecomesOperator,
  expected: unknown,
): boolean {
  switch (operator) {
    case 'eq':
      return actual === expected
    case 'ne':
      return actual !== expected
    case 'gt':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected
    case 'gte':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected
    case 'lt':
      return typeof actual === 'number' && typeof expected === 'number' && actual < expected
    case 'lte':
      return typeof actual === 'number' && typeof expected === 'number' && actual <= expected
    case 'contains':
      return typeof actual === 'string' && typeof expected === 'string' && actual.includes(expected)
    case 'in':
      return Array.isArray(expected) && expected.some((v) => v === actual)
    case 'between':
    case 'outside': {
      if (typeof actual !== 'number' || !Array.isArray(expected)) return false
      const [low, high] = expected
      if (typeof low !== 'number' || typeof high !== 'number') return false
      const inside = actual >= low && actual <= high
      return operator === 'between' ? inside : !inside
    }
  }
}

// ── the state machine ─────────────────────────────────────────────────────

export type HoldPhase = 'idle' | 'pending' | 'inherited' | 'met'

export interface HoldReading {
  readonly phase: HoldPhase
  /** When the hold started; null while idle. For an inherited hold: when it was first SEEN. */
  readonly since: number | null
  readonly remainingMs: number
  /** What this observation did to the hold. */
  readonly transition: 'started' | 'cancelled' | 'none'
}

function moved(value: unknown, anchor: unknown, tolerance: number): boolean {
  if (typeof value === 'number' && typeof anchor === 'number') {
    return Math.abs(value - anchor) > tolerance
  }
  return value !== anchor
}

export class HoldCore {
  private seen = false
  private since: number | null = null
  private inherited = false
  private anchor: unknown = undefined

  constructor(private readonly spec: HoldSpec) {}

  /**
   * One KNOWN observation. `holds` is whether the condition is true now; `value`
   * is the field (used by `stable`). A read that failed is not an observation —
   * the caller simply does not call this (D49: it never cancels a hold).
   */
  observe(holds: boolean, value: unknown, now: number): HoldReading {
    const first = !this.seen
    this.seen = true
    const wasRunning = this.since !== null
    let restarted = false
    if (!holds) {
      this.since = null
      this.inherited = false
      this.anchor = undefined
    } else if (this.spec.mode === 'held') {
      if (this.since === null) {
        this.since = now
        this.inherited = first
        restarted = true
      }
    } else if (this.since === null || moved(value, this.anchor, this.spec.tolerance ?? 0)) {
      this.anchor = value
      this.since = now
      this.inherited = first
      restarted = true
    }
    const transition = !holds
      ? wasRunning
        ? 'cancelled'
        : 'none'
      : restarted
        ? wasRunning
          ? 'cancelled'
          : 'started'
        : 'none'
    return { ...this.read(now), transition }
  }

  /** The reading at `now` with no new observation. */
  read(now: number): Omit<HoldReading, 'transition'> {
    if (this.since === null) return { phase: 'idle', since: null, remainingMs: this.spec.ms }
    const remainingMs = Math.max(0, this.since + this.spec.ms - now)
    if (remainingMs === 0) return { phase: 'met', since: this.since, remainingMs: 0 }
    return { phase: this.inherited ? 'inherited' : 'pending', since: this.since, remainingMs }
  }
}

/** Hold cores of the state leaves of one tree, keyed by the leaf's path. */
export class HoldTracker {
  private readonly cores = new Map<string, HoldCore>()

  observe(
    key: string,
    spec: HoldSpec,
    input: { readonly holds: boolean; readonly value: unknown },
    now: number,
  ): HoldReading {
    let core = this.cores.get(key)
    if (core === undefined) {
      core = new HoldCore(spec)
      this.cores.set(key, core)
    }
    return core.observe(input.holds, input.value, now)
  }
}

// ── the device-becomes event leaf ─────────────────────────────────────────

export interface BecomesSpec {
  readonly becomes?: string | number | boolean
  readonly operator?: BecomesOperator
  readonly value?: unknown
  readonly hold?: HoldSpec
}

export type BecomesRead = { readonly ok: true; readonly value: unknown } | { readonly ok: false }

/** What a `device-becomes` trigger hands the run. */
export interface BecomesVars {
  readonly deviceId: number
  /** The value before the change, `null` when it was not a scalar or not seen. */
  readonly from: string | number | boolean | null
  readonly to: string | number | boolean | null
}

export type BecomesEffect =
  | {
      readonly kind: 'fire'
      readonly value: unknown
      /** What the field held before it last changed; `undefined` when no change was seen. */
      readonly from: unknown
      readonly hold?: HoldTrace
    }
  | { readonly kind: 'hold'; readonly hold: HoldTrace; readonly value: unknown }

export type TimerHandle = ReturnType<typeof setTimeout>

export interface BecomesTimers {
  readonly set: (fn: () => void, ms: number) => TimerHandle
  readonly clear: (handle: TimerHandle) => void
  readonly now: () => number
}

export interface BecomesDeps {
  readonly timers: BecomesTimers
  /** A fresh read of the leaf's field, taken when a hold's deadline is due. */
  readonly read: () => Promise<BecomesRead>
  readonly emit: (effect: BecomesEffect) => void
}

/** Is the leaf's predicate true for `value`? `undefined` for "any change" (no predicate). */
function predicateOf(spec: BecomesSpec, value: unknown): boolean | undefined {
  if (spec.becomes !== undefined) return value === spec.becomes
  if (spec.operator !== undefined) return compareValues(value, spec.operator, spec.value)
  return undefined
}

/**
 * The runtime of a `device-becomes` leaf. It fires on a TRANSITION and never on a
 * re-report; with a hold it arms a timer for the deadline and fires once per
 * episode.
 */
export class BecomesWatch {
  private previous: unknown = undefined
  /** The value the field left at its last change — a re-report does not move it. */
  private from: unknown = undefined
  private seeded = false
  private readonly core: HoldCore | undefined
  private handle: TimerHandle | undefined = undefined
  private consumed = false
  private disposed = false

  constructor(
    private readonly spec: BecomesSpec,
    private readonly deps: BecomesDeps,
  ) {
    // "Any change" with a hold means "changed, then stayed": a stable hold.
    const hold = spec.hold
    this.core =
      hold === undefined
        ? undefined
        : new HoldCore(
            predicateOf(spec, undefined) === undefined ? { ...hold, mode: 'stable' } : hold,
          )
  }

  dispose(): void {
    this.disposed = true
    this.disarm()
  }

  private disarm(): void {
    if (this.handle !== undefined) this.deps.timers.clear(this.handle)
    this.handle = undefined
  }

  private trace(phase: HoldTrace['phase'], reading: Omit<HoldReading, 'transition'>): HoldTrace {
    const hold = this.spec.hold
    const ms = hold?.ms ?? 0
    const mode = this.core === undefined || hold === undefined ? 'held' : hold.mode
    const base = { phase, ms, mode } as const
    if (reading.since === null) return base
    return {
      ...base,
      since: reading.since,
      ...(phase === 'pending' ? { deadline: reading.since + ms } : {}),
    }
  }

  /** A KNOWN value. A failed read is not one: do not call this with it. */
  observe(value: unknown): void {
    if (this.disposed) return
    const now = this.deps.timers.now()
    const previous = this.previous
    const first = !this.seeded
    this.seeded = true
    if (!first && value !== previous) this.from = previous
    this.previous = value
    const holds = predicateOf(this.spec, value)
    if (this.core === undefined) {
      if (first) return
      const fires =
        holds === undefined
          ? value !== previous
          : holds && predicateOf(this.spec, previous) !== true
      if (fires) this.deps.emit({ kind: 'fire', value, from: this.from })
      return
    }
    const reading = this.core.observe(holds ?? true, value, now)
    if (reading.transition === 'cancelled' || reading.phase === 'idle') {
      if (reading.transition === 'cancelled' && this.handle !== undefined) {
        this.deps.emit({ kind: 'hold', value, hold: this.trace('cancelled', reading) })
      }
      this.disarm()
    }
    if (reading.phase === 'inherited') {
      this.consumed = true
      if (reading.transition === 'started') {
        this.deps.emit({ kind: 'hold', value, hold: this.trace('reseeded', reading) })
      }
      return
    }
    if (reading.transition !== 'none' && reading.phase === 'pending') {
      this.consumed = false
      this.disarm()
      this.handle = this.deps.timers.set(() => {
        void this.due()
      }, reading.remainingMs)
      this.deps.emit({ kind: 'hold', value, hold: this.trace('pending', reading) })
    }
  }

  /** The deadline: re-read the field (a missed event must not fire a broken hold), then fire once. */
  private async due(): Promise<void> {
    this.handle = undefined
    if (this.disposed || this.core === undefined) return
    const read = await this.deps.read()
    if (this.disposed) return
    if (read.ok) this.observe(read.value)
    // the fresh value restarted the hold (it moved): observe() armed a new deadline
    if (this.handle !== undefined || this.disposed) return
    const now = this.deps.timers.now()
    const reading = this.core.read(now)
    if (reading.phase === 'pending') {
      // the clock came up short of the window: arm again for the rest
      this.handle = this.deps.timers.set(() => {
        void this.due()
      }, reading.remainingMs)
      return
    }
    if (reading.phase !== 'met' || this.consumed) return
    this.consumed = true
    this.deps.emit({
      kind: 'fire',
      value: this.previous,
      from: this.from,
      hold: this.trace('fired', reading),
    })
  }
}

/** One line for a trace or a log: what a hold did. */
export function describeHold(hold: HoldTrace): string {
  const window = `${hold.mode === 'stable' ? 'stable' : 'held'} for ${describeHoldMs(hold.ms)}`
  switch (hold.phase) {
    case 'pending':
      return `hold pending: ${window}${hold.deadline === undefined ? '' : `, due ${new Date(hold.deadline).toISOString()}`}`
    case 'cancelled':
      return `hold cancelled: ${window} was broken before it completed`
    case 'fired':
      return `hold fired: ${window} completed`
    case 'reseeded':
      return `hold re-seeded: ${window} was already running when watching began, so it will not fire for this episode`
  }
}
