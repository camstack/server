/**
 * CapabilityRegistry — per-device native provider registry.
 *
 * Backs `DeviceContext.registerNativeCap`. Indexed by `(capName, deviceId)`,
 * stores the addonId + opaque provider reference. Used by the device-proxy
 * router to route capability calls to the correct device-driver instance.
 */
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import {
  type AddonApi,
  method,
  type CapabilityDefinition,
  type IEventBus,
  type IScopedLogger,
  type SystemEvent,
} from '@camstack/types'
import { CapabilityRegistry } from '../capability-registry.js'
import { DeviceRegistry } from '../device-registry.js'
import { createBrokerDeviceManagerApi } from '../moleculer/device-cap-proxy.js'

const fooCap = {
  name: 'foo',
  scope: 'device',
  mode: 'singleton',
  methods: { ping: method(z.object({ deviceId: z.number() }), z.literal('pong')) },
} as const satisfies CapabilityDefinition

function createMockLogger(): IScopedLogger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  } as unknown as IScopedLogger
}

const CAM_01 = 1
const CAM_02 = 2
const CAM_XX = 99

describe('CapabilityRegistry — native per-device providers', () => {
  it('registerNative and getNative round-trip a typed provider', () => {
    const reg = new CapabilityRegistry(createMockLogger())
    const provider = { ping: async () => 'pong' as const }
    reg.registerNativeProvider(fooCap.name, CAM_01, 'addon-provider-onvif', provider)
    expect(reg.getNativeProvider(fooCap.name, CAM_01)).toBe(provider)
    expect(reg.getNativeAddonId(fooCap.name, CAM_01)).toBe('addon-provider-onvif')
  })

  it('throws on duplicate native registration for the same (cap, device)', () => {
    const reg = new CapabilityRegistry(createMockLogger())
    reg.registerNativeProvider('foo', CAM_01, 'addon-provider-onvif', {
      ping: async () => 'pong' as const,
    })
    expect(() =>
      reg.registerNativeProvider('foo', CAM_01, 'addon-provider-onvif', {
        ping: async () => 'pong' as const,
      }),
    ).toThrow(/already registered/)
  })

  it('unregisterAllNativeForDevice removes every native entry for a device', () => {
    const reg = new CapabilityRegistry(createMockLogger())
    reg.registerNativeProvider('foo', CAM_01, 'addon-a', { ping: async () => 'pong' as const })
    reg.registerNativeProvider('bar', CAM_01, 'addon-b', { pong: async () => 'ping' as const })
    reg.unregisterAllNativeForDevice(CAM_01)
    expect(reg.getNativeProvider('foo', CAM_01)).toBeNull()
    expect(reg.getNativeProvider('bar', CAM_01)).toBeNull()
  })

  it('getNativeCapsForDevice lists all caps registered for a device', () => {
    const reg = new CapabilityRegistry(createMockLogger())
    reg.registerNativeProvider('foo', CAM_01, 'addon-a', { ping: async () => 'pong' as const })
    reg.registerNativeProvider('bar', CAM_01, 'addon-b', { pong: async () => 'ping' as const })
    reg.registerNativeProvider('foo', CAM_02, 'addon-a', { ping: async () => 'pong' as const })
    const caps = [...reg.getNativeCapsForDevice(CAM_01)].toSorted()
    expect(caps).toEqual(['bar', 'foo'])
    expect(reg.getNativeCapsForDevice(CAM_XX)).toEqual([])
  })
})

const barCap = {
  name: 'bar',
  scope: 'device',
  mode: 'singleton',
  methods: { pong: method(z.object({ deviceId: z.number() }), z.literal('ping')) },
} as const satisfies CapabilityDefinition

interface HubContextHarness {
  readonly reg: CapabilityRegistry
  readonly events: SystemEvent[]
  readonly logger: IScopedLogger
  readonly contextFor: (
    addonId: string,
    deviceId: number,
  ) => ReturnType<ReturnType<typeof createBrokerDeviceManagerApi>['createContext']>
}

/** The hub-local branch of `buildContext`: `capabilityRegistry` is the sink. */
function hubContexts(): HubContextHarness {
  const reg = new CapabilityRegistry(createMockLogger())
  const events: SystemEvent[] = []
  const bus: IEventBus = {
    emit: (event: SystemEvent) => {
      events.push(event)
    },
    subscribe: () => () => {},
    getRecent: () => [],
  }
  const logger = createMockLogger()
  // The context never calls the API on these paths: an empty object is the whole surface it touches.
  const api = {} as unknown as AddonApi
  const registry = new DeviceRegistry()
  const contextFor = (addonId: string, deviceId: number) =>
    createBrokerDeviceManagerApi({
      api,
      addonId,
      nodeId: 'hub',
      logger,
      eventBus: bus,
      registry,
      capabilityRegistry: reg,
    }).createContext(`${addonId}:${deviceId}`, deviceId)
  return { reg, events, logger, contextFor }
}

function bindingReasons(events: readonly SystemEvent[]): readonly string[] {
  return events
    .filter((e) => e.category === 'device.bindings-changed')
    .map(
      (e) =>
        `${String(e.data['addonId'])}:${String(e.data['capName'])}:${String(e.data['reason'])}`,
    )
}

describe('DeviceContext.unregisterNativeCap — the capabilityRegistry branch (D663 Kernel ruling)', () => {
  it('removes exactly (cap, id): a sibling cap of the same device stays registered', () => {
    const h = hubContexts()
    const ctx = h.contextFor('addon-a', CAM_01)
    ctx.registerNativeCap(fooCap, { ping: async () => 'pong' as const })
    ctx.registerNativeCap(barCap, { pong: async () => 'ping' as const })
    ctx.unregisterNativeCap?.('foo')
    expect(h.reg.getNativeProvider('foo', CAM_01)).toBeNull()
    expect(h.reg.getNativeAddonId('bar', CAM_01)).toBe('addon-a')
    expect(bindingReasons(h.events)).toEqual([
      'addon-a:foo:native-registered',
      'addon-a:bar:native-registered',
      'addon-a:foo:native-unregistered',
    ])
    const down = h.events.filter((e) => e.category !== 'device.bindings-changed').at(-1)
    expect(down?.data).toMatchObject({ capName: 'foo', state: 'down' })
  })

  it("never removes ANOTHER addon's (cap, id): a logged no-op, no event", () => {
    const h = hubContexts()
    const provider = { ping: async () => 'pong' as const }
    h.contextFor('provider-homeassistant', CAM_02).registerNativeCap(fooCap, provider)
    h.contextFor('composer', CAM_02).unregisterNativeCap?.('foo')
    expect(h.reg.getNativeProvider('foo', CAM_02)).toBe(provider)
    expect(bindingReasons(h.events)).toEqual(['provider-homeassistant:foo:native-registered'])
    expect(h.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('not registered by this addon'),
      expect.objectContaining({ tags: expect.objectContaining({ deviceId: CAM_02 }) }),
    )
  })
})
