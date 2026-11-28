/**
 * planning#710 — a composed device is UNKNOWN until its runtime's first verdict,
 * never offline-then-online: the 09:03Z restart notified every composed device
 * as a real outage. A withdrawn block's placeholder has no runtime and is
 * offline at once.
 */
import {
  type DeviceContext,
  type DeviceStatus,
  type IDeviceRuntimeState,
  DeviceType,
} from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { ComposedDevice, ComposedPlaceholderDevice } from '../composed-device.js'

function makeCtx(): DeviceContext {
  const live = new Map<string, object>()
  let runtime: IDeviceRuntimeState | null = null
  // The kernel's DeviceContext is far wider than the composer reads: the one documented spec boundary.
  const ctx = {
    id: 7,
    stableId: 'composed:7',
    parentDeviceId: null,
    deviceMeta: {
      id: 7,
      stableId: 'composed:7',
      addonId: 'composer',
      type: DeviceType.Valve,
      name: 'Valves',
      location: null,
      disabled: false,
      parentDeviceId: null,
      metadata: null,
    },
    persistedConfig: {},
    initialRuntimeState: {},
    eventBus: {
      emit: () => {},
      subscribe: () => () => {},
      getRecent: () => [],
    },
    persistConfig: async () => {},
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtime = rs
    },
    registerNativeCap: (cap: { name: string; runtimeState?: unknown }, provider: object) => {
      live.set(cap.name, provider)
      if (cap.runtimeState && runtime) {
        runtime.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    },
    unregisterNativeCap: (name: string) => {
      live.delete(name)
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
  return ctx
}

const statusOf = (device: ComposedDevice): DeviceStatus | undefined =>
  device.runtimeState.getCapState<DeviceStatus>('device-status')

describe('a composed device status at boot', () => {
  it('starts unknown, and the first verdict answers it even when it is offline', () => {
    const device = new ComposedDevice(makeCtx(), DeviceType.Valve, [])
    expect(statusOf(device)).toMatchObject({ unknown: true })
    device.setAvailable(false)
    const answered = statusOf(device)
    expect(answered?.online).toBe(false)
    expect(answered?.unknown).toBeUndefined()
  })

  it('available answers online', () => {
    const device = new ComposedDevice(makeCtx(), DeviceType.Valve, [])
    device.setAvailable(true)
    expect(statusOf(device)).toMatchObject({ online: true })
    expect(statusOf(device)?.unknown).toBeUndefined()
  })

  it('a withdrawn block placeholder is offline at once, not unknown', () => {
    const device = new ComposedPlaceholderDevice(makeCtx())
    expect(statusOf(device)).toMatchObject({ online: false })
    expect(statusOf(device)?.unknown).toBeUndefined()
  })
})
