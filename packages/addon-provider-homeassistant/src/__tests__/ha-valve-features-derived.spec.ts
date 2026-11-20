/**
 * A Home Assistant valve no longer lists `ValvePositionable` (#459): the child
 * registers `setPosition` only when the entity's `supported_features` has
 * SET_POSITION (4), and the kernel derives the feature from the bound `valve`
 * cap. The mapping carries the raw bitmask, not a feature list.
 *
 * Disarm: put the `valve` row back to `reported` and the derived assertions
 * fail; register `setPosition` unconditionally and the "no position" case fails.
 */
import {
  type DeviceBindingEntry,
  type DeviceContext,
  DeviceFeature,
  DeviceType,
  deriveFeatureProvenance,
  type IDeviceRuntimeState,
  implementedMethodsOf,
  settleDeviceFeatures,
  valveCapability,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { HaValveDevice } from '../devices/ha-valve-device.js'
import { mapHaEntityToCamStack } from '../ha-domain-mapping.js'

function makeValve(supportedFeatures: number | undefined): readonly DeviceBindingEntry[] {
  const registered: { name: string; provider: object }[] = []
  let runtime: IDeviceRuntimeState | null = null
  // The kernel's DeviceContext is far wider than the child reads: the one documented spec boundary.
  const ctx = {
    id: 5,
    stableId: 'ha:5',
    parentDeviceId: null,
    deviceMeta: {
      id: 5,
      stableId: 'ha:5',
      addonId: 'homeassistant',
      type: DeviceType.Valve,
      name: 'Valve',
      location: null,
      disabled: false,
      parentDeviceId: null,
      metadata: null,
    },
    persistedConfig: {
      brokerId: 'b',
      entityId: 'valve.main',
      capabilities: ['valve'],
      ...(supportedFeatures !== undefined ? { supportedFeatures } : {}),
    },
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
  new HaValveDevice(ctx)
  const methods = Object.keys(valveCapability.methods)
  return registered.map(
    (r): DeviceBindingEntry => ({
      capName: r.name,
      kind: 'native',
      nativeAddonId: 'homeassistant',
      providerAddonId: 'homeassistant',
      providerNodeId: 'hub',
      implementedMethods: implementedMethodsOf(methods, r.provider),
    }),
  )
}

function derived(entries: readonly DeviceBindingEntry[]): DeviceFeature[] {
  return deriveFeatureProvenance(entries)
    .filter((d) => d.present)
    .map((d) => d.feature)
}

describe('HA valve: ValvePositionable is derived from the bound cap', () => {
  it('SET_POSITION in supported_features: setPosition is served, the feature is derived', () => {
    const entries = makeValve(1 | 2 | 4 | 8)
    expect(derived(entries)).toContain(DeviceFeature.ValvePositionable)
    expect(settleDeviceFeatures(entries, [])).toContain(DeviceFeature.ValvePositionable)
  })

  it('no SET_POSITION: no setPosition, no feature', () => {
    const entries = makeValve(1 | 2 | 8)
    expect(derived(entries)).not.toContain(DeviceFeature.ValvePositionable)
    expect(settleDeviceFeatures(entries, [DeviceFeature.ValvePositionable])).not.toContain(
      DeviceFeature.ValvePositionable,
    )
  })

  it('no supported_features at all: not positionable', () => {
    expect(derived(makeValve(undefined))).not.toContain(DeviceFeature.ValvePositionable)
  })

  it('the mapping hands the child the bitmask and lists no feature', () => {
    const m = mapHaEntityToCamStack({
      domain: 'valve',
      deviceClass: null,
      attributes: { supported_features: 15 },
    })
    expect(m?.supportedFeatures).toBe(15)
    expect(m?.features).toBeUndefined()
  })
})
