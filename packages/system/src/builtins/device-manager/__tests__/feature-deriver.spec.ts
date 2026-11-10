/**
 * The scheduling half of #459: when the persisted features are re-derived and
 * what a failed or empty read is allowed to do. What a settle MEANS is pinned
 * in `derived-features.spec.ts` (the addon end to end) and in the types spec.
 */
import type { DeviceBindingEntry, IEventBus, IScopedLogger, SystemEvent } from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { FeatureDeriver, subscribeFeatureDeriver } from '../feature-deriver.js'

function logger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

function entry(capName: string): DeviceBindingEntry {
  return {
    capName,
    kind: 'native',
    providerAddonId: 'prov',
    providerNodeId: 'hub',
    nativeAddonId: 'prov',
  }
}

function gate(): { open: () => void; wait: Promise<void> } {
  let open: () => void = () => {}
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, wait }
}

describe('FeatureDeriver', () => {
  it('settles from the bindings it just read', async () => {
    const apply = vi.fn(async () => true)
    const deriver = new FeatureDeriver({
      bindingsOf: async () => [entry('ptz')],
      allBindings: async () => [],
      apply,
      nodeOnline: () => true,
      logger: logger(),
    })
    await deriver.onBindingsChanged(7)
    expect(apply).toHaveBeenCalledWith(7, [entry('ptz')])
  })

  it('collapses a burst for one device into the run already waiting', async () => {
    const first = gate()
    const started = gate()
    let reads = 0
    const apply = vi.fn(async () => true)
    const deriver = new FeatureDeriver({
      bindingsOf: async () => {
        reads += 1
        if (reads === 1) {
          started.open()
          await first.wait
        }
        return [entry(`cap-${reads}`)]
      },
      allBindings: async () => [],
      apply,
      nodeOnline: () => true,
      logger: logger(),
    })
    const running = deriver.onBindingsChanged(7)
    await started.wait
    // Five more arrive while the first is mid-read: they share ONE follow-up run.
    const burst = [1, 2, 3, 4, 5].map(() => deriver.onBindingsChanged(7))
    first.open()
    await Promise.all([running, ...burst])
    expect(apply).toHaveBeenCalledTimes(2)
    expect(apply).toHaveBeenLastCalledWith(7, [entry('cap-2')])
  })

  it('never lets two settles of one device overlap', async () => {
    let inFlight = 0
    let peak = 0
    const deriver = new FeatureDeriver({
      bindingsOf: async () => [entry('ptz')],
      allBindings: async () => [],
      apply: async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight -= 1
        return false
      },
      nodeOnline: () => true,
      logger: logger(),
    })
    await Promise.all([deriver.onBindingsChanged(7), deriver.onBindingsChanged(7)])
    await deriver.onBindingsChanged(7)
    expect(peak).toBe(1)
  })

  it('changes nothing when the bindings read fails (D49)', async () => {
    const apply = vi.fn(async () => true)
    const log = logger()
    const deriver = new FeatureDeriver({
      bindingsOf: async () => {
        throw new Error('registry unreachable')
      },
      allBindings: async () => [],
      apply,
      nodeOnline: () => true,
      logger: log,
    })
    await deriver.onBindingsChanged(7)
    expect(apply).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('bindings could not be read'),
      expect.objectContaining({ tags: { deviceId: 7 } }),
    )
  })

  it('does not derive from an empty answer', async () => {
    const apply = vi.fn(async () => true)
    const deriver = new FeatureDeriver({
      bindingsOf: async () => [],
      allBindings: async () => [{ deviceId: 8, entries: [] }],
      apply,
      nodeOnline: () => true,
      logger: logger(),
    })
    await deriver.onBindingsChanged(7)
    await deriver.reconcileAll()
    expect(apply).not.toHaveBeenCalled()
  })

  it('does not derive while only default wrappers answer for the device (D315)', async () => {
    // After a hub restart the push-fed native cache starts empty, and an
    // agent can be offline: the camera then still has its `defaultActive`
    // wrapper entries, but none of its own provider's caps. Its ptz, reboot
    // and intercom are UNKNOWN, not absent.
    const wrapper = (capName: string): DeviceBindingEntry => ({
      capName,
      kind: 'wrapped',
      providerAddonId: 'pipeline',
      providerNodeId: 'hub',
      nativeAddonId: '',
    })
    const apply = vi.fn(async () => true)
    const deriver = new FeatureDeriver({
      bindingsOf: async () => [wrapper('snapshot'), wrapper('motion-detection')],
      allBindings: async () => [{ deviceId: 8, entries: [wrapper('snapshot')] }],
      apply,
      nodeOnline: () => true,
      logger: logger(),
    })
    await deriver.onBindingsChanged(7)
    expect(await deriver.reconcileAll()).toBe(0)
    expect(apply).not.toHaveBeenCalled()
  })

  it('derives once the device provider answers from a node the registry calls online', async () => {
    const wrapped: DeviceBindingEntry = {
      capName: 'snapshot',
      kind: 'wrapped',
      providerAddonId: 'pipeline',
      providerNodeId: 'hub',
      nativeAddonId: 'prov',
    }
    const native: DeviceBindingEntry = { ...entry('ptz'), providerNodeId: 'agent-1' }
    const apply = vi.fn(async () => true)
    const deriver = new FeatureDeriver({
      bindingsOf: async () => [wrapped, native],
      allBindings: async () => [],
      apply,
      nodeOnline: (nodeId) => nodeId === 'agent-1',
      logger: logger(),
    })
    await deriver.onBindingsChanged(7)
    expect(apply).toHaveBeenCalledWith(7, [wrapped, native])
  })

  it('does not derive from a cached native whose agent is offline', async () => {
    // `remoteNativeCaps` keeps an agent's natives until the caps are removed,
    // so an offline agent's camera still answers ptz/reboot/intercom from the
    // cache. Those are stale, not known: the stored features stay.
    const native: DeviceBindingEntry = { ...entry('ptz'), providerNodeId: 'agent-1' }
    const apply = vi.fn(async () => true)
    const deriver = new FeatureDeriver({
      bindingsOf: async () => [native],
      allBindings: async () => [{ deviceId: 8, entries: [native] }],
      apply,
      nodeOnline: () => false,
      logger: logger(),
    })
    await deriver.onBindingsChanged(7)
    expect(await deriver.reconcileAll()).toBe(0)
    expect(apply).not.toHaveBeenCalled()
  })

  it('never derives a device whose own provider serves no cap (its features are declared)', async () => {
    // Intended: with no native of its own, nothing can say a feature is
    // ABSENT, so the declared set stays. A wrapper naming a native it
    // decorates does not say where that native runs.
    const wrapped: DeviceBindingEntry = {
      capName: 'snapshot',
      kind: 'wrapped',
      providerAddonId: 'pipeline',
      providerNodeId: 'hub',
      nativeAddonId: 'prov',
    }
    const apply = vi.fn(async () => true)
    const deriver = new FeatureDeriver({
      bindingsOf: async () => [wrapped],
      allBindings: async () => [],
      apply,
      nodeOnline: () => true,
      logger: logger(),
    })
    await deriver.onBindingsChanged(7)
    expect(apply).not.toHaveBeenCalled()
  })

  it('a write that throws is logged against the device and the others still settle', async () => {
    const log = logger()
    const apply = vi.fn(async (deviceId: number) => {
      if (deviceId === 1) throw new Error('disk full')
      return true
    })
    const deriver = new FeatureDeriver({
      bindingsOf: async () => [],
      allBindings: async () => [
        { deviceId: 1, entries: [entry('ptz')] },
        { deviceId: 2, entries: [entry('ptz')] },
      ],
      apply,
      nodeOnline: () => true,
      logger: log,
    })
    expect(await deriver.reconcileAll()).toBe(1)
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('stored features left as they were'),
      expect.objectContaining({ tags: { deviceId: 1 } }),
    )
  })

  it('the boot reconcile repairs what a dropped event never settled', async () => {
    const apply = vi.fn(async () => true)
    const deriver = new FeatureDeriver({
      bindingsOf: async () => [],
      allBindings: async () => [
        { deviceId: 1, entries: [entry('ptz')] },
        { deviceId: 2, entries: [entry('reboot')] },
      ],
      apply,
      nodeOnline: () => true,
      logger: logger(),
    })
    expect(await deriver.reconcileAll()).toBe(2)
    expect(apply).toHaveBeenCalledTimes(2)
  })

  it('a failed fleet read skips the reconcile instead of settling from nothing', async () => {
    const apply = vi.fn(async () => true)
    const deriver = new FeatureDeriver({
      bindingsOf: async () => [],
      allBindings: async () => {
        throw new Error('sqlite busy')
      },
      apply,
      nodeOnline: () => true,
      logger: logger(),
    })
    expect(await deriver.reconcileAll()).toBe(0)
    expect(apply).not.toHaveBeenCalled()
  })
})

describe('subscribeFeatureDeriver', () => {
  it('settles the device a DeviceBindingsChanged names, and stops on unsubscribe', async () => {
    const captured: { handler: ((event: SystemEvent) => void) | null } = { handler: null }
    const unsubscribe = vi.fn()
    const bus = {
      emit: vi.fn(),
      getRecent: () => [],
      subscribe: (filter: { category: string }, h: (event: SystemEvent) => void) => {
        expect(filter.category).toBe(EventCategory.DeviceBindingsChanged)
        captured.handler = h
        return unsubscribe
      },
    } as unknown as IEventBus
    const onBindingsChanged = vi.fn(async () => {})
    const deriver = Object.assign(
      new FeatureDeriver({
        bindingsOf: async () => [],
        allBindings: async () => [],
        apply: async () => false,
        nodeOnline: () => true,
        logger: logger(),
      }),
      { onBindingsChanged },
    )
    const stop = subscribeFeatureDeriver(bus, deriver)
    captured.handler?.({
      id: 'e',
      timestamp: new Date(),
      source: { type: 'device', id: 9 },
      category: EventCategory.DeviceBindingsChanged,
      data: {
        deviceId: 9,
        capName: 'ptz',
        reason: 'native-registered',
        addonId: 'a',
        nodeId: 'n',
      },
    })
    expect(onBindingsChanged).toHaveBeenCalledWith(9)
    stop()
    expect(unsubscribe).toHaveBeenCalled()
  })
})
