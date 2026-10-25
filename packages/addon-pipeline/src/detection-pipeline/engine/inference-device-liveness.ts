/**
 * Per-`deviceKey` circuit breaker for the Python inference pools.
 *
 * This is the accelerator-level twin of the kernel's `CrashSupervisor`
 * (`@camstack/system`, D6): a bounded restart budget with exponential backoff
 * and a **terminal `failed` state that is reported** — never an infinite
 * respawn loop. It is written here rather than imported because
 * `CrashSupervisor` is a kernel internal with no package export, and because
 * this breaker needs three things it does not have: a queryable terminal
 * roster (the health channel the orchestrator polls), a "when may I retry"
 * clock, and an operator re-arm.
 *
 * ## Why a budget is not optional
 *
 * On 2026-08-25 the hub's `openvino:gpu` worker was `SIGABRT`'d by glibc 1.3 s
 * after `Pool ready`, while compiling `yolov9m-320-int8` for the Intel GPU. The
 * crash is **deterministic** — every occurrence in 42 h of logs follows the
 * same model/device pair. A liveness gate that simply rebuilds a pool it finds
 * not-ready would therefore spawn a Python process **per frame, at 13 Hz**,
 * forever. The budget is what turns "self-healing" into "self-healing OR an
 * honest, reported death".
 *
 * ## The state machine
 *
 * Every death (a cached pool found dead, or an `initialize()` that threw) is
 * recorded against a sliding window. While the count inside the window stays
 * under `maxDeaths` the verdict is `rebuild`, gated by a backoff computed from
 * the streak. On the `maxDeaths`-th death the breaker **trips**: the device is
 * `failed`, no further pool is spawned for it, and it is published on the
 * health channel so the orchestrator stops routing cameras to it.
 *
 * Deaths age out of the window, so a pool that dies once a day never trips —
 * there is deliberately no "a spawn succeeded, reset the streak" call, because
 * this crash kills the worker 1.3 s AFTER a perfectly successful spawn. Any
 * success-based reset makes the budget unreachable.
 *
 * Leaving the terminal state is an explicit act: an operator re-arm
 * ({@link rearm}), or the runner process respawning (this state is in memory
 * and per-runner, by design — see the design note in the module that owns it).
 */

/** Outcome of recording one pool death for a device. */
export type DeviceLivenessDecision =
  /** Under budget — rebuild the pool, but not before `backoffMs` has passed. */
  | {
      readonly action: 'rebuild'
      readonly backoffMs: number
      readonly deathsInWindow: number
    }
  /** Budget exhausted — do NOT spawn again; the device is terminally failed. */
  | { readonly action: 'failed'; readonly deathsInWindow: number }

/** Why a device is not usable right now. */
export type InferenceDeviceUnhealthyState =
  /** The restart budget is exhausted. Terminal until re-armed. */
  | 'failed'
  /** Under budget, waiting out the backoff before the next rebuild. */
  | 'backoff'

/** One unusable device, as published on the health channel. */
export interface InferenceDeviceUnhealthy {
  readonly deviceKey: string
  readonly state: InferenceDeviceUnhealthyState
  /** Epoch ms of the death that put it in this state. */
  readonly since: number
  /** Deaths inside the current window. */
  readonly deaths: number
  /** The last death's message — what the operator needs to act. */
  readonly lastError: string
}

/**
 * A dispatch refused because its inference device is not usable.
 *
 * Distinct from `PoolWorker[w0]: not initialized`, which said the same thing
 * for three different states and so distinguished none of them. This one names
 * the device, the state and the underlying death, so a single rejected frame
 * is decidable without correlating logs.
 */
export class InferenceDeviceUnusableError extends Error {
  readonly deviceKey: string
  readonly state: InferenceDeviceUnhealthyState

  constructor(unhealthy: InferenceDeviceUnhealthy) {
    super(
      `inference device "${unhealthy.deviceKey}" is ${unhealthy.state} after ${unhealthy.deaths} pool death(s): ${unhealthy.lastError}`,
    )
    this.name = 'InferenceDeviceUnusableError'
    this.deviceKey = unhealthy.deviceKey
    this.state = unhealthy.state
  }
}

/** Tunables. Mirrors `CrashSupervisorOptions`. */
export interface InferenceDeviceLivenessOptions {
  /** Deaths older than this age out of the count. */
  readonly windowMs: number
  /** Deaths within the window before the breaker trips to `failed`. */
  readonly maxDeaths: number
  /** Backoff cap — the exponential backoff never exceeds this. */
  readonly maxBackoffMs: number
}

/**
 * Defaults. Three deaths inside ten minutes trips the breaker, so a
 * deterministic crash costs **three** Python spawns instead of one per frame,
 * and a flaky-once-an-hour pool still self-heals forever.
 */
export const DEFAULT_INFERENCE_DEVICE_LIVENESS: InferenceDeviceLivenessOptions = {
  windowMs: 10 * 60 * 1000,
  maxDeaths: 3,
  maxBackoffMs: 30_000,
}

interface DeviceState {
  /** Death timestamps (ms epoch), pruned to the active window. */
  readonly deaths: readonly number[]
  readonly failed: boolean
  /** Epoch ms before which no rebuild may be attempted. */
  readonly retryAtMs: number
  readonly lastError: string
  /** Epoch ms of the death that produced the current state. */
  readonly since: number
}

export class InferenceDeviceLivenessSupervisor {
  private readonly state = new Map<string, DeviceState>()

  constructor(
    private readonly opts: InferenceDeviceLivenessOptions = DEFAULT_INFERENCE_DEVICE_LIVENESS,
  ) {}

  /**
   * Record one pool death for `deviceKey` and decide what happens next.
   * `now` is injectable for deterministic tests. Never throws.
   */
  recordDeath(deviceKey: string, error: string, now: number = Date.now()): DeviceLivenessDecision {
    const cutoff = now - this.opts.windowMs
    const previous = this.state.get(deviceKey)
    const recent = [...(previous?.deaths ?? []).filter((t) => t >= cutoff), now]

    if (recent.length >= this.opts.maxDeaths) {
      this.state.set(deviceKey, {
        deaths: recent,
        failed: true,
        retryAtMs: Number.POSITIVE_INFINITY,
        lastError: error,
        since: now,
      })
      return { action: 'failed', deathsInWindow: recent.length }
    }

    const backoffMs = Math.min(
      this.opts.maxBackoffMs,
      500 * 2 ** Math.min(6, Math.max(0, recent.length - 1)),
    )
    this.state.set(deviceKey, {
      deaths: recent,
      failed: false,
      retryAtMs: now + backoffMs,
      lastError: error,
      since: now,
    })
    return { action: 'rebuild', backoffMs, deathsInWindow: recent.length }
  }

  /** Has the breaker tripped for this device? */
  isFailed(deviceKey: string): boolean {
    return this.state.get(deviceKey)?.failed ?? false
  }

  /**
   * Why this device cannot be used right now, or `null` when it may be
   * (re)built. A device inside its backoff answers `'backoff'`; a device whose
   * budget is spent answers `'failed'` forever.
   */
  unusableReason(deviceKey: string, now: number = Date.now()): InferenceDeviceUnhealthy | null {
    const s = this.state.get(deviceKey)
    if (!s) return null
    if (s.failed) {
      return {
        deviceKey,
        state: 'failed',
        since: s.since,
        deaths: s.deaths.length,
        lastError: s.lastError,
      }
    }
    if (now < s.retryAtMs) {
      return {
        deviceKey,
        state: 'backoff',
        since: s.since,
        deaths: s.deaths.length,
        lastError: s.lastError,
      }
    }
    return null
  }

  /**
   * Every device the breaker currently refuses, sorted by key.
   *
   * This is what the health channel publishes. `'backoff'` entries are
   * included deliberately: a device mid-backoff cannot serve a frame either,
   * and the reader's own arm/apply reluctance (D49) is what keeps a single
   * transient observation from excluding it.
   */
  unhealthy(now: number = Date.now()): readonly InferenceDeviceUnhealthy[] {
    const out: InferenceDeviceUnhealthy[] = []
    for (const deviceKey of [...this.state.keys()].toSorted()) {
      const reason = this.unusableReason(deviceKey, now)
      if (reason) out.push(reason)
    }
    return out
  }

  /**
   * Operator re-arm: forget everything about `deviceKey` so the next dispatch
   * builds a fresh pool with a full budget. Returns whether there was anything
   * to forget — a terminal state nobody can clear is a silent fault, and this
   * is the clearing.
   */
  rearm(deviceKey: string): boolean {
    return this.state.delete(deviceKey)
  }

  /** Forget every device (shutdown / full engine re-spin). */
  reset(): void {
    this.state.clear()
  }
}
