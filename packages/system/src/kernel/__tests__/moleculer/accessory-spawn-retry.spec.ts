/**
 * A failed accessory-child spawn is retried, bounded (the D347 shape), through
 * the real kernel reconcile; every failure and the give-up are ERROR logs
 * naming the step, tagged with the child's deviceId.
 */
import type {
  AccessoryChildSpec,
  AddonApi,
  DeviceType,
  IDevice,
  IEventBus,
  IScopedLogger,
} from '@dominevo/types'
import { describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '../../capability-registry.js'
import { DeviceRegistry } from '../../device-registry.js'
import { createBrokerDeviceManagerApi } from '../../moleculer/device-cap-proxy.js'

const PARENT_ID = 7100
const KEEP_ID = 7101
const PARENT_STABLE = 'dreame-container-x'
const KEEP_STABLE = `${PARENT_STABLE}-vacuum`

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

const bus: IEventBus = {
  emit: () => {},
  subscribe: () => () => {},
  getRecent: () => [],
}

function childDevice(ctx: { id: number; stableId: string }): IDevice {
  const device = {
    id: ctx.id,
    stableId: ctx.stableId,
    parentDeviceId: null,
    type: 'sensor',
    name: ctx.stableId,
    online: true,
    features: [],
    config: {
      values: {},
      get: () => undefined,
      set: async () => {},
      setAll: async () => {},
    },
    removeDevice: async () => {},
    getSettingsUISchema: () => ({ sections: [] }),
    applySettingsPatch: async () => {},
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
  return device as unknown as IDevice
}

function spec(suffix: string): AccessoryChildSpec {
  return {
    stableIdSuffix: suffix,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- enum value in a test double
    meta: { type: 'sensor' as DeviceType, name: suffix },
    config: {},
    factory: (ctx) => childDevice(ctx),
  }
}

/** Parent with ONE accessory whose first `applyInitialMeta` dial fails. */
function failingWorld(
  failures: number,
  failing: string = 'applyInitialMeta',
  delaysMs: readonly number[] = [5, 5],
) {
  let fail = failures
  const calls: Record<string, number> = {}
  const log = logger()
  const parent = {
    id: PARENT_ID,
    stableId: PARENT_STABLE,
    parentDeviceId: null,
    type: 'container',
    name: 'Robot',
    online: true,
    features: [],
    config: {
      values: {},
      get: () => undefined,
      set: async () => {},
      setAll: async () => {},
    },
    runtimeState: {
      getCapState: () => ({ lastProbedAt: 1 }),
      subscribeCap: () => () => {},
    },
    removeDevice: async () => {},
    getSettingsUISchema: () => ({ sections: [] }),
    applySettingsPatch: async () => {},
    getAccessoryChildren: () => [spec('vacuum')],
    _kernelReprobe: undefined as undefined | (() => Promise<void>),
  }
  const api = {
    deviceManager: new Proxy({} as Record<string, unknown>, {
      get(_t, method) {
        if (typeof method !== 'string') return undefined
        const handler = vi.fn(async () => {
          calls[method] = (calls[method] ?? 0) + 1
          if (method === 'allocateDeviceId') return { id: KEEP_ID }
          if (method === failing && fail > 0) {
            fail -= 1
            throw new Error('dial timed out')
          }
          if (method === 'loadRuntimeState' || method === 'loadConfig') return {}
          if (method === 'getChildren') return []
          return undefined
        })
        return { mutate: handler, query: handler }
      },
    }),
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
  } as unknown as AddonApi
  const registry = new DeviceRegistry()
  const deviceApi = createBrokerDeviceManagerApi({
    api,
    addonId: 'provider-ha',
    nodeId: 'hub',
    logger: log,
    eventBus: bus,
    registry,
    capabilityRegistry: new CapabilityRegistry(logger()),
    accessorySpawnRetryDelaysMs: delaysMs,
  })
  return {
    log,
    registry,
    calls,
    deviceApi,
    register: () => deviceApi.register(parentAsDevice(parent)),
    reprobe: async () => {
      const run = parent._kernelReprobe
      if (run === undefined) throw new Error('kernel did not wire _kernelReprobe')
      await run()
    },
  }
}

function parentAsDevice(parent: object): IDevice {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
  return parent as unknown as IDevice
}

function gaveUp(log: IScopedLogger): boolean {
  return vi
    .mocked(log.error)
    .mock.calls.some(
      ([message]) => message === 'Accessory child spawn gave up after the bounded retries',
    )
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i += 1) await new Promise((r) => setTimeout(r, 5))
}

describe('accessory spawn retry (D347 shape)', () => {
  it('a first spawn that fails is retried and the child lands; the failure is an ERROR naming the step', async () => {
    const w = failingWorld(1)
    await w.register()
    expect(w.registry.getById(KEEP_ID)).toBeNull()
    expect(w.log.error).toHaveBeenCalledWith(
      'Accessory child spawn failed',
      expect.objectContaining({
        tags: expect.objectContaining({ deviceId: KEEP_ID }),
        meta: expect.objectContaining({ step: 'applyInitialMeta' }),
      }),
    )
    await until(() => w.registry.getById(KEEP_ID) !== null)
    expect(w.registry.getById(KEEP_ID)?.stableId).toBe(KEEP_STABLE)
  })

  it('gives up after the bound, at ERROR', async () => {
    const w = failingWorld(99, 'loadRuntimeState')
    await w.register()
    await until(() => gaveUp(w.log))
    expect(w.log.error).toHaveBeenCalledWith(
      'Accessory child spawn gave up after the bounded retries',
      expect.objectContaining({ tags: expect.objectContaining({ deviceId: KEEP_ID }) }),
    )
    expect(w.registry.getById(KEEP_ID)).toBeNull()
  })

  it('a give-up sticks: a later reconcile does not restart the rounds', async () => {
    const w = failingWorld(99, 'loadRuntimeState')
    await w.register()
    await until(() => gaveUp(w.log))
    const before = w.calls.loadRuntimeState
    await w.reprobe()
    await new Promise((r) => setTimeout(r, 60))
    // The reprobe spawned once itself (+1); no new rounds followed it.
    expect(w.calls.loadRuntimeState).toBe((before ?? 0) + 1)
  })

  it('a parent removed during a pending retry never spawns the child', async () => {
    const w = failingWorld(1, 'applyInitialMeta', [40, 40])
    await w.register()
    await w.deviceApi.decommission(PARENT_ID)
    await new Promise((r) => setTimeout(r, 150))
    expect(w.calls.applyInitialMeta).toBe(1)
    expect(w.registry.getById(KEEP_ID)).toBeNull()
  })

  it('a permanently failing meta pre-seed still registers the child on the last attempt, with an ERROR naming the step', async () => {
    const w = failingWorld(99, 'applyInitialMeta')
    await w.register()
    await until(() => w.registry.getById(KEEP_ID) !== null)
    expect(w.registry.getById(KEEP_ID)?.stableId).toBe(KEEP_STABLE)
    expect(w.log.error).toHaveBeenCalledWith(
      'Accessory child spawned WITHOUT its meta pre-seed after the last retry',
      expect.objectContaining({
        tags: expect.objectContaining({ deviceId: KEEP_ID }),
        meta: expect.objectContaining({ step: 'applyInitialMeta' }),
      }),
    )
  })
})
