/**
 * A composed valve serves `setPosition` only while every member positions (#459):
 * the kernel derives `ValvePositionable` from the method being there, so the
 * composer registers it on the shared mode and re-registers when the mode moves.
 */
import {
  type DeviceBindingEntry,
  type DeviceContext,
  type IDeviceRuntimeState,
  DeviceFeature,
  DeviceType,
  deriveFeatureProvenance,
  implementedMethodsOf,
  valveCapability,
} from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { ComposedDevice } from '../composed-device.js'

function harness(): {
  device: ComposedDevice
  bound: () => DeviceBindingEntry[]
} {
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
  const device = new ComposedDevice(ctx, DeviceType.Valve, [])
  const methods = Object.keys(valveCapability.methods)
  return {
    device,
    bound: () =>
      [...live].map(
        ([capName, provider]): DeviceBindingEntry => ({
          capName,
          kind: 'native',
          nativeAddonId: 'composer',
          providerAddonId: 'composer',
          providerNodeId: 'hub',
          implementedMethods: implementedMethodsOf(methods, provider),
        }),
      ),
  }
}

const positionable = (entries: readonly DeviceBindingEntry[]): boolean =>
  deriveFeatureProvenance(entries).some(
    (d) => d.feature === DeviceFeature.ValvePositionable && d.present,
  )

describe('composed valve: ValvePositionable follows the shared mode', () => {
  it('registers setPosition only while the mode says every member positions', () => {
    const { device, bound } = harness()
    device.syncShared(['valve'], [])
    expect(positionable(bound())).toBe(false)
    device.syncShared(['valve'], [DeviceFeature.ValvePositionable])
    expect(positionable(bound())).toBe(true)
    device.syncShared(['valve'], [])
    expect(positionable(bound())).toBe(false)
  })
})
