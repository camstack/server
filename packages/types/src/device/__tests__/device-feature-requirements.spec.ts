import { describe, expect, it } from 'vitest'
import { ALL_CAPABILITY_DEFINITIONS } from '../../generated/capability-router-map.js'
import type { DeviceBindingEntry } from '../device-binding.js'
import {
  DEVICE_FEATURE_REQUIREMENTS,
  deriveFeatureProvenance,
  implementedMethodsOf,
  reconcileReportedFeatures,
  settleDeviceFeatures,
} from '../device-feature-requirements.js'
import { DeviceFeature } from '../device-type.js'

function entry(capName: string, implementedMethods?: string[]): DeviceBindingEntry {
  return {
    capName,
    kind: 'native',
    providerAddonId: 'prov',
    providerNodeId: 'hub',
    nativeAddonId: 'prov',
    ...(implementedMethods !== undefined ? { implementedMethods } : {}),
  }
}

describe('DEVICE_FEATURE_REQUIREMENTS against the cap definitions', () => {
  it('names a real cap and real methods for every cap-backed feature', () => {
    const caps = new Map(ALL_CAPABILITY_DEFINITIONS.map((cap) => [cap.name, cap]))
    for (const [feature, req] of Object.entries(DEVICE_FEATURE_REQUIREMENTS)) {
      if (req.kind !== 'cap') continue
      const cap = caps.get(req.cap)
      expect(cap, `${feature} -> cap ${req.cap}`).toBeDefined()
      for (const name of req.methods) {
        expect(Object.keys(cap?.methods ?? {}), `${feature} -> ${req.cap}.${name}`).toContain(name)
      }
    }
  })

  it('a method-level feature only asks for methods the cap lets a provider omit', () => {
    const caps = new Map(ALL_CAPABILITY_DEFINITIONS.map((cap) => [cap.name, cap]))
    for (const feature of [
      DeviceFeature.CoverTilt,
      DeviceFeature.CoverStoppable,
      DeviceFeature.CoverPositionable,
      DeviceFeature.ClimateFanMode,
      DeviceFeature.FanSpeed,
      DeviceFeature.LockOpen,
      DeviceFeature.MediaPlayerSeek,
      DeviceFeature.MediaPlayerPower,
    ]) {
      const req = DEVICE_FEATURE_REQUIREMENTS[feature]
      expect(req.kind).toBe('cap')
      if (req.kind !== 'cap') continue
      for (const name of req.methods) {
        expect(caps.get(req.cap)?.methods[name]?.providerOptional, `${req.cap}.${name}`).toBe(true)
      }
    }
  })
})

describe('deriveFeatureProvenance', () => {
  it('a bound cap whose provider implements the method makes the feature present, with its supplier', () => {
    const found = deriveFeatureProvenance([
      entry('cover', ['open', 'close', 'setTiltPosition']),
    ]).find((item) => item.feature === DeviceFeature.CoverTilt)
    expect(found?.present).toBe(true)
    expect(found?.supplier).toEqual({
      cap: 'cover',
      providerAddonId: 'prov',
      providerNodeId: 'hub',
    })
  })

  it('a bound cap whose provider lacks the method names the missing method', () => {
    const found = deriveFeatureProvenance([entry('cover', ['open', 'close'])]).find(
      (item) => item.feature === DeviceFeature.CoverTilt,
    )
    expect(found?.present).toBe(false)
    expect(found?.missing).toEqual({
      reason: 'methods-not-implemented',
      cap: 'cover',
      methods: ['setTiltPosition'],
    })
  })

  it('an unbound cap names the cap', () => {
    const found = deriveFeatureProvenance([]).find(
      (item) => item.feature === DeviceFeature.Rebootable,
    )
    expect(found?.missing).toEqual({ reason: 'cap-not-bound', cap: 'reboot' })
  })

  it('an absent implemented set (older worker) counts as every method', () => {
    const found = deriveFeatureProvenance([entry('cover')]).find(
      (item) => item.feature === DeviceFeature.CoverTilt,
    )
    expect(found?.present).toBe(true)
  })
})

describe('settleDeviceFeatures', () => {
  it('takes derived features from the bindings and ignores the driver claim for them', () => {
    const out = settleDeviceFeatures(
      [entry('reboot')],
      [DeviceFeature.PanTiltZoom, DeviceFeature.Rebootable],
    )
    expect(out).toContain(DeviceFeature.Rebootable)
    expect(out).not.toContain(DeviceFeature.PanTiltZoom)
  })

  it('keeps the driver claim for a feature still reported, and drops unknown strings', () => {
    const out = settleDeviceFeatures(
      [],
      [DeviceFeature.BatteryOperated, DeviceFeature.CoverTilt, 'bogus'],
    )
    expect(out).toContain(DeviceFeature.BatteryOperated)
    expect(out).toContain(DeviceFeature.CoverTilt)
    expect(out).not.toContain('bogus')
  })
})

describe('reconcileReportedFeatures', () => {
  it('a re-register keeps the stored derived features and takes the rest from the driver', () => {
    const out = reconcileReportedFeatures(
      [DeviceFeature.Rebootable, DeviceFeature.BatteryOperated],
      [DeviceFeature.PanTiltZoom, DeviceFeature.CoverTilt],
    )
    expect(out.toSorted()).toEqual([DeviceFeature.CoverTilt, DeviceFeature.Rebootable].toSorted())
  })

  it('a first registration takes the driver list as is', () => {
    expect(reconcileReportedFeatures(undefined, [DeviceFeature.PanTiltZoom])).toEqual([
      DeviceFeature.PanTiltZoom,
    ])
  })
})

describe('implementedMethodsOf', () => {
  it('lists the methods the object has, including prototype methods', () => {
    class Provider {
      open(): void {}
    }
    expect(implementedMethodsOf(['open', 'setTiltPosition'], new Provider())).toEqual(['open'])
  })
})
