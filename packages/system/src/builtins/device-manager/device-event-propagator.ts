import type { IEventBus, EventSource, SystemEvent } from '@camstack/types'

/**
 * Walks the parent chain for every device-sourced event and re-emits a
 * copy on each ancestor scope with `via[]` populated.
 *
 * Design goals:
 *   - Transparent: drivers emit once on their own device scope; the
 *     framework handles fan-out. Zero provider boilerplate.
 *   - Anti-loop: events that already carry `via[]` are skipped (we only
 *     propagate ORIGINAL emissions).
 *   - Anti-cycle: the parent chain is bounded — if the device registry
 *     is corrupt and has a cycle, the walker caps at `MAX_CHAIN_DEPTH`
 *     and logs a warning.
 *   - Lazy: parent chain is resolved on-demand per event (no cached
 *     topology). The lookup is O(depth) which is ≤2 in practice.
 *
 * `via` contract (from SystemEvent.via JSDoc):
 *   - `via[0]` is the originating source (the device that produced the
 *     event). Subsequent entries walk up the parent chain.
 *   - On the re-emission, `source` is the ancestor at that level and
 *     `via[0..i]` is the prefix of the chain up to and including the
 *     first N ancestors below the current one.
 *
 * Example (grandchild → parent → grandparent):
 *   Original:  { source: {id: 7}, data: {...}, via: undefined }
 *   Re-emit 1: { source: {id: 4}, data: {...}, via: [{id: 7}] }
 *   Re-emit 2: { source: {id: 1}, data: {...}, via: [{id: 7}, {id: 4}] }
 *
 * A consumer listening at `source.id === 1` receives re-emit 2 (with
 * `via` showing the chain). A consumer listening at `source.id === 7`
 * with `via === undefined` receives the original only.
 */

/** Bounded walk — paranoia against corrupt device registries with cycles. */
const MAX_CHAIN_DEPTH = 16

export interface DeviceEventPropagatorOptions {
  readonly eventBus: IEventBus
  /**
   * Resolve the numeric parent id of a device, or `null` when the
   * device has no parent (or was deleted). The propagator injects a
   * closure over the hub's `DeviceRegistry` so the lookup is in-
   * process and O(1) per call.
   */
  readonly getParentOf: (deviceId: number) => number | null
  /** Structured logger for anti-cycle + anti-loop diagnostics. */
  readonly logger: {
    warn: (msg: string, meta?: Record<string, unknown>) => void
    debug: (msg: string, meta?: Record<string, unknown>) => void
  }
}

export class DeviceEventPropagator {
  private unsubscribe: (() => void) | null = null

  constructor(private readonly opts: DeviceEventPropagatorOptions) {}

  start(): void {
    if (this.unsubscribe) return
    // Subscribe to ALL events — the filter is applied inline per event
    // so we can short-circuit non-device sources without walking the
    // event bus's glob engine every time.
    const unsub = this.opts.eventBus.subscribe({}, (ev) => this.handle(ev))
    this.unsubscribe = unsub
  }

  stop(): void {
    if (!this.unsubscribe) return
    this.unsubscribe()
    this.unsubscribe = null
  }

  /** Exposed for tests — lets them inject events without the full bus. */
  handle(ev: SystemEvent): void {
    if (ev.via !== undefined) return // skip propagated
    if (ev.source.type !== 'device') return // skip non-device scopes
    const rawId = ev.source.id
    const deviceId = typeof rawId === 'number' ? rawId : Number(rawId)
    if (!Number.isFinite(deviceId)) return

    const chain = this.resolveParentChain(deviceId)
    if (chain.length === 0) return

    // Build `via[]` incrementally: for the first ancestor, via = [origin];
    // for the second, via = [origin, firstAncestor]; etc.
    const origin: EventSource = ev.source
    const via: EventSource[] = [origin]
    for (const ancestorId of chain) {
      const reEmission: SystemEvent = {
        ...ev,
        source: { type: 'device', id: ancestorId },
        via: [...via],
      }
      this.opts.eventBus.emit(reEmission)
      via.push({ type: 'device', id: ancestorId })
    }
  }

  private resolveParentChain(deviceId: number): readonly number[] {
    const chain: number[] = []
    const seen = new Set<number>([deviceId])
    let current = this.opts.getParentOf(deviceId)
    while (current != null) {
      if (seen.has(current)) {
        this.opts.logger.warn(
          'device-event-propagator: cycle detected in parent chain — aborting propagation',
          { tags: { deviceId }, meta: { cycleAt: current, chainSoFar: [...chain] } },
        )
        return chain
      }
      seen.add(current)
      chain.push(current)
      if (chain.length >= MAX_CHAIN_DEPTH) {
        this.opts.logger.warn('device-event-propagator: chain depth limit hit — truncating', {
          tags: { deviceId },
          meta: { depth: chain.length, max: MAX_CHAIN_DEPTH },
        })
        break
      }
      current = this.opts.getParentOf(current)
    }
    return chain
  }
}
