import type { ReadinessRegistry, ReadinessScope, ICapabilityHandle } from '@camstack/types'

type CapState = 'pending' | 'ready' | 'down'

export class CapabilityUnavailableError extends Error {
  readonly capName: string
  readonly scope: ReadinessScope
  readonly timeoutMs: number

  constructor(capName: string, scope: ReadinessScope, timeoutMs: number) {
    super(`Capability '${capName}' unavailable after ${timeoutMs}ms`)
    this.name = 'CapabilityUnavailableError'
    this.capName = capName
    this.scope = scope
    this.timeoutMs = timeoutMs
  }
}

/**
 * A stable reference to a capability that tracks its readiness state and
 * gates calls on that state.
 *
 * Obtained via `ctx.useCapability()` (non-blocking) or `ctx.acquireCapability()`
 * (blocks until the cap is ready). The handle is cached per `(capName, scope)` in
 * AddonContextImpl so repeated calls return the same instance.
 *
 * The generic `T` is a phantom type documenting the expected provider interface;
 * the handle itself does not expose a typed proxy surface in v1.
 */
export class CapabilityHandle<T = unknown> implements ICapabilityHandle<T> {
  private state: CapState = 'pending'
  private readonly unsubscribeReadiness: () => void

  constructor(
    readonly capName: string,
    readonly scope: ReadinessScope,
    private readonly registry: ReadinessRegistry,
    readonly defaultTimeoutMs: number,
  ) {
    // Seed current state from registry snapshot so handles created after
    // the cap is already ready start in the 'ready' state, not 'pending'.
    const current = registry.get(capName, scope)
    if (current?.state === 'ready') this.state = 'ready'
    else if (current?.state === 'down') this.state = 'down'

    this.unsubscribeReadiness = registry.onReadyState(capName, scope, (t) => {
      this.state = t.state === 'ready' ? 'ready' : 'down'
    })
  }

  get isReady(): boolean {
    return this.state === 'ready'
  }

  /**
   * Block until the capability is ready, or throw `CapabilityUnavailableError`
   * if it does not become ready within `timeoutMs`.
   */
  async awaitReady(timeoutMs: number = this.defaultTimeoutMs): Promise<void> {
    if (this.state === 'ready') return
    try {
      await this.registry.awaitReady(this.capName, this.scope, { timeoutMs })
      this.state = 'ready'
    } catch {
      throw new CapabilityUnavailableError(this.capName, this.scope, timeoutMs)
    }
  }

  /**
   * Execute `fn` with readiness gating: if the cap is not ready, blocks
   * until it becomes ready (or throws CapabilityUnavailableError on timeout),
   * then calls `fn`.
   *
   * Preferred over calling awaitReady() + fn() separately because it
   * re-gates after a down→ready transition that happens between the
   * await and the call.
   */
  async call<R>(fn: () => Promise<R>, timeoutMs: number = this.defaultTimeoutMs): Promise<R> {
    await this.awaitReady(timeoutMs)
    return fn()
  }

  /** Unsubscribe from ReadinessRegistry. Called by AddonContextImpl on shutdown. */
  dispose(): void {
    this.unsubscribeReadiness()
  }

  // Phantom brand — never assigned, only used to carry T in the type system.
  declare readonly _provider: T
}
