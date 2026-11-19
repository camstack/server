/**
 * A failed accessory-child spawn is retried, bounded (the D347 shape), through
 * the real kernel reconcile; the failure is an ERROR naming the step and the
 * board turns "binding not yet" into a typed reason.
 */
import type {
  AccessoryChildSpec,
  AddonApi,
  DeviceType,
  IDevice,
  IEventBus,
  IScopedLogger,
} from '@camstack/types'
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

import { AccessorySpawnBoard } from '../../moleculer/accessory-spawn-retry.js'

/** Parent with ONE accessory whose first `applyInitialMeta` dial fails. */
function failingWorld(failures: number) {
  let fail = failures
  const board = new AccessorySpawnBoard()
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
  }
  const api = {
    deviceManager: new Proxy({} as Record<string, unknown>, {
      get(_t, method) {
        if (typeof method !== 'string') return undefined
        const handler = vi.fn(async () => {
          if (method === 'allocateDeviceId') return { id: KEEP_ID }
          if (method === 'applyInitialMeta' && fail > 0) {
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
    accessorySpawnBoard: board,
    accessorySpawnRetryDelaysMs: [5, 5],
  })
  return {
    board,
    log,
    registry,
    register: () => deviceApi.register(parentAsDevice(parent)),
  }
}

function parentAsDevice(parent: object): IDevice {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
  return parent as unknown as IDevice
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i += 1) await new Promise((r) => setTimeout(r, 5))
}

describe('accessory spawn retry (D347 shape)', () => {
  it('a first spawn that fails is retried and the child lands; the failure is an ERROR naming the step', async () => {
    const w = failingWorld(1)
    await w.register()
    expect(w.registry.getById(KEEP_ID)).toBeNull()
    expect(w.board.describe(KEEP_ID)).toMatch(
      /accessory child failed to spawn: applyInitialMeta: dial timed out, retry 0\/2/,
    )
    expect(w.log.error).toHaveBeenCalledWith(
      'Accessory child spawn failed',
      expect.objectContaining({
        tags: expect.objectContaining({ deviceId: KEEP_ID }),
        meta: expect.objectContaining({ step: 'applyInitialMeta' }),
      }),
    )
    await until(() => w.registry.getById(KEEP_ID) !== null)
    expect(w.registry.getById(KEEP_ID)?.stableId).toBe(KEEP_STABLE)
    expect(w.board.describe(KEEP_ID)).toBeNull()
  })

  it('gives up after the bound, at ERROR, and the board says so', async () => {
    const w = failingWorld(99)
    await w.register()
    await until(() => w.board.get(KEEP_ID)?.terminal === true)
    expect(w.board.describe(KEEP_ID)).toMatch(/retry 2\/2, gave up/)
    expect(w.log.error).toHaveBeenCalledWith(
      'Accessory child spawn gave up after the bounded retries',
      expect.objectContaining({
        tags: expect.objectContaining({ deviceId: KEEP_ID }),
      }),
    )
    expect(w.registry.getById(KEEP_ID)).toBeNull()
  })
})
