// Pure state machine that drives a selected inference runtime through
// idle → installing → verifying → ready, retrying on failure with
// incremental backoff (capped at ~5 min, retrying indefinitely at cap).
//
// Self-contained: no @camstack/system import. No real timers/Date.now() —
// only via injected fx.now / fx.setTimer so the unit tests use a fake clock.
import type { RuntimeId } from './runtimes.js'

export type ModelFormat = 'onnx' | 'openvino' | 'coreml' | 'tflite'

export type ProvisioningPhase = 'idle' | 'installing' | 'verifying' | 'ready' | 'failed'

export interface EngineProvisioningState {
  readonly runtimeId: RuntimeId | null
  readonly device: string | null
  readonly state: ProvisioningPhase
  readonly progress?: number
  readonly error?: string
  readonly nextRetryAt?: number
  /**
   * Gate A (config-correctness gate at engine change): human-readable
   * config issues (model substitutions, zero-build steps) surfaced by the
   * provider's eager re-resolve on engine change. Additive/optional — this
   * state machine never sets it itself; the provider merges it into the
   * snapshot returned from `getEngineProvisioning()`. Mutable array to
   * mirror the `EngineProvisioning` cap wire type (`z.array(z.string())`
   * infers a mutable array) — this interface backs that snapshot directly.
   */
  readonly configIssues?: string[]
}

export interface ProvisionerEffects {
  readonly requirementsFor: (id: RuntimeId) => readonly string[]
  readonly modelFormatFor: (id: RuntimeId) => ModelFormat
  readonly installRequirements: (files: readonly string[]) => Promise<void>
  readonly ensureModelForFormat: (format: ModelFormat) => Promise<void>
  readonly verify: (backend: RuntimeId, device: string) => Promise<void>
  readonly now: () => number
  readonly setTimer: (ms: number, cb: () => void) => () => void
  readonly onChange: (state: EngineProvisioningState) => void
}

/** Incremental backoff growing to a ~5 min cap; retries indefinitely at cap. */
export const BACKOFF_SCHEDULE_MS: readonly number[] = [
  5_000, 15_000, 30_000, 60_000, 120_000, 300_000,
]

const IDLE_STATE: EngineProvisioningState = { runtimeId: null, device: null, state: 'idle' }

export class EngineProvisioner {
  private current: EngineProvisioningState = IDLE_STATE

  /** Bumped on every select/dispose — stale async results (old generation) are ignored. */
  private generation = 0

  private cancelTimer: (() => void) | null = null
  private retryIndex = 0

  constructor(private readonly fx: ProvisionerEffects) {}

  get state(): EngineProvisioningState {
    return this.current
  }

  isReady(): boolean {
    return this.current.state === 'ready'
  }

  select(runtimeId: RuntimeId, device: string): void {
    this.generation++
    this.retryIndex = 0
    this.clearTimer()
    this.transition({ runtimeId, device, state: 'installing', progress: 0 })
    void this.provision(this.generation, runtimeId, device)
  }

  dispose(): void {
    this.generation++
    this.clearTimer()
  }

  private clearTimer(): void {
    if (this.cancelTimer !== null) {
      this.cancelTimer()
      this.cancelTimer = null
    }
  }

  private transition(next: EngineProvisioningState): void {
    this.current = next
    this.fx.onChange(next)
  }

  private async provision(gen: number, runtimeId: RuntimeId, device: string): Promise<void> {
    try {
      await Promise.all([
        this.fx.installRequirements(this.fx.requirementsFor(runtimeId)),
        this.fx.ensureModelForFormat(this.fx.modelFormatFor(runtimeId)),
      ])
      if (gen !== this.generation) return
      this.transition({ runtimeId, device, state: 'verifying', progress: 100 })
      await this.fx.verify(runtimeId, device)
      if (gen !== this.generation) return
      this.retryIndex = 0
      this.transition({ runtimeId, device, state: 'ready' })
    } catch (err: unknown) {
      if (gen !== this.generation) return
      const message = err instanceof Error ? err.message : String(err)
      const delayIndex = Math.min(this.retryIndex, BACKOFF_SCHEDULE_MS.length - 1)
      const delay = BACKOFF_SCHEDULE_MS[delayIndex]!
      this.retryIndex++
      const nextRetryAt = this.fx.now() + delay
      this.transition({ runtimeId, device, state: 'failed', error: message, nextRetryAt })
      this.cancelTimer = this.fx.setTimer(delay, () => {
        if (gen !== this.generation) return
        this.cancelTimer = null
        this.transition({ runtimeId, device, state: 'installing', progress: 0 })
        void this.provision(gen, runtimeId, device)
      })
    }
  }
}
