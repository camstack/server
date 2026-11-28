/**
 * A camera booted with a cached PTZ + autotrack probe exposes the `ptz` and
 * `ptz-autotrack` caps BEFORE any probe has run (#459). The kernel derives
 * PanTiltZoom / PtzAutotrack from those caps, so without boot registration the
 * features would vanish after a restart until the first probe.
 *
 * Disarm: remove the boot registration in `registerNativeCapabilities` and the
 * cached-probe case fails.
 */
import {
  type DeviceBindingEntry,
  type DeviceContext,
  DeviceFeature,
  DeviceType,
  deriveFeatureProvenance,
  type IDeviceRuntimeState,
  implementedMethodsOf,
} from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { HikvisionCamera } from '../hikvision-camera.js'

interface Registered {
  readonly name: string
  readonly provider: object
}

function bootCamera(deviceCache: object): Registered[] {
  const registered: Registered[] = []
  let runtime: IDeviceRuntimeState | null = null
  // The kernel's DeviceContext is far wider than the camera's constructor reads: the one documented spec boundary.
  const ctx = {
    id: 7,
    stableId: 'stub:7',
    parentDeviceId: null,
    deviceMeta: {
      id: 7,
      stableId: 'stub:7',
      addonId: 'stub',
      type: DeviceType.Camera,
      name: 'Camera',
      location: null,
      disabled: false,
      parentDeviceId: null,
      metadata: null,
    },
    persistedConfig: {
      host: '192.0.2.10',
      port: 80,
      username: 'admin',
      password: 'x',
      deviceCache,
    },
    initialRuntimeState: {},
    eventBus: { emit: () => {}, subscribe: () => () => {}, getRecent: () => [] },
    persistConfig: async () => {},
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtime = rs
    },
    registerNativeCap: (cap: { name: string; runtimeState?: unknown }, provider: object) => {
      registered.push({ name: cap.name, provider })
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
  new HikvisionCamera(ctx)
  return registered
}

function names(registered: readonly Registered[]): string[] {
  return registered.map((r) => r.name)
}

describe('HikvisionCamera boot: PTZ caps from the persisted probe', () => {
  it('registers ptz and ptz-autotrack once, and the kernel derives both features', () => {
    const registered = bootCamera({ hasPtz: true, hasAutotrack: true })
    expect(names(registered).filter((n) => n === 'ptz')).toHaveLength(1)
    expect(names(registered).filter((n) => n === 'ptz-autotrack')).toHaveLength(1)
    const entries = registered.map(
      (r): DeviceBindingEntry => ({
        capName: r.name,
        kind: 'native',
        nativeAddonId: 'hikvision',
        providerAddonId: 'hikvision',
        providerNodeId: 'hub',
        implementedMethods: implementedMethodsOf([], r.provider),
      }),
    )
    const present = deriveFeatureProvenance(entries)
      .filter((d) => d.present)
      .map((d) => d.feature)
    expect(present).toContain(DeviceFeature.PanTiltZoom)
    expect(present).toContain(DeviceFeature.PtzAutotrack)
  })

  it('registers neither cap when the cache has no PTZ', () => {
    const registered = bootCamera({})
    expect(names(registered)).not.toContain('ptz')
    expect(names(registered)).not.toContain('ptz-autotrack')
  })
})
