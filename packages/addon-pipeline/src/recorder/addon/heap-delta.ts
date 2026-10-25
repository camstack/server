/**
 * Name the unit of work that grows the recorder's heap.
 *
 * Every recorder lifetime has the same shape (findings 2026-09-28): ~50 MB for
 * five minutes, then one SILENT, CPU-bound phase of 4.5–7 minutes that builds
 * ~2.3 GB — ~910 MB of it in `large_object_space` — and holds it. The
 * large-object floor doubled at one boot (2026-09-03 06:56Z, 458 → 914 MB),
 * the first to show a second recording location. Nothing logs during the
 * phase, so nothing says which pass or which inbound call builds it, and a
 * heap snapshot is not allowed on this host.
 *
 * So every periodic pass, every boot phase and every inbound cap method is
 * wrapped here: two cheap heap reads (`v8.getHeapStatistics` and
 * `v8.getHeapSpaceStatistics` — a handful of counters, no heap walk), and ONE
 * line when the unit grew the heap or the large-object space by at least
 * `deltaBytes`, or ran for at least `durationMs`. Silent otherwise.
 *
 * Two things this line is NOT, and a reader must not take it for:
 *
 * - **Not exclusive.** The delta is over the unit's WALL window, so concurrent
 *   work that interleaves with it is counted too. `inFlight` on the line is the
 *   MOST other measured units that were open at any moment DURING this one —
 *   a long pass that started alone and was overlapped by forty cap calls
 *   reports 40, not 0. `inFlight: 0` is the only reading that pins the delta
 *   on this unit (unmeasured work — a transport decode, a timer — can still
 *   interleave).
 * - **Not retention.** `heapUsed` includes garbage no GC has collected yet, so
 *   a unit that ALLOCATES 50 MB of transient reads is named even though it
 *   keeps none of it. A unit named on several passes in a row while the heap
 *   floor rises is a builder; one named once is only a candidate.
 */
import v8 from 'node:v8'
import type { IScopedLogger } from '@camstack/types'

const MIB = 1024 * 1024

/** Heap counters at one instant. */
export interface HeapSample {
  readonly heapUsedBytes: number
  /** `null` when V8 did not report the space — never folded into 0. */
  readonly largeObjectBytes: number | null
}

export type HeapSampler = () => HeapSample | null

export interface HeapDeltaThresholds {
  /** Growth of heapUsed OR large-object space that is worth one line. */
  readonly deltaBytes: number
  /** A unit this slow is worth one line whatever it did to the heap. */
  readonly durationMs: number
}

export const DEFAULT_HEAP_DELTA_THRESHOLDS: HeapDeltaThresholds = {
  deltaBytes: 50 * MIB,
  durationMs: 5_000,
}

export type HeapDeltaReason = 'heap' | 'large-object-space' | 'duration'

export interface HeapDeltaVerdict {
  readonly reasons: readonly HeapDeltaReason[]
  /** `null` when either sample failed — a failed read is not "no change". */
  readonly heapDeltaBytes: number | null
  readonly largeObjectDeltaBytes: number | null
}

/**
 * Whether one unit of work is worth a line. GROWTH only: a unit that happened
 * to straddle a major GC shows a large negative delta that says nothing about
 * what it retained, and the question being asked is who BUILDS the heap.
 */
export function judgeHeapDelta(
  before: HeapSample | null,
  after: HeapSample | null,
  durationMs: number,
  thresholds: HeapDeltaThresholds,
): HeapDeltaVerdict {
  const heapDeltaBytes =
    before !== null && after !== null ? after.heapUsedBytes - before.heapUsedBytes : null
  const losBefore = before?.largeObjectBytes ?? null
  const losAfter = after?.largeObjectBytes ?? null
  const largeObjectDeltaBytes =
    losBefore !== null && losAfter !== null ? losAfter - losBefore : null
  const reasons: HeapDeltaReason[] = []
  if (heapDeltaBytes !== null && heapDeltaBytes >= thresholds.deltaBytes) reasons.push('heap')
  if (largeObjectDeltaBytes !== null && largeObjectDeltaBytes >= thresholds.deltaBytes) {
    reasons.push('large-object-space')
  }
  if (durationMs >= thresholds.durationMs) reasons.push('duration')
  return { reasons, heapDeltaBytes, largeObjectDeltaBytes }
}

/** V8's own counters. `null` if V8 refuses — the caller logs nulls, not zeros. */
export function readV8HeapSample(): HeapSample | null {
  try {
    const heapUsedBytes = v8.getHeapStatistics().used_heap_size
    const los = v8
      .getHeapSpaceStatistics()
      .find((space) => space.space_name === 'large_object_space')
    return { heapUsedBytes, largeObjectBytes: los === undefined ? null : los.space_used_size }
  } catch {
    return null
  }
}

/** What kind of unit a line is about — so passes and inbound calls sort apart. */
export type WorkUnitKind = 'pass' | 'boot-phase' | 'cap-method'

export interface WorkUnit {
  readonly kind: WorkUnitKind
  readonly name: string
}

/** The one method the passes and the provider wrapper need. */
export interface HeapDeltaTracker {
  track<T>(unit: WorkUnit, run: () => Promise<T>): Promise<T>
}

export interface HeapDeltaProbeDeps {
  readonly logger: Pick<IScopedLogger, 'info'>
  readonly sampler?: HeapSampler
  readonly now?: () => number
  readonly thresholds?: HeapDeltaThresholds
}

function mb(bytes: number | null): number | null {
  return bytes === null ? null : Math.round(bytes / MIB)
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  )
}

/** A measured unit between its start and its end. */
interface OpenUnit {
  readonly id: number
  readonly sample: HeapSample | null
  readonly at: number
}

/** One provider method and the measured stand-in handed out for it. */
interface WrappedMethod {
  readonly original: unknown
  readonly wrapped: unknown
}

export class HeapDeltaProbe implements HeapDeltaTracker {
  /** Open units → the most OTHER units seen open at once while it ran. */
  private readonly peers = new Map<number, number>()
  private seq = 0
  private readonly sampler: HeapSampler
  private readonly now: () => number
  private readonly thresholds: HeapDeltaThresholds

  constructor(private readonly deps: HeapDeltaProbeDeps) {
    this.sampler = deps.sampler ?? readV8HeapSample
    this.now = deps.now ?? ((): number => Date.now())
    this.thresholds = deps.thresholds ?? DEFAULT_HEAP_DELTA_THRESHOLDS
  }

  async track<T>(unit: WorkUnit, run: () => Promise<T>): Promise<T> {
    const open = this.begin()
    let failed = false
    try {
      return await run()
    } catch (err: unknown) {
      failed = true
      throw err
    } finally {
      this.end(unit, open, failed)
    }
  }

  /**
   * The same provider, with every method measured. A `Proxy` rather than a
   * rebuilt object so the capability's own type passes through untouched —
   * no method is re-declared, and none can be forgotten when the cap grows
   * one. `this` stays the original object, so a class with private state
   * keeps working.
   */
  wrapProvider<P extends object>(capability: string, provider: P): P {
    // One wrapper per method, re-made only if the property is reassigned, so a
    // caller that compares method identity across two reads still sees one.
    const cache = new Map<string, WrappedMethod>()
    return new Proxy(provider, {
      get: (target, prop) => {
        // `target` as the receiver, not the proxy: a getter that reads a
        // `#private` field would throw when handed the proxy.
        const value: unknown = Reflect.get(target, prop, target)
        // `constructor`, `toString` and the rest of Object's own surface are
        // not cap methods; a wrapped `constructor` would lie about its name.
        if (typeof value !== 'function' || typeof prop === 'symbol' || prop in Object.prototype) {
          return value
        }
        const cached = cache.get(prop)
        if (cached !== undefined && cached.original === value) return cached.wrapped
        const unit: WorkUnit = { kind: 'cap-method', name: `${capability}.${prop}` }
        const wrapped = (...args: unknown[]): unknown =>
          this.call(unit, () => Reflect.apply(value, target, args))
        cache.set(prop, { original: value, wrapped })
        return wrapped
      },
    })
  }

  private call(unit: WorkUnit, invoke: () => unknown): unknown {
    const open = this.begin()
    let result: unknown
    try {
      result = invoke()
    } catch (err: unknown) {
      this.end(unit, open, true)
      throw err
    }
    if (!isPromiseLike(result)) {
      this.end(unit, open, false)
      return result
    }
    return Promise.resolve(result).then(
      (value) => {
        this.end(unit, open, false)
        return value
      },
      (err: unknown) => {
        this.end(unit, open, true)
        throw err
      },
    )
  }

  private begin(): OpenUnit {
    const id = ++this.seq
    const others = this.peers.size
    // Every unit already open now has one more peer than before.
    for (const [peer, most] of this.peers) this.peers.set(peer, Math.max(most, others))
    this.peers.set(id, others)
    return { id, sample: this.sampler(), at: this.now() }
  }

  private end(unit: WorkUnit, open: OpenUnit, failed: boolean): void {
    const inFlight = this.peers.get(open.id) ?? 0
    this.peers.delete(open.id)
    const durationMs = this.now() - open.at
    const after = this.sampler()
    const verdict = judgeHeapDelta(open.sample, after, durationMs, this.thresholds)
    if (verdict.reasons.length === 0) return
    this.deps.logger.info('recorder: unit of work moved the heap', {
      meta: {
        kind: unit.kind,
        name: unit.name,
        reasons: verdict.reasons,
        durationMs,
        heapBeforeMb: mb(open.sample?.heapUsedBytes ?? null),
        heapAfterMb: mb(after?.heapUsedBytes ?? null),
        heapDeltaMb: mb(verdict.heapDeltaBytes),
        losBeforeMb: mb(open.sample?.largeObjectBytes ?? null),
        losAfterMb: mb(after?.largeObjectBytes ?? null),
        losDeltaMb: mb(verdict.largeObjectDeltaBytes),
        // The most other measured units open at once DURING this one: the
        // delta is over the wall window, and anything overlapping is in it.
        inFlight,
        failed,
      },
    })
  }
}
