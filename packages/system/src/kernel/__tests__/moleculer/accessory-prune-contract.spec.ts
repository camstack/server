/**
 * The accessory prune contract (D49, 2026-10-21), through the real kernel
 * reconcile (`createBrokerDeviceManagerApi().register` → probe → reconcile):
 * a child is deleted ONLY as the result of a SUCCESSFUL read, and a shrink
 * only when a successful read of a LATER probe agrees. Dreame without
 * credentials answered only its core child and the kernel deleted 97
 * accessories.
 */
import type {
  AccessoryChildrenAnswer,
  AccessoryChildSpec,
  AddonApi,
  DeviceType,
  IDevice,
  IEventBus,
  IScopedLogger,
} from '@camstack/types'
import { accessoryChildrenComplete, accessoryChildrenUnknown } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '../../capability-registry.js'
import { DeviceRegistry } from '../../device-registry.js'
import { AccessoryShrinkGate, classifyAccessoryRead } from '../../moleculer/accessory-prune-gate.js'
import { createBrokerDeviceManagerApi } from '../../moleculer/device-cap-proxy.js'

const PARENT_ID = 7100
const KEEP_ID = 7101
const GONE_ID = 7102
const PARENT_STABLE = 'dreame-container-x'
const KEEP_STABLE = `${PARENT_STABLE}-vacuum`
const GONE_STABLE = `${PARENT_STABLE}-sensor-battery`

let nextId = 8000

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

const bus: IEventBus = { emit: () => {}, subscribe: () => () => {}, getRecent: () => [] }

function childDevice(ctx: { id: number; stableId: string }): IDevice {
  const device = {
    id: ctx.id,
    stableId: ctx.stableId,
    parentDeviceId: null,
    type: 'sensor',
    name: ctx.stableId,
    online: true,
    features: [],
    config: { values: {}, get: () => undefined, set: async () => {}, setAll: async () => {} },
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

/** A parent whose online flag, answer and probe the test drives. */
function parentWorld() {
  let probedAt = 0
  const subscribers = new Set<(s: unknown) => void>()
  const state = {
    online: true,
    answer: (): AccessoryChildrenAnswer => [spec('vacuum')],
  }
  const runtimeState = {
    getCapState: (cap: string) =>
      cap === 'feature-probe' ? { lastProbedAt: probedAt } : undefined,
    subscribeCap: (cap: string, cb: (s: unknown) => void) => {
      if (cap === 'feature-probe') subscribers.add(cb)
      return () => subscribers.delete(cb)
    },
  }
  const parent = {
    id: PARENT_ID,
    stableId: PARENT_STABLE,
    parentDeviceId: null,
    type: 'container',
    name: 'Robot',
    get online(): boolean {
      return state.online
    },
    features: [],
    config: { values: {}, get: () => undefined, set: async () => {}, setAll: async () => {} },
    runtimeState,
    removeDevice: async () => {},
    getSettingsUISchema: () => ({ sections: [] }),
    applySettingsPatch: async () => {},
    // Every probe completes with a strictly later stamp.
    onProbe: async () => {
      probedAt += 1
      for (const cb of subscribers) cb({ lastProbedAt: probedAt })
    },
    getAccessoryChildren: () => state.answer(),
    _kernelReprobe: undefined as undefined | (() => Promise<void>),
  }

  const removed: number[] = []
  const api = {
    deviceManager: new Proxy({} as Record<string, unknown>, {
      get(_t, method) {
        if (typeof method !== 'string') return undefined
        const handler = vi.fn(async (input: unknown) => {
          if (method === 'allocateDeviceId') {
            const stableId: unknown = Reflect.get(Object(input), 'stableId')
            if (stableId === KEEP_STABLE) return { id: KEEP_ID }
            if (stableId === GONE_STABLE) return { id: GONE_ID }
            return { id: nextId++ }
          }
          if (method === 'loadMeta') return null
          if (method === 'loadRuntimeState') return {}
          if (method === 'loadConfig') return {}
          if (method === 'getChildren') {
            return [
              { id: KEEP_ID, stableId: KEEP_STABLE, name: 'Vacuum', linkDeviceId: PARENT_ID },
              { id: GONE_ID, stableId: GONE_STABLE, name: 'Battery', linkDeviceId: PARENT_ID },
            ]
          }
          if (method === 'removeDevice') {
            const id: unknown = Reflect.get(Object(input), 'deviceId')
            if (typeof id === 'number') removed.push(id)
          }
          return undefined
        })
        return { mutate: handler, query: handler }
      },
    }),
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
  } as unknown as AddonApi

  const deviceApi = createBrokerDeviceManagerApi({
    api,
    addonId: 'provider-dreame',
    nodeId: 'hub',
    logger: logger(),
    eventBus: bus,
    registry: new DeviceRegistry(),
    capabilityRegistry: new CapabilityRegistry(logger()),
  })

  return {
    state,
    removed,
    register: async () => {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
      await deviceApi.register(parent as unknown as IDevice)
    },
    /** A later probe + reconcile, the way `device.reprobe()` runs it. */
    reprobe: async () => {
      const run = parent._kernelReprobe
      if (run === undefined) throw new Error('kernel did not wire _kernelReprobe')
      await run()
    },
  }
}

describe('accessory prune contract — through the kernel reconcile', () => {
  it('credentials missing (the provider answers unknown) deletes nothing, however many probes run', async () => {
    const w = parentWorld()
    w.state.answer = () => accessoryChildrenUnknown('no credentials')
    await w.register()
    await w.reprobe()
    await w.reprobe()
    expect(w.removed).toEqual([])
  })

  it('a disconnected parent answering a partial plain list deletes nothing', async () => {
    const w = parentWorld()
    w.state.online = false
    await w.register()
    await w.reprobe()
    await w.reprobe()
    expect(w.removed).toEqual([])
  })

  it('a genuine removal is deleted only after a successful read of a LATER probe agrees', async () => {
    const w = parentWorld()
    await w.register()
    // First successful read lacking the battery child: kept, recorded.
    expect(w.removed).toEqual([])
    await w.reprobe()
    expect(w.removed).toEqual([GONE_ID])
  })

  it('an unknown read between two complete reads neither confirms nor cancels the shrink', async () => {
    const w = parentWorld()
    w.state.answer = () => accessoryChildrenComplete([spec('vacuum')])
    await w.register()
    w.state.answer = () => accessoryChildrenUnknown('cloud not connected')
    await w.reprobe()
    expect(w.removed).toEqual([])
    w.state.answer = () => accessoryChildrenComplete([spec('vacuum')])
    await w.reprobe()
    expect(w.removed).toEqual([GONE_ID])
  })

  it('a child that comes back on the next read is never deleted', async () => {
    const w = parentWorld()
    await w.register()
    w.state.answer = () => [spec('vacuum'), spec('sensor-battery')]
    await w.reprobe()
    w.state.answer = () => [spec('vacuum')]
    await w.reprobe()
    // Missing again, for the first time since it came back: still kept.
    expect(w.removed).toEqual([])
  })
})

describe('accessory prune gate', () => {
  it('a plain list is successful only while the parent is online and probed', () => {
    const list = [spec('a')]
    expect(classifyAccessoryRead(list, { online: true, probedAt: 3 }).kind).toBe('successful')
    expect(classifyAccessoryRead(list, { online: false, probedAt: 3 }).kind).toBe('unknown')
    expect(classifyAccessoryRead(list, { online: true, probedAt: 0 }).kind).toBe('unknown')
    expect(
      classifyAccessoryRead(accessoryChildrenUnknown('x'), { online: true, probedAt: 3 }),
    ).toEqual({ kind: 'unknown', reason: 'x', children: [] })
  })

  it('the same probe read twice never confirms a shrink', () => {
    const gate = new AccessoryShrinkGate()
    expect(gate.decide([5], 2)).toEqual({ prune: [], deferred: [5] })
    expect(gate.decide([5], 2)).toEqual({ prune: [], deferred: [5] })
    expect(gate.decide([5], 3)).toEqual({ prune: [5], deferred: [] })
  })
})
