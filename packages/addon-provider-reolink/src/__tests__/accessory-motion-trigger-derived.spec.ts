/**
 * The siren and the floodlight no longer hand-set `MotionTrigger` (#459): the
 * kernel derives it from the `motion-trigger` cap they register. The device
 * reports no features of its own, and the cap it registers implements
 * `setMotionTrigger`, so the derived list still carries the feature.
 *
 * Disarm: stop registering the motion-trigger cap (or its `setMotionTrigger`)
 * and the derived assertion fails; hand-set the feature again and the
 * "reports nothing" assertion fails.
 */
import {
  type DeviceBindingEntry,
  type DeviceContext,
  DeviceFeature,
  DeviceType,
  deriveFeatureProvenance,
  type IDeviceRuntimeState,
  implementedMethodsOf,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { FloodlightAccessory } from '../accessories/floodlight.js'
import { SirenAccessory } from '../accessories/siren.js'

interface Registered {
  readonly name: string
  readonly provider: object
}

function makeCtx(type: DeviceType, kind: string): { ctx: DeviceContext; registered: Registered[] } {
  const registered: Registered[] = []
  let runtime: IDeviceRuntimeState | null = null
  // The kernel's DeviceContext is far wider than the accessory reads: the one documented spec boundary.
  const ctx = {
    id: 9,
    stableId: 'stub:9',
    parentDeviceId: null,
    deviceMeta: {
      id: 9,
      stableId: 'stub:9',
      addonId: 'stub',
      type,
      name: 'Accessory',
      location: null,
      disabled: false,
      parentDeviceId: null,
      metadata: null,
    },
    persistedConfig: { kind, channel: 0 },
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
  return { ctx, registered }
}

function derivedFeatures(registered: readonly Registered[]): DeviceFeature[] {
  const entries = registered.map(
    (r): DeviceBindingEntry => ({
      capName: r.name,
      kind: 'native',
      nativeAddonId: 'reolink',
      providerAddonId: 'reolink',
      providerNodeId: 'hub',
      implementedMethods: implementedMethodsOf(['setMotionTrigger'], r.provider),
    }),
  )
  return deriveFeatureProvenance(entries)
    .filter((d) => d.present)
    .map((d) => d.feature)
}

const host = { name: 'Camera', ensureApi: async () => ({}) }

describe('reolink accessories: MotionTrigger is derived from the bound cap', () => {
  it('the siren reports no features itself and still derives MotionTrigger', () => {
    const { ctx, registered } = makeCtx(DeviceType.Siren, 'siren')
    const device = new SirenAccessory(ctx, host)
    expect(device.features).toEqual([])
    expect(derivedFeatures(registered)).toContain(DeviceFeature.MotionTrigger)
  })

  it('the floodlight reports no features itself and still derives MotionTrigger', () => {
    const { ctx, registered } = makeCtx(DeviceType.Light, 'floodlight')
    const device = new FloodlightAccessory(ctx, host)
    expect(device.features).toEqual([])
    expect(derivedFeatures(registered)).toContain(DeviceFeature.MotionTrigger)
  })
})
