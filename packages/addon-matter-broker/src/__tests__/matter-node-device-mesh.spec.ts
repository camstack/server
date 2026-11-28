/** A Matter node device registers the device-mesh capability, bound to its broker's fabric view. */
import type { DeviceContext, IDeviceRuntimeState } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { MatterNodeDevice } from '../devices/matter-node-device.js'

function nodeContext(registered: Map<string, object>): DeviceContext {
  let runtime: IDeviceRuntimeState | null = null
  const ctx = {
    id: 7,
    stableId: 'matter:b1:1',
    parentDeviceId: null,
    deviceMeta: {
      id: 7,
      stableId: 'matter:b1:1',
      addonId: 'matter-broker',
      type: 'container',
      name: 'node',
      location: null,
      disabled: false,
      parentDeviceId: null,
      metadata: null,
    },
    persistedConfig: { brokerId: 'b1', nodeId: '1' },
    initialRuntimeState: {},
    eventBus: { emit: () => {}, subscribe: () => () => {}, getRecent: () => [] },
    persistConfig: async () => {},
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtime = rs
    },
    registerNativeCap: (cap: { name: string; runtimeState?: unknown }, provider: object) => {
      registered.set(cap.name, provider)
      if (cap.runtimeState && runtime) {
        runtime.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => ctx.logger,
      withTags: () => ctx.logger,
    },
    api: { deviceManager: {}, deviceState: { getCapSlice: { query: async () => null } } },
  } as unknown as DeviceContext
  return ctx
}

describe('MatterNodeDevice device-mesh registration', () => {
  it('registers device-mesh with all four methods', () => {
    const registered = new Map<string, object>()
    new MatterNodeDevice(nodeContext(registered))
    const mesh = registered.get('device-mesh')
    expect(mesh).toBeDefined()
    expect(Object.keys(mesh ?? {}).sort()).toEqual([
      'getNodeDiagnostics',
      'getTopology',
      'readNow',
      'refresh',
    ])
  })
})
