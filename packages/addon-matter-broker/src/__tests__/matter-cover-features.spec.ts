/**
 * A cover declares `cover-stoppable` only when its `stop` does something real
 * (WindowCovering stopMotion). The HA export gates the stop control on it.
 *
 * Disarm: drop the feature from the device and these specs fail.
 */
import {
  type DeviceContext,
  DeviceFeature,
  DeviceType,
  type IDeviceRuntimeState,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { MatterEndpointDevice } from '../devices/matter-endpoint-device.js'

/** The kernel's DeviceContext is far wider than the device reads: the one documented spec boundary. */
function makeCtx(persistedConfig: Record<string, unknown>, type: DeviceType): DeviceContext {
  let runtime: IDeviceRuntimeState | null = null
  return {
    id: 7,
    stableId: 'stub:7',
    parentDeviceId: null,
    deviceMeta: {
      id: 7,
      stableId: 'stub:7',
      addonId: 'stub',
      type,
      name: 'Cover',
      location: null,
      disabled: false,
      parentDeviceId: null,
      metadata: null,
    },
    persistedConfig,
    initialRuntimeState: {},
    eventBus: { emit: () => {}, subscribe: () => () => {}, getRecent: () => [] },
    persistConfig: async () => {},
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtime = rs
    },
    registerNativeCap: (cap: { name: string; runtimeState?: unknown }) => {
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
      child() {
        return this
      },
      withTags() {
        return this
      },
    },
    api: {},
  } as unknown as DeviceContext
}

describe('MatterEndpointDevice features', () => {
  const base = { brokerId: 'b1', nodeId: '1', endpointId: 1 }

  it('a window covering declares cover-stoppable', () => {
    const device = new MatterEndpointDevice(
      makeCtx({ ...base, capabilities: ['cover'] }, DeviceType.Cover),
    )
    expect(device.features).toContain(DeviceFeature.CoverStoppable)
  })

  it('a switch does not', () => {
    const device = new MatterEndpointDevice(
      makeCtx({ ...base, capabilities: ['switch'] }, DeviceType.Switch),
    )
    expect(device.features).not.toContain(DeviceFeature.CoverStoppable)
  })
})
