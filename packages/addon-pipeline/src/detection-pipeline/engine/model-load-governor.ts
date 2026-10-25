/**
 * What the dispatch path may ask of a pool's model loads, and what it must say
 * when it may not (D653, fix round 1).
 *
 * Three pieces of state, consulted ON DEMAND by the dispatch that needs a
 * model — there is no timer anywhere in here:
 *
 *  1. A NEGATIVE CACHE per (pool, model). `needsPoolUpdate` stays true after a
 *     failed load, so without it every frame of every camera re-issued the
 *     failing load and wrote two ERRORs. After a failure the model is not
 *     re-issued on that pool for an interval that doubles per consecutive
 *     failure up to a cap; a success clears it.
 *  2. COMPILE TIMEOUTS per (device, model). A load that outlived its soft
 *     bound is not a crash of the device. The SAME model timing out
 *     {@link COMPILE_TIMEOUTS_BEFORE_REFUSAL} times on one device — which,
 *     since a slow compile now runs on and writes its cache, only a compile
 *     that never finishes can do — refuses THAT MODEL there, by name. The
 *     device keeps serving every other model.
 *  3. Which camera has already been TOLD about the current state of a model,
 *     so each camera gets one line per state change, never one per frame.
 */

/** The first back-off after a failed load. */
export const MODEL_LOAD_BACKOFF_INITIAL_MS = 5_000
/** The back-off doubles per consecutive failure up to this. */
export const MODEL_LOAD_BACKOFF_MAX_MS = 5 * 60_000
/** Timeouts of ONE model on ONE device, inside the window, before it is refused there. */
export const COMPILE_TIMEOUTS_BEFORE_REFUSAL = 2
/** Timeouts older than this no longer count toward a refusal. */
export const COMPILE_TIMEOUT_WINDOW_MS = 60 * 60_000

/** Why a dispatch may not load a model right now. */
export type ModelLoadVerdict =
  | { readonly kind: 'go' }
  | {
      readonly kind: 'backoff'
      readonly model: string
      readonly retryInMs: number
      readonly failures: number
      readonly error: string
      readonly generation: number
    }
  | {
      readonly kind: 'refused'
      readonly model: string
      readonly timeouts: number
      readonly error: string
    }

/** What recording one failed load decided. */
export interface ModelLoadFailureOutcome {
  readonly generation: number
  readonly retryInMs: number
  /** The model became refused on this device with THIS failure. */
  readonly refusedNow: boolean
  readonly compileTimeouts: number
}

interface BackoffEntry {
  readonly failures: number
  readonly retryAtMs: number
  readonly error: string
  readonly generation: number
  /** The model's file stem as the POOL names it — how a worker event finds it. */
  readonly poolModel: string | null
  /** The pool's failure class (`compile-timeout`, `worker-poisoned`, …), or `null`. */
  readonly reason: string | null
}

interface TimeoutEntry {
  readonly at: readonly number[]
  readonly refused: boolean
  readonly lastError: string
}

/** One model refused on one device, for the health readout and re-arm. */
export interface RefusedModel {
  readonly deviceKey: string
  readonly model: string
  readonly timeouts: number
  readonly lastError: string
}

export class ModelLoadGovernor {
  /** Keyed by the pool OBJECT, so a respawned pool starts clean. */
  private readonly backoff = new WeakMap<object, Map<string, BackoffEntry>>()
  private readonly timeouts = new Map<string, TimeoutEntry>()
  private readonly reported = new Map<string, string>()
  private generation = 0

  /** May this dispatch load `models` on `pool` (a device `deviceKey`) now? */
  check(
    pool: object,
    deviceKey: string,
    models: readonly string[],
    now: number = Date.now(),
  ): ModelLoadVerdict {
    for (const model of models) {
      const t = this.timeouts.get(timeoutKey(deviceKey, model))
      if (t?.refused === true) {
        return { kind: 'refused', model, timeouts: t.at.length, error: t.lastError }
      }
    }
    const perPool = this.backoff.get(pool)
    if (perPool === undefined) return { kind: 'go' }
    for (const model of models) {
      const b = perPool.get(model)
      if (b !== undefined && now < b.retryAtMs) {
        return {
          kind: 'backoff',
          model,
          retryInMs: b.retryAtMs - now,
          failures: b.failures,
          error: b.error,
          generation: b.generation,
        }
      }
    }
    return { kind: 'go' }
  }

  /** One load of `model` on `pool` failed. */
  recordFailure(
    pool: object,
    deviceKey: string,
    model: string,
    error: string,
    compileTimeout: boolean,
    now: number = Date.now(),
    poolModel: string | null = null,
    reason: string | null = null,
  ): ModelLoadFailureOutcome {
    let perPool = this.backoff.get(pool)
    if (perPool === undefined) {
      perPool = new Map()
      this.backoff.set(pool, perPool)
    }
    const previousEntry = perPool.get(model)
    const failures = (previousEntry?.failures ?? 0) + 1
    const retryInMs = Math.min(
      MODEL_LOAD_BACKOFF_MAX_MS,
      MODEL_LOAD_BACKOFF_INITIAL_MS * 2 ** (failures - 1),
    )
    this.generation += 1
    const generation = this.generation
    perPool.set(model, {
      failures,
      retryAtMs: now + retryInMs,
      error,
      generation,
      poolModel: poolModel ?? previousEntry?.poolModel ?? null,
      reason,
    })

    if (!compileTimeout) return { generation, retryInMs, refusedNow: false, compileTimeouts: 0 }
    const key = timeoutKey(deviceKey, model)
    const previous = this.timeouts.get(key)
    const at = [...(previous?.at ?? []).filter((t) => t >= now - COMPILE_TIMEOUT_WINDOW_MS), now]
    const refused = at.length >= COMPILE_TIMEOUTS_BEFORE_REFUSAL
    this.timeouts.set(key, { at, refused, lastError: error })
    return {
      generation,
      retryInMs,
      refusedNow: refused && previous?.refused !== true,
      compileTimeouts: at.length,
    }
  }

  /**
   * A compile that outlived its bound came back on `pool` (D653 round 3).
   *
   * `ok`: THAT model's cache is written and the worker loads again, so its
   * back-off is lifted — and only its: another model's failure on the same
   * pool is not the compile that just finished. Not ok: it is one more
   * failure of that model, and its back-off grows. Refusals by name are never
   * lifted here; a model refused for timing out twice stays refused until the
   * operator re-arms. Returns the governor keys it touched.
   */
  settleLateCompile(
    pool: object,
    deviceKey: string,
    poolModel: string | null,
    ok: boolean,
    error: string,
    now: number = Date.now(),
  ): readonly string[] {
    const perPool = this.backoff.get(pool)
    if (perPool === undefined) return []
    // Loads REFUSED because this compile was running (`worker-poisoned`) were
    // never tried: the worker loads again now, whatever the compile's own
    // outcome, so their back-off is lifted with it.
    const refusedMeanwhile = [...perPool]
      .filter(([, b]) => b.reason === 'worker-poisoned' && b.poolModel !== poolModel)
      .map(([key]) => key)
    for (const key of refusedMeanwhile) perPool.delete(key)
    const own =
      poolModel === null
        ? []
        : [...perPool].filter(([, b]) => b.poolModel === poolModel).map(([key]) => key)
    for (const key of own) {
      if (ok) perPool.delete(key)
      else this.recordFailure(pool, deviceKey, key, error, false, now, poolModel)
    }
    return [...refusedMeanwhile, ...own]
  }

  /** `models` loaded on `pool`: forget their failures there. */
  recordSuccess(pool: object, deviceKey: string, models: readonly string[]): void {
    const perPool = this.backoff.get(pool)
    for (const model of models) {
      perPool?.delete(model)
      this.timeouts.delete(timeoutKey(deviceKey, model))
    }
  }

  /**
   * Has `camera` been told about this `state` of `model` on `deviceKey` yet?
   * Returns `true` exactly once per state change.
   */
  shouldReport(
    camera: number | undefined,
    deviceKey: string,
    model: string,
    state: string,
  ): boolean {
    const key = `${camera ?? '-'}|${deviceKey}|${model}`
    if (this.reported.get(key) === state) return false
    this.reported.set(key, state)
    return true
  }

  /** Every model refused on some device. */
  refused(): readonly RefusedModel[] {
    const out: RefusedModel[] = []
    for (const [key, t] of this.timeouts) {
      if (!t.refused) continue
      const [deviceKey = '', model = ''] = key.split('\u0000')
      out.push({ deviceKey, model, timeouts: t.at.length, lastError: t.lastError })
    }
    return out
  }

  /** Operator re-arm: forget the refusals on `deviceKey`. Returns how many. */
  rearm(deviceKey: string): number {
    let cleared = 0
    for (const key of [...this.timeouts.keys()]) {
      if (key.startsWith(`${deviceKey}\u0000`)) {
        this.timeouts.delete(key)
        cleared += 1
      }
    }
    return cleared
  }
}

function timeoutKey(deviceKey: string, model: string): string {
  return `${deviceKey}\u0000${model}`
}
