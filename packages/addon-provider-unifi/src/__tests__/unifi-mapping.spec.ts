/**
 * The features an infra device fans out into offer only what the client can do (planning#581,
 * #583): no LED switch; one device per PoE-capable port, whose PoE switch is offered only when a
 * local account can switch it, and no power-cycle (a restart through PoE is the powered device's
 * `power-source`); the per-port switch + power-cycle button it replaced are retired.
 */
import { describe, expect, it } from 'vitest'
import type { UnifiFeatureDescriptor } from '../config.js'
import {
  buildInfraFeatures,
  capsForDescriptor,
  featuresEqual,
  mergeInfraFeatures,
  portLabel,
  portNameWrite,
} from '../unifi-mapping.js'
import { infraSnapshot, port } from './unifi-fixtures.js'

const SWITCH = infraSnapshot({
  id: 'sw1',
  name: 'marker-switch',
  model: 'USW-Lite-8-PoE',
  kind: 'switch',
  cpuPercent: 5,
  memoryPercent: null,
  cpuTempC: 40,
  uptimeSec: 100,
  ports: [port({ idx: 1 }), port({ idx: 2, poeCapable: false }), port({ idx: 3 })],
})

describe('buildInfraFeatures', () => {
  it('offers no LED switch', () => {
    const features = buildInfraFeatures(SWITCH)
    expect(features.some((f) => f.kind === 'switch')).toBe(false)
  })

  it('one port device per PoE-capable port — a non-PoE port is not a device', () => {
    const ports = buildInfraFeatures(SWITCH).filter((f) => f.kind === 'port')
    expect(ports.map((f) => f.portIdx)).toEqual([1, 3])
  })

  it("offers no restart button: the restart is the device's own workload.restart", () => {
    expect(buildInfraFeatures(SWITCH).some((f) => f.kind === 'button')).toBe(false)
  })

  it('without a local account a port is still a switch (power cycle only), with its power and link', () => {
    const [first] = buildInfraFeatures(SWITCH).filter((f) => f.kind === 'port')
    expect(first).toEqual({ kind: 'port', portIdx: 1, switchable: false })
    expect(first === undefined ? [] : capsForDescriptor(first)).toEqual([
      'switch',
      'power-meter',
      'network-link',
    ])
  })

  it('with a local account the port offers the PoE switch', () => {
    const [first] = buildInfraFeatures({
      ...SWITCH,
      poeSwitchable: true,
    }).filter((f) => f.kind === 'port')
    expect(first === undefined ? [] : capsForDescriptor(first)).toEqual([
      'switch',
      'power-meter',
      'network-link',
    ])
  })
})

describe('mergeInfraFeatures', () => {
  const legacy: UnifiFeatureDescriptor[] = [
    { kind: 'switch', switchFeature: 'poe', portIdx: 1 },
    { kind: 'button', buttonAction: 'power-cycle', portIdx: 1 },
    { kind: 'switch', switchFeature: 'led' },
  ]

  it('retires the per-port switch + power-cycle button the port device replaced', () => {
    const next = mergeInfraFeatures(legacy, buildInfraFeatures(SWITCH))
    expect(next.some((f) => f.kind === 'switch')).toBe(false)
    expect(next.some((f) => f.kind === 'button' && f.buttonAction === 'power-cycle')).toBe(false)
    expect(next.filter((f) => f.kind === 'port').map((f) => f.portIdx)).toEqual([1, 3])
  })

  it('a port whose switchability changed is a change (the switch cap appears)', () => {
    const before = buildInfraFeatures(SWITCH)
    const after = mergeInfraFeatures(before, buildInfraFeatures({ ...SWITCH, poeSwitchable: true }))
    expect(featuresEqual(before, after)).toBe(false)
  })

  it('a port missing from one poll is kept (a read that did not answer)', () => {
    const before = buildInfraFeatures(SWITCH)
    const next = mergeInfraFeatures(before, buildInfraFeatures({ ...SWITCH, ports: [] }))
    expect(next.filter((f) => f.kind === 'port').map((f) => f.portIdx)).toEqual([1, 3])
  })
})

describe('port names', () => {
  it('"<client> (port N)" when the client is known, else "Port N"', () => {
    expect(portLabel(3, 'marker-camera')).toBe('marker-camera (port 3)')
    expect(portLabel(3, null)).toBe('Port 3')
  })

  const base = {
    desiredName: 'marker-camera (port 3)',
    portIdx: 3,
    stableId: 'sid',
  }

  it.each([
    ['Port 3', true],
    ['Port 3 PoE', true],
    ['old-client (port 3)', true],
    ['sid', true],
  ])('an automatic name (%s) follows the client', (currentName, userNamed) => {
    expect(portNameWrite({ ...base, currentName, userNamed })).toEqual({
      kind: 'rename',
      name: 'marker-camera (port 3)',
      stampUserNamed: true,
    })
  })

  it('an operator rename is kept', () => {
    expect(portNameWrite({ ...base, currentName: 'Garage camera', userNamed: true })).toEqual({
      kind: 'keep',
    })
  })
})
