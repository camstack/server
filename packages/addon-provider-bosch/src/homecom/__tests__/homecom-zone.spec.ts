import { describe, expect, it } from 'vitest'
import { DeviceType } from '@camstack/types'
import type { HomeComBridgeZone } from '../homecom-bridge.js'
import { bridgeSnapshot } from '../homecom-bridge-snapshot.js'
import { buildHomeComCandidates, homeComDeviceType } from '../homecom-discovery.js'
import { buildDiscoverables } from '../homecom-gateway.js'
import { zoneClimateSlice, zoneModeWrite, zoneTargetWrite } from '../homecom-zone.js'
import { k40Reading, setting } from './homecom-bridge-fixture.js'

const ZONE: HomeComBridgeZone = {
  id: 'zn1',
  userMode: setting('manual', { allowed: ['manual', 'clock'], writeable: true }),
  setpointTemp: 21,
  currentTemp: 20.5,
  manualTemp: setting(21, { min: 5, max: 30, writeable: true }),
}

function snapshotWith(zones: readonly HomeComBridgeZone[]) {
  return bridgeSnapshot({
    gatewayId: 'g1',
    deviceType: 'k40',
    reading: { ...k40Reading(), zones: [...zones] },
    logDrop: () => {},
    logTransientProbe: () => {},
  })
}

describe('HomeCom zone as a climate child (planning#741)', () => {
  it('reads the zone as one projection: mode, target, limits and room temperature', () => {
    expect(zoneClimateSlice(ZONE, 5)).toMatchObject({
      mode: 'heat',
      availableModes: ['heat', 'auto'],
      target: 21,
      currentTemp: 20.5,
      minTemp: 5,
      maxTemp: 30,
      lastFetchedAt: 5,
    })
    const clock = { ...ZONE, userMode: setting('clock', { allowed: ['manual', 'clock'] }) }
    expect(zoneClimateSlice(clock, 5)?.mode).toBe('auto')
  })

  it('reads a zone whose mode was refused as unknown, never as off (D393)', () => {
    const onlyTemperature: HomeComBridgeZone = {
      id: 'zn1',
      userMode: null,
      setpointTemp: null,
      currentTemp: 20.5,
      manualTemp: null,
    }
    expect(zoneClimateSlice(onlyTemperature, 5)).toBeNull()
  })

  it('writes the mode through the token the zone lists, and refuses one it does not', () => {
    expect(zoneModeWrite(ZONE, 'auto')).toEqual({
      op: 'zoneUserMode',
      circuitId: 'zn1',
      value: 'clock',
    })
    expect(zoneModeWrite(ZONE, 'heat')).toEqual({
      op: 'zoneUserMode',
      circuitId: 'zn1',
      value: 'manual',
    })
    expect(() => zoneModeWrite(ZONE, 'cool')).toThrow(/not an accepted value/)
  })

  it('writes the manual temperature inside the limits, and only in manual mode', () => {
    expect(zoneTargetWrite(ZONE, 22)).toEqual({
      op: 'zoneManualTemp',
      circuitId: 'zn1',
      value: 22,
    })
    expect(() => zoneTargetWrite(ZONE, 40)).toThrow(/outside/)
    const clock = { ...ZONE, userMode: setting('clock', { allowed: ['manual', 'clock'] }) }
    expect(() => zoneTargetWrite(clock, 22)).toThrow(/manual/)
  })

  it('offers the zone as a child of the heat pump only when a zone value was readable', () => {
    const withZone = buildDiscoverables(snapshotWith([ZONE]))
    const hp = withZone.find((d) => d.kind === 'heat-pump')
    expect(hp?.children?.map((c) => [c.nativeId, c.kind, c.circuitId])).toContainEqual([
      'zone:zn1',
      'zone',
      'zn1',
    ])
    const without = buildDiscoverables(snapshotWith([]))
    expect(
      without.find((d) => d.kind === 'heat-pump')?.children?.some((c) => c.kind === 'zone'),
    ).toBe(false)
  })

  it('is a climate device when discovered', () => {
    expect(homeComDeviceType('zone')).toBe(DeviceType.Climate)
    const [candidate] = buildHomeComCandidates({
      devices: [
        { nativeId: 'zone:zn1', name: 'Zone configuration', kind: 'zone', circuitId: 'zn1' },
      ],
      adopted: new Map(),
    })
    expect(candidate).toMatchObject({ type: DeviceType.Climate, capabilities: ['climate-control'] })
  })
})
