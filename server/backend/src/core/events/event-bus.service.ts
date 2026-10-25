import { getBrokerEventBus } from '@camstack/system'
import type { EventFilter, IEventBus, SystemEvent } from '@camstack/types'
import type { ServiceBroker } from 'moleculer'
import { ConfigService } from '../config/config.service'

/**
 * Hub-side event bus. Pre-broker boot the service buffers nothing —
 * subscribers / emits are no-ops until `attachBroker` lands the
 * underlying per-broker shared bus. Once attached every operation
 * delegates to the unified `getBrokerEventBus(broker)` instance,
 * which is the SAME bus that group-runner / agent subprocess addons
 * see when they call `ctx.eventBus.emit`. Single in-process delivery
 * map per broker, single `broker.broadcast` for cross-broker
 * delivery — no more dual hub-vs-subprocess implementations.
 *
 * **Persistence scope**: the in-memory ring buffer (10 000 events,
 * owned by `getBrokerEventBus`) survives admin-ui browser refreshes
 * but NOT server restarts — that's intentional. UI panels read
 * `getRecent` on mount and live-subscribe via `live.onEvent` /
 * `systemEvents.subscribe`, which is enough for the operator to see
 * continuity across page reloads.
 */
export class EventBusService implements IEventBus {
  private broker: ServiceBroker | null = null
  private inner: IEventBus | null = null
  // Used only as a loose ring buffer for the very first events emitted
  // before `attachBroker` runs (NestJS-era boot legacy). Drained into
  // the real bus on attach.
  private pending: SystemEvent[] = []
  private deferredSubs: Array<{
    filter: EventFilter
    handler: (event: SystemEvent) => void
    unsub?: () => void
  }> = []

  constructor(_configService: ConfigService) {
    // The shared bus owns the ring-buffer size — hub-side config is
    // accepted for API compatibility but no longer drives the bus.
    void _configService
  }

  attachBroker(broker: ServiceBroker): void {
    if (this.broker === broker) return
    this.broker = broker
    // The hub main process is the ONLY process that serves `getRecent` — so it
    // is the only bus that opts into retaining the recent[] registry. Child
    // addon runners + remote agents leave `retainRecent` false: their events
    // are one-shot (fire-and-forget), fanned out to local subscribers but never
    // accumulated, so their heap can't grow an unbounded recent[] backlog.
    const inner = getBrokerEventBus(broker, { retainRecent: true })
    this.inner = inner
    // Replay deferred subscriptions onto the real bus.
    for (const sub of this.deferredSubs) {
      sub.unsub = inner.subscribe(sub.filter, sub.handler)
    }
    // Flush events emitted before the broker was ready.
    for (const evt of this.pending) {
      inner.emit(evt)
    }
    this.pending = []
  }

  detachBroker(): void {
    for (const sub of this.deferredSubs) {
      sub.unsub?.()
      sub.unsub = undefined
    }
    this.broker = null
    this.inner = null
  }

  emit(event: SystemEvent): void {
    if (!this.inner) {
      this.pending.push(event)
      return
    }
    this.inner.emit(event)
  }

  subscribe(filter: EventFilter, handler: (event: SystemEvent) => void): () => void {
    if (this.inner) return this.inner.subscribe(filter, handler)
    const sub = { filter, handler, unsub: undefined as (() => void) | undefined }
    this.deferredSubs.push(sub)
    return () => {
      if (sub.unsub) sub.unsub()
      const idx = this.deferredSubs.indexOf(sub)
      if (idx >= 0) this.deferredSubs.splice(idx, 1)
    }
  }

  getRecent(filter?: EventFilter, limit?: number): readonly SystemEvent[] {
    return this.inner?.getRecent(filter, limit) ?? []
  }
}
