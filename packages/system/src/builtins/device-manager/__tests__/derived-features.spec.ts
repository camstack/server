/**
 * #459 end to end on the real device-manager addon: a binding arriving on the
 * bus changes the persisted features, a driver re-registering does not undo
 * what the kernel derived, and an unbound cap takes its feature away.
 */
import type { IEventBus, SystemEvent } from '@camstack/types'
import { DeviceFeature, EventCategory } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { setup, registerCamera } from './device-manager-harness.js'
import { readDeviceRow } from './settings-store-api.js'

type Handler = (event: SystemEvent) => void

/** A bus that really delivers: the addon's own subscriptions are what is under test. */
function deliveringBus(): { bus: IEventBus; emitted: SystemEvent[] } {
  const handlers: Array<{ category: string; handler: Handler }> = []
  const emitted: SystemEvent[] = []
  const bus = {
    emit: (event: SystemEvent) => {
      emitted.push(event)
      for (const h of handlers) if (h.category === event.category) h.handler(event)
    },
    subscribe: (filter: { category: string }, handler: Handler) => {
      const entry = { category: filter.category, handler }
      handlers.push(entry)
      return () => {
        handlers.splice(handlers.indexOf(entry), 1)
      }
    },
    getRecent: () => [],
  } as unknown as IEventBus
  return { bus, emitted }
}

function bindingEvent(
  deviceId: number,
  capName: string,
  reason: 'native-registered' | 'native-unregistered',
  implementedMethods?: string[],
): SystemEvent {
  return {
    id: `${deviceId}-${capName}-${reason}`,
    timestamp: new Date(),
    source: { type: 'device', id: deviceId },
    category: EventCategory.DeviceBindingsChanged,
    data: {
      deviceId,
      capName,
      reason,
      addonId: 'provider-x',
      nodeId: 'agent-a',
      ...(implementedMethods !== undefined ? { implementedMethods } : {}),
    },
  } as SystemEvent
}

async function featuresOf(
  h: Awaited<ReturnType<typeof setup>>,
  deviceId: number,
): Promise<unknown> {
  return (await readDeviceRow(h.settingsStore, deviceId))['features']
}

describe('device features follow the bindings (#459)', () => {
  it('a cap bound after registration becomes a persisted feature, and exporters are told once', async () => {
    const { bus, emitted } = deliveringBus()
    const h = await setup({ eventBus: bus })
    const id = await registerCamera(h, 'rtsp', 'cam-1')
    expect(await featuresOf(h, id)).toEqual([])

    bus.emit(bindingEvent(id, 'ptz', 'native-registered'))
    await vi.waitFor(async () => {
      expect(await featuresOf(h, id)).toEqual([DeviceFeature.PanTiltZoom])
    })
    const provisioned = emitted.filter((e) => e.category === EventCategory.DeviceProvisioned)
    // First registration, then the derived change: two distinct fingerprints.
    expect(provisioned).toHaveLength(2)
    const prints = provisioned.map((e) => (e.data as { fingerprint: string }).fingerprint)
    expect(prints[1]).not.toBe(prints[0])

    // The same binding again changes nothing and announces nothing.
    bus.emit(bindingEvent(id, 'ptz', 'native-registered'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(emitted.filter((e) => e.category === EventCategory.DeviceProvisioned)).toHaveLength(2)
  })

  it('a driver re-registering does not undo, or invent, a derived feature', async () => {
    const { bus } = deliveringBus()
    const h = await setup({ eventBus: bus })
    const id = await registerCamera(h, 'rtsp', 'cam-1')
    bus.emit(bindingEvent(id, 'ptz', 'native-registered'))
    await vi.waitFor(async () => {
      expect(await featuresOf(h, id)).toEqual([DeviceFeature.PanTiltZoom])
    })

    // The driver's probe lands: it forgets ptz and claims a derived feature it does not serve.
    await h.provider.registerDevice({
      addonId: 'rtsp',
      stableId: 'cam-1',
      id,
      type: 'camera',
      name: 'cam-1',
      parentDeviceId: null,
      features: [DeviceFeature.TwoWayAudio],
      config: {},
    })
    expect(await featuresOf(h, id)).toEqual([DeviceFeature.PanTiltZoom])
  })

  it('unbinding the cap takes the feature away', async () => {
    const { bus } = deliveringBus()
    const h = await setup({ eventBus: bus })
    const id = await registerCamera(h, 'rtsp', 'cam-1')
    bus.emit(bindingEvent(id, 'ptz', 'native-registered'))
    bus.emit(bindingEvent(id, 'reboot', 'native-registered'))
    await vi.waitFor(async () => {
      expect(await featuresOf(h, id)).toEqual([DeviceFeature.Rebootable, DeviceFeature.PanTiltZoom])
    })
    bus.emit(bindingEvent(id, 'ptz', 'native-unregistered'))
    await vi.waitFor(async () => {
      expect(await featuresOf(h, id)).toEqual([DeviceFeature.Rebootable])
    })
  })

  it('a cap bound without the method a feature needs does not grant it', async () => {
    const { bus } = deliveringBus()
    const h = await setup({ eventBus: bus })
    const id = await registerCamera(h, 'rtsp', 'cam-1')
    bus.emit(bindingEvent(id, 'reboot', 'native-registered', []))
    bus.emit(bindingEvent(id, 'motion-trigger', 'native-registered', ['setMotionTrigger']))
    await vi.waitFor(async () => {
      expect(await featuresOf(h, id)).toEqual([DeviceFeature.MotionTrigger])
    })
  })

  it('an event for a device that was allocated but never registered writes no features', async () => {
    const { bus } = deliveringBus()
    const h = await setup({ eventBus: bus })
    const { id } = await h.provider.allocateDeviceId({
      addonId: 'rtsp',
      stableId: 'cam-ghost',
    })
    bus.emit(bindingEvent(id, 'ptz', 'native-registered'))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect((await readDeviceRow(h.settingsStore, id))['features'] ?? []).toEqual([])
    expect((await readDeviceRow(h.settingsStore, id))['registered'] ?? false).toBe(false)
  })
})
