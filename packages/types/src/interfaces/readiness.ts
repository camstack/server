/**
 * Consumer-facing interface for the kernel-owned readiness registry.
 *
 * Implemented by `ReadinessRegistry` under
 * `@camstack/types/readiness/readiness-registry.ts`. Exposed here as a
 * narrow interface so `AddonContext.kernel.readinessRegistry` can be
 * typed without pulling the full registry module into the addon
 * interface file (avoids import cycles).
 *
 * Addons emit via the standalone `emitReadiness(bus, ...)` helper —
 * they don't need a registry handle for that. The registry is
 * purely a consumer primitive: `awaitReady` for one-shot waits and
 * `onReadyState` for long-lived observers.
 */
import type { ReadinessScope, ReadinessState } from './event-bus.js'

export interface IReadinessTransition {
  readonly capName: string
  readonly scope: ReadinessScope
  readonly state: ReadinessState
  readonly epoch: number
  readonly generation: string
  readonly sourceNodeId: string
  readonly ts: number
  readonly durationInPrevState: number
}

export interface IReadinessRegistryRecord {
  readonly capName: string
  readonly scope: ReadinessScope
  readonly state: ReadinessState
  readonly generation: string
  readonly epoch: number
  readonly lastChange: number
  /**
   * Node that emitted the latest transition. Needed for `agent.offline`
   * demux of `device`-scoped caps. For `node`-scoped caps this matches
   * `scope.nodeId`.
   */
  readonly sourceNodeId: string
}

export interface IAwaitReadyOptions {
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

export type IReadinessHandler = (transition: IReadinessTransition) => void

export interface IReadinessRegistry<TCapName extends string = string> {
  /** Current snapshot for a `(capName, scope)` pair, or `null` if never seen. */
  get(capName: TCapName, scope: ReadinessScope): IReadinessRegistryRecord | null

  /**
   * One-shot: resolves when the cap is `ready`. Reads the snapshot
   * first — if already ready, resolves on next tick. Rejects with
   * `ReadinessTimeoutError` after `timeoutMs` (default 30_000) or
   * with the AbortSignal's reason on cancel.
   */
  awaitReady(capName: TCapName, scope: ReadinessScope, opts?: IAwaitReadyOptions): Promise<void>

  /**
   * Observable: every transition (starting/ready/down) dispatches to
   * `handler`. On subscribe the current state (if known) replays
   * asynchronously as the initial transition. Returns unsubscribe.
   */
  onReadyState(capName: TCapName, scope: ReadinessScope, handler: IReadinessHandler): () => void

  /**
   * Hydrate the snapshot from an authoritative source (typically the
   * hub's `$readiness.getSnapshot` action) — a RECONCILE, not an
   * add-only merge. Unseen keys are added; already-seen keys are
   * ADVANCED when the authoritative record carries a new generation or
   * a forward same-generation state move (starting → ready → down).
   * Same-generation regressions and records this process is itself
   * authoritative for are skipped. For each applied entry a one-shot
   * transition is dispatched to matching subscriptions so pending
   * `awaitReady` callers unblock without waiting for a fresh delta.
   *
   * Returns the number of records applied (added or advanced) — `0`
   * means the snapshot matched local state and callers doing periodic
   * reconciles should stay silent about it.
   */
  hydrate(records: readonly IReadinessRegistryRecord[]): number

  /**
   * Serializable snapshot for cross-process transport. Returned as an
   * array (MsgPack-friendly) rather than the internal Map.
   */
  getSnapshotForTransport(): readonly IReadinessRegistryRecord[]
}

/**
 * A stable, cached reference to a capability that tracks readiness state.
 * Obtained via `ctx.useCapability()` or `ctx.acquireCapability()`.
 *
 * The generic `T` is a phantom type documenting the expected provider interface.
 */
export interface ICapabilityHandle<T = unknown> {
  readonly capName: string
  readonly scope: ReadinessScope
  readonly isReady: boolean

  /**
   * Block until the capability is ready, or throw `CapabilityUnavailableError`
   * on timeout.
   */
  awaitReady(timeoutMs?: number): Promise<void>

  /**
   * Execute `fn` with readiness gating. Blocks until ready, then calls `fn`.
   * Preferred over `awaitReady() + fn()` because it re-gates after a
   * down→ready cycle that may occur between the await and the call.
   */
  call<R>(fn: () => Promise<R>, timeoutMs?: number): Promise<R>

  /** Unsubscribe from ReadinessRegistry. Called by AddonContextImpl on shutdown. */
  dispose(): void

  // Phantom brand — never assigned, only used to carry T in the type system.
  readonly _provider: T
}
