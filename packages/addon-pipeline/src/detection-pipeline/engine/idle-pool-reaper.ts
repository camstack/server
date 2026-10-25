/**
 * Idle-pool reaper for the per-device inference pools (multi-device C3).
 *
 * `DetectionPipelineProvider.factoriesByDevice` holds one warm `EngineFactory`
 * per `deviceKey`. Without eviction these pools accumulate and live until
 * shutdown — unbounded Python subprocesses + model RAM as an operator toggles
 * device sets or many deviceKeys appear over a long run (audit C3). This reaper
 * gives each device pool the same warm/idle-TTL lifetime the override cache
 * already uses: every use `touch()`es the key (re-arming its timer); a pool with
 * no use for `ttlMs` is disposed via the injected `dispose` callback and
 * recreated on next use (the provider's single-flight guards the recreate).
 *
 * A pool with a CONTINUOUSLY dispatching session never idles out — each frame
 * runs the pipeline through its pool, which `touch()`es the key.
 *
 * That is NOT the same as "an active camera never idles out", which this
 * comment used to claim and which cost the fleet real detections: dispatch is
 * driven by MOTION, so a quiet camera stops touching its key entirely. With the
 * old 120s TTL the pool was evicted between events and the next motion paid a
 * full model reload before it could detect anything. The TTL now lives in
 * `DetectionPipelineProvider.DEVICE_POOL_IDLE_TTL_MS` and is measured in hours
 * for exactly this reason — see the evidence recorded there.
 *
 * Timer/clock are injectable so the eviction can be unit-tested with fake timers
 * without spawning a real pool.
 */
export interface IdlePoolReaperOptions {
  readonly ttlMs: number
  /** Dispose + remove the pool for `key`. Called when the key idles past TTL. */
  readonly dispose: (key: string) => Promise<void>
  readonly now?: () => number
  readonly setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
  readonly onError?: (key: string, err: unknown) => void
}

export class IdlePoolReaper {
  private readonly lastUsed = new Map<string, number>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly ttlMs: number
  private readonly disposeFn: (key: string) => Promise<void>
  private readonly now: () => number
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void
  private readonly onError?: (key: string, err: unknown) => void

  constructor(opts: IdlePoolReaperOptions) {
    this.ttlMs = opts.ttlMs
    this.disposeFn = opts.dispose
    this.now = opts.now ?? (() => Date.now())
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t))
    this.onError = opts.onError
  }

  /** Record a use of `key` and (re)arm its idle-eviction timer. */
  touch(key: string): void {
    this.lastUsed.set(key, this.now())
    this.arm(key)
  }

  /** Stop tracking `key` (the pool was disposed/removed elsewhere). */
  cancel(key: string): void {
    const timer = this.timers.get(key)
    if (timer) this.clearTimer(timer)
    this.timers.delete(key)
    this.lastUsed.delete(key)
  }

  /** Clear every timer (shutdown). Does not dispose pools — the caller does. */
  disposeAll(): void {
    for (const timer of this.timers.values()) this.clearTimer(timer)
    this.timers.clear()
    this.lastUsed.clear()
  }

  private arm(key: string): void {
    const existing = this.timers.get(key)
    if (existing) this.clearTimer(existing)
    this.timers.set(
      key,
      this.setTimer(() => {
        void this.reap(key)
      }, this.ttlMs),
    )
  }

  private async reap(key: string): Promise<void> {
    const last = this.lastUsed.get(key)
    if (last === undefined) return
    const idleMs = this.now() - last
    if (idleMs < this.ttlMs) {
      // Re-armed by a use that landed after this timer was scheduled — wait out
      // the remaining window instead of disposing an in-use pool.
      this.timers.set(
        key,
        this.setTimer(() => {
          void this.reap(key)
        }, this.ttlMs - idleMs),
      )
      return
    }
    this.timers.delete(key)
    this.lastUsed.delete(key)
    try {
      await this.disposeFn(key)
    } catch (err) {
      this.onError?.(key, err)
    }
  }
}
