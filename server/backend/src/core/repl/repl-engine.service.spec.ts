/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- test file: mock typing crosses generic boundaries */
/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ReplEngineService specs — exercises the actual current shape of the
 * REPL service, including the SystemManager warm-boot path that
 * recently hung the entire REPL when the broker tried to route
 * `live.onEvent` through the Moleculer service registry.
 *
 * Mocks at the AddonRegistry boundary (the dependency of the service)
 * — the rest is real: ReplEngine, SystemManager, EventBus adapter.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ReplEngineService } from './repl-engine.service'
import { SystemEventBus } from '@camstack/system'
import type { ReplSessionContext } from '@camstack/system'
import type { DeviceBinding } from '@camstack/types'
import { DeviceType, EventCategory } from '@camstack/types'

// ── In-process broker api fixture ─────────────────────────────────────
//
// Mimics what `addonRegistry.getBrokerApi()` returns: a plain object
// with `<cap>.<method>.{query|mutate}` shape that resolves locally.
// The REPL service merges `live.onEvent` via the EventBus adapter on
// top of this base.

interface BrokerApiState {
  bindings: Map<number, DeviceBinding>
  snapshots: Record<string, Record<string, Record<string, unknown>>>
  devices: Map<
    number,
    {
      id: number
      stableId: string
      addonId: string
      type: DeviceType
      name: string
      parentDeviceId: number | null
      role: string | null
      online: boolean
      features: string[]
      isCamera: boolean
      config: Record<string, unknown>
    }
  >
}

function makeBrokerApi(state: BrokerApiState): unknown {
  return {
    deviceManager: {
      getAllBindings: {
        query: vi.fn(async () => Array.from(state.bindings.values())),
      },
      listAll: {
        query: vi.fn(async () => Array.from(state.devices.values())),
      },
      getBindings: {
        query: vi.fn(
          async ({ deviceId }: { deviceId: number }) =>
            state.bindings.get(deviceId) ?? { deviceId, entries: [] },
        ),
      },
    },
    deviceState: {
      getCapSlice: {
        query: vi.fn(
          async ({ deviceId, capName }: { deviceId: number; capName: string }) =>
            state.snapshots[String(deviceId)]?.[capName] ?? null,
        ),
      },
      getAllSnapshots: {
        query: vi.fn(async () => state.snapshots),
      },
    },
  }
}

// ── Harness ───────────────────────────────────────────────────────────

interface Harness {
  service: ReplEngineService
  state: BrokerApiState
  eventBus: SystemEventBus
  /** Re-fetch the broker api spies for assertion. */
  brokerApi: any
}

function makeHarness(seed?: Partial<BrokerApiState>): Harness {
  // Reset the static SystemMirror singleton so each test gets a fresh
  // warm-boot. The service caches it in static class fields — accept
  // the test-only reach-in to keep tests isolated.
  ;(ReplEngineService as any).systemMirror = null
  ;(ReplEngineService as any).systemMirrorInit = null

  const state: BrokerApiState = {
    bindings: seed?.bindings ?? new Map(),
    snapshots: seed?.snapshots ?? {},
    devices: seed?.devices ?? new Map(),
  }

  const brokerApi = makeBrokerApi(state)
  const eventBus = new SystemEventBus(1000)

  // Real EventBusService stub — the service only calls .subscribe.
  const eventBusService = {
    subscribe: (filter: any, handler: any) => eventBus.subscribe(filter, handler),
    emit: (evt: any) => eventBus.emit(evt),
    getRecent: () => [],
  } as any

  const deviceRegistry = {
    getAll: () => Array.from(state.devices.values()),
    getById: (id: number) => state.devices.get(id) ?? null,
    getAllForAddon: (addonId: string) =>
      Array.from(state.devices.values()).filter((d) => d.addonId === addonId),
    getAllWithAddonId: () =>
      Array.from(state.devices.values()).map((d) => ({ addonId: d.addonId, device: d })),
    getAddonId: (id: number) => state.devices.get(id)?.addonId ?? null,
  }

  const integrationRegistry = {
    listIntegrations: vi.fn(async () => []),
    getIntegration: vi.fn(async () => null),
  }

  const addonRegistry = {
    getBrokerApi: () => brokerApi,
    getDeviceRegistry: () => deviceRegistry,
    getIntegrationRegistry: () => integrationRegistry,
    listAddons: () => [],
  } as any

  const loggingService = {
    createLogger: () => ({
      info: vi.fn(),
      child: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  } as any

  const service = new ReplEngineService(addonRegistry, eventBusService, loggingService)
  return { service, state, eventBus, brokerApi }
}

const mkBinding = (deviceId: number, capNames: string[]): DeviceBinding => ({
  deviceId,
  entries: capNames.map((capName) => ({
    capName,
    kind: 'native' as const,
    providerAddonId: 'test',
    providerNodeId: 'hub',
    nativeAddonId: 'test',
  })),
})

const mkDevice = (
  id: number,
  overrides: Partial<BrokerApiState['devices'] extends Map<number, infer V> ? V : never> = {},
): BrokerApiState['devices'] extends Map<number, infer V> ? V : never =>
  ({
    id,
    stableId: `stable-${id}`,
    addonId: 'addon-test',
    type: DeviceType.Camera,
    name: `Device ${id}`,
    parentDeviceId: null,
    role: null,
    online: true,
    features: [],
    isCamera: true,
    config: {},
    ...overrides,
  }) as any

const SYSTEM_CTX: ReplSessionContext = { scope: { type: 'system' }, variables: {} }

// ── Tests ─────────────────────────────────────────────────────────────

describe('ReplEngineService — basic eval', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })

  it('evaluates simple arithmetic expressions', async () => {
    const r = await h.service.execute('1 + 1', SYSTEM_CTX)
    expect(r.type).toBe('value')
    expect(r.output).toBe('2')
  })

  it('returns void for variable declarations', async () => {
    const r = await h.service.execute('const x = 42', SYSTEM_CTX)
    expect(r.type).toBe('void')
  })

  it('returns error type when user code throws', async () => {
    const r = await h.service.execute("throw new Error('boom')", SYSTEM_CTX)
    expect(r.type).toBe('error')
    expect(r.output).toContain('boom')
  })

  it('reports duration for every eval', async () => {
    const r = await h.service.execute('1 + 1', SYSTEM_CTX)
    expect(r.duration).toBeGreaterThanOrEqual(0)
    expect(r.duration).toBeLessThan(5_000)
  })

  it('isolates blocked globals — fetch / setTimeout / require unavailable', async () => {
    const fetchR = await h.service.execute('typeof fetch', SYSTEM_CTX)
    expect(fetchR.output).toBe("'undefined'")
    const reqR = await h.service.execute('typeof require', SYSTEM_CTX)
    expect(reqR.output).toBe("'undefined'")
    const setTimeoutR = await h.service.execute('typeof setTimeout', SYSTEM_CTX)
    expect(setTimeoutR.output).toBe("'undefined'")
  })

  it('exposes JSON / Math / Date as standard globals', async () => {
    const json = await h.service.execute('JSON.stringify({a:1})', SYSTEM_CTX)
    expect(json.output).toContain('"a":1')
    const math = await h.service.execute('Math.max(1, 5, 3)', SYSTEM_CTX)
    expect(math.output).toBe('5')
  })
})

describe('ReplEngineService — system scope sandbox', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness({
      bindings: new Map([[1, mkBinding(1, ['battery'])]]),
      devices: new Map([[1, mkDevice(1, { name: 'Test Cam' })]]),
      snapshots: { '1': { battery: { sleeping: true, percentage: 50 } } },
    })
  })

  it('binds `sm` to the warm-booted SystemManager', async () => {
    const r = await h.service.execute('typeof sm', SYSTEM_CTX)
    expect(r.output).toBe("'object'")
  })

  it('sm.getDeviceById returns a typed proxy with sync state', async () => {
    const r = await h.service.execute(
      'sm.getDeviceById(1).state.battery.value.sleeping',
      SYSTEM_CTX,
    )
    expect(r.type).toBe('value')
    expect(r.output).toBe('true')
  })

  it('sm.getDeviceByName resolves the metadata mirror', async () => {
    const r = await h.service.execute("sm.getDeviceByName('Test Cam').deviceId", SYSTEM_CTX)
    expect(r.output).toBe('1')
  })

  it('sm.summary returns counts', async () => {
    const r = await h.service.execute('sm.summary().totalDevices', SYSTEM_CTX)
    expect(r.output).toBe('1')
  })

  it('sm.query filters by addonId + caps + online', async () => {
    h.state.bindings.set(2, mkBinding(2, ['snapshot']))
    h.state.devices.set(2, mkDevice(2, { name: 'Cam 2', addonId: 'reolink', online: true }))
    h.state.devices.set(1, mkDevice(1, { name: 'Cam 1', addonId: 'reolink', online: false }))
    // Re-warm-boot the SM so the new devices show up.
    ;(ReplEngineService as any).systemMirror = null
    ;(ReplEngineService as any).systemMirrorInit = null

    const r = await h.service.execute(
      "sm.query({ addonId: 'reolink', online: true }).map(d => d.deviceId)",
      SYSTEM_CTX,
    )
    expect(r.output).toContain('2')
    expect(r.output).not.toContain('1,')
  })

  it('legacy variables remain accessible (backward-compat)', async () => {
    const r1 = await h.service.execute('typeof addonRegistry', SYSTEM_CTX)
    expect(r1.output).toBe("'object'")
    const r2 = await h.service.execute('typeof eventBus', SYSTEM_CTX)
    expect(r2.output).toBe("'object'")
    const r3 = await h.service.execute('typeof getDevice', SYSTEM_CTX)
    expect(r3.output).toBe("'function'")
  })
})

describe('ReplEngineService — device scope sandbox', () => {
  const DEVICE_CTX: ReplSessionContext = {
    scope: { type: 'device', deviceId: 8 },
    variables: {},
  }

  let h: Harness
  beforeEach(() => {
    h = makeHarness({
      bindings: new Map([[8, mkBinding(8, ['battery', 'snapshot'])]]),
      devices: new Map([[8, mkDevice(8, { name: 'Sala', addonId: 'reolink' })]]),
      snapshots: { '8': { battery: { sleeping: false, percentage: 88 } } },
    })
  })

  it('pre-binds `device` as a DeviceProxy with sync state', async () => {
    const r = await h.service.execute('device.state.battery.value.percentage', DEVICE_CTX)
    expect(r.type).toBe('value')
    expect(r.output).toBe('88')
  })

  it('exposes deviceId, info, sm, rawDevice', async () => {
    const a = await h.service.execute('deviceId', DEVICE_CTX)
    expect(a.output).toBe('8')
    const b = await h.service.execute('info.name', DEVICE_CTX)
    expect(b.output).toBe("'Sala'")
    const c = await h.service.execute('typeof sm', DEVICE_CTX)
    expect(c.output).toBe("'object'")
    const d = await h.service.execute('typeof rawDevice', DEVICE_CTX)
    // rawDevice is the raw IDevice from registry — null in our harness for device 8 (we use plain objects)
    // but the type check ensures the binding is in scope.
    expect(['undefined', "'object'"]).toContain(d.output)
  })

  it('device proxy exposes .state for every cap with runtimeState', async () => {
    const r = await h.service.execute('typeof device.state.battery.subscribe', DEVICE_CTX)
    expect(r.output).toBe("'function'")
    const r2 = await h.service.execute('typeof device.state.motion.value', DEVICE_CTX)
    expect(r2.output).toBe("'undefined'")
  })

  it('device proxy exposes cap method dispatchers', async () => {
    const r = await h.service.execute('typeof device.snapshot.getSnapshot', DEVICE_CTX)
    expect(r.output).toBe("'function'")
  })
})

describe('ReplEngineService — SystemManager warm-boot resilience', () => {
  it("warm-boot does NOT hang on `live.onEvent` (regression — broker can't route)", async () => {
    // The bug: `getBrokerApi().live.onEvent.subscribe(...)` polls
    // forever for a Moleculer service that doesn't exist. The fix
    // injects a direct EventBus adapter for `live` so SM init never
    // touches the broker for subscriptions.
    const h = makeHarness({
      bindings: new Map([[1, mkBinding(1, ['battery'])]]),
      devices: new Map([[1, mkDevice(1)]]),
      snapshots: {},
    })

    // 5 second hard ceiling — way above the 15s SM timeout but below
    // the broker's infinite poll. If the bug regresses this test
    // hangs the runner, not silently passes.
    const result = await Promise.race([
      h.service.execute('typeof sm', SYSTEM_CTX),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('test ceiling — REPL eval hung')), 5_000),
      ),
    ])
    expect(result.type).toBe('value')
    expect(result.output).toBe("'object'")
  })

  it('first eval triggers warm-boot; subsequent evals reuse the cached SystemManager', async () => {
    const h = makeHarness({
      bindings: new Map([[1, mkBinding(1, ['battery'])]]),
      devices: new Map([[1, mkDevice(1)]]),
      snapshots: {},
    })

    await h.service.execute('typeof sm', SYSTEM_CTX)
    await h.service.execute('typeof sm', SYSTEM_CTX)
    await h.service.execute('typeof sm', SYSTEM_CTX)

    expect(h.brokerApi.deviceManager.getAllBindings.query).toHaveBeenCalledTimes(1)
    expect(h.brokerApi.deviceState.getAllSnapshots.query).toHaveBeenCalledTimes(1)
    expect(h.brokerApi.deviceManager.listAll.query).toHaveBeenCalledTimes(1)
  })

  it('live.onEvent uses the in-process EventBus, not the broker', async () => {
    const h = makeHarness({
      bindings: new Map([[1, mkBinding(1, ['battery'])]]),
      devices: new Map([[1, mkDevice(1)]]),
      snapshots: { '1': { battery: { sleeping: true, percentage: 50 } } },
    })

    // Boot SM via first eval.
    await h.service.execute('typeof sm', SYSTEM_CTX)

    // Fire an in-process state-change event — SM mirror should pick it up.
    h.eventBus.emit({
      id: 'test-1',
      timestamp: new Date(),
      category: EventCategory.DeviceStateChanged,
      source: { type: 'device', id: 1, deviceId: 1 },
      data: { deviceId: 1, capName: 'battery', slice: { sleeping: false, percentage: 90 } },
    })
    // Microtask flush.
    await new Promise((r) => setTimeout(r, 10))

    const r = await h.service.execute(
      'sm.getDeviceById(1).state.battery.value.sleeping',
      SYSTEM_CTX,
    )
    expect(r.output).toBe('false')
  })
})

describe('ReplEngineService — error paths', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness()
  })

  it('returns error when accessing undefined variables', async () => {
    const r = await h.service.execute('undefinedVariable.foo', SYSTEM_CTX)
    expect(r.type).toBe('error')
  })

  it('error output does not leak the engine internals', async () => {
    const r = await h.service.execute('throw new TypeError("user error")', SYSTEM_CTX)
    expect(r.type).toBe('error')
    expect(r.output).toContain('user error')
    // Should NOT contain stack frames from repl-engine.ts itself.
    expect(r.output).not.toContain('repl-engine.ts')
  })
})

describe('ReplEngineService — completions', () => {
  let h: Harness
  beforeEach(() => {
    h = makeHarness({
      bindings: new Map([[1, mkBinding(1, ['battery'])]]),
      devices: new Map([[1, mkDevice(1)]]),
      snapshots: {},
    })
  })

  it('returns sandbox keys when partial is empty', async () => {
    const completions = await h.service.getCompletions('', SYSTEM_CTX)
    expect(completions).toContain('sm')
    expect(completions).toContain('JSON')
    expect(completions).toContain('Math')
  })

  it('filters by partial prefix', async () => {
    const completions = await h.service.getCompletions('sm', SYSTEM_CTX)
    expect(completions).toContain('sm')
  })
})
