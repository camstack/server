import {
  type DeviceBindingEntry,
  EventCategory,
  type IEventBus,
  type IScopedLogger,
} from '@camstack/types'

/** What the deriver needs from the device manager; every read may fail. */
export interface FeatureDeriverDeps {
  /** The device's bindings as `getBindings` answers (D12/D13). Rejects when the read failed. */
  readonly bindingsOf: (deviceId: number) => Promise<readonly DeviceBindingEntry[]>
  /** Every device's bindings; rejects when the read failed. */
  readonly allBindings: () => Promise<
    ReadonlyArray<{
      readonly deviceId: number
      readonly entries: readonly DeviceBindingEntry[]
    }>
  >
  /** Settle and persist; resolves `true` when the stored features moved. */
  readonly apply: (deviceId: number, entries: readonly DeviceBindingEntry[]) => Promise<boolean>
  readonly logger: IScopedLogger
}

/**
 * Keeps each device's persisted features equal to what its bindings imply (#459).
 *
 * Event-driven AND reconciled: `DeviceBindingsChanged` is telemetry and may be
 * dropped (D8/D49), so {@link reconcileAll} runs at boot and a missed event
 * costs only until the next one. There are no timers and no retries. A read
 * that fails changes nothing: the stored features stay as they were, because a
 * feature set derived from an empty answer would strip every feature of a
 * device the registry merely could not describe yet (D49). The same holds for
 * an answer that does not yet carry the device's own provider: wrapper entries
 * alone mean "unknown", never "absent" (D315, {@link nativeProviderReported}).
 *
 * Writes for one device run one after another and a burst collapses into the
 * run already waiting, so a worker registering twenty caps costs two settles.
 */
export class FeatureDeriver {
  private readonly tails = new Map<number, Promise<void>>()
  private readonly queued = new Set<number>()

  constructor(private readonly deps: FeatureDeriverDeps) {}

  /** A binding of `deviceId` changed (or may have): settle it after the settles already queued. */
  onBindingsChanged(deviceId: number): Promise<void> {
    if (this.queued.has(deviceId)) return this.tails.get(deviceId) ?? Promise.resolve()
    this.queued.add(deviceId)
    const previous = this.tails.get(deviceId) ?? Promise.resolve()
    const next = previous.then(async () => {
      this.queued.delete(deviceId)
      await this.settleOne(deviceId)
    })
    this.tails.set(deviceId, next)
    void next.finally(() => {
      if (this.tails.get(deviceId) === next) this.tails.delete(deviceId)
    })
    return next
  }

  /** Boot reconcile: settle every device from one fleet read. Returns how many moved. */
  async reconcileAll(): Promise<number> {
    let all: Awaited<ReturnType<FeatureDeriverDeps['allBindings']>>
    try {
      all = await this.deps.allBindings()
    } catch (err) {
      this.deps.logger.warn('feature reconcile skipped — the fleet bindings could not be read', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return 0
    }
    let moved = 0
    for (const { deviceId, entries } of all) {
      if (await this.applyOne(deviceId, entries)) moved += 1
    }
    this.deps.logger.info('feature reconcile done', {
      meta: { devices: all.length, moved },
    })
    return moved
  }

  private async settleOne(deviceId: number): Promise<void> {
    let entries: readonly DeviceBindingEntry[]
    try {
      entries = await this.deps.bindingsOf(deviceId)
    } catch (err) {
      this.deps.logger.warn('feature derive skipped — bindings could not be read', {
        tags: { deviceId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return
    }
    await this.applyOne(deviceId, entries)
  }

  private async applyOne(
    deviceId: number,
    entries: readonly DeviceBindingEntry[],
  ): Promise<boolean> {
    // Unknown is not absent (D315, D49). A device's bindings are never empty
    // just because its provider is missing: the `defaultActive` wrappers bind
    // with no native behind them. So the gate is the provider itself — until
    // one of its caps is in the answer (after a hub restart the push-fed
    // native cache starts empty; an agent can be offline), the derived
    // features stay as stored rather than being settled to absent.
    if (!nativeProviderReported(entries)) {
      this.deps.logger.debug('feature derive deferred — the device provider has reported no cap', {
        tags: { deviceId },
        meta: { entries: entries.length },
      })
      return false
    }
    try {
      return await this.deps.apply(deviceId, entries)
    } catch (err) {
      this.deps.logger.warn('feature derive failed — stored features left as they were', {
        tags: { deviceId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return false
    }
  }
}

/**
 * True when the device's own provider is in the answer: some entry names a
 * native addon. A native cap is registered only by the process the device
 * lives in, so one is proof the provider is up and the registry heard it; a
 * set of wrapper entries with no native behind them proves nothing.
 */
export function nativeProviderReported(entries: readonly DeviceBindingEntry[]): boolean {
  return entries.some((entry) => entry.nativeAddonId.length > 0)
}

/** Feed the deriver from the bus; returns the unsubscribe. */
export function subscribeFeatureDeriver(eventBus: IEventBus, deriver: FeatureDeriver): () => void {
  return eventBus.subscribe({ category: EventCategory.DeviceBindingsChanged }, (event) => {
    void deriver.onBindingsChanged(event.data.deviceId)
  })
}
