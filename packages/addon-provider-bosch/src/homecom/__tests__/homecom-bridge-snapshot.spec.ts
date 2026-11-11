import { describe, expect, it } from 'vitest'
import type { HomeComBridgeHeatingCircuit, HomeComBridgeReading } from '../homecom-bridge.js'
import { bridgeSetpointWrite, bridgeSnapshot } from '../homecom-bridge-snapshot.js'
import { k40Reading, setting } from './homecom-bridge-fixture.js'

/**
 * A heating circuit's temperature is the operator's hand-set room setpoint, with the limits
 * the gateway reports (5..30 on the live K40); hot water is driven by modes.
 */

function snapshotOf(reading: HomeComBridgeReading) {
  return bridgeSnapshot({
    gatewayId: 'g1',
    deviceType: 'k40',
    reading,
    logDrop: () => {},
    logTransientProbe: () => {},
  })
}

function withHc(patch: Partial<HomeComBridgeHeatingCircuit>): HomeComBridgeReading {
  const r = k40Reading()
  return { ...r, heatingCircuits: r.heatingCircuits.map((c) => ({ ...c, ...patch })) }
}

const AUTO: Partial<HomeComBridgeHeatingCircuit> = {
  operationMode: setting('auto', { allowed: ['off', 'manual', 'auto'], writeable: true }),
  currentRoomSetpoint: setting(19),
  comfortSetpoint: setting(22, { min: 15, max: 28, writeable: true }),
  ecoSetpoint: setting(19, { min: 10, max: 25, writeable: true }),
}

describe('HomeCom heating circuit setpoint (bridge)', () => {
  it('in manual mode exposes the manual room setpoint with the limits the gateway reports', () => {
    const [hc] = snapshotOf(k40Reading()).circuits
    expect(hc).toMatchObject({ setpoint: 30, minTemp: 5, maxTemp: 30 })
    expect(bridgeSetpointWrite(k40Reading(), 'hc1', 21)).toEqual({
      op: 'hcManualRoomSetpoint',
      circuitId: 'hc1',
      value: 21,
    })
  })

  it('reports no limits, and refuses a write, when the gateway states none', () => {
    const reading = withHc({ manualRoomSetpoint: setting(30, { writeable: true }) })
    const [hc] = snapshotOf(reading).circuits
    expect(hc?.minTemp).toBeNull()
    expect(hc?.maxTemp).toBeNull()
    expect(() => bridgeSetpointWrite(reading, 'hc1', 21)).toThrow(/no limits/)
  })

  it('in auto mode writes the level the circuit runs on now, within that level’s limits', () => {
    const eco = withHc(AUTO)
    expect(snapshotOf(eco).circuits[0]).toMatchObject({ setpoint: 19, minTemp: 10, maxTemp: 25 })
    expect(bridgeSetpointWrite(eco, 'hc1', 18)).toEqual({
      op: 'hcEcoSetpoint',
      circuitId: 'hc1',
      value: 18,
    })
    const comfort = withHc({ ...AUTO, currentRoomSetpoint: setting(22) })
    expect(bridgeSetpointWrite(comfort, 'hc1', 23)).toEqual({
      op: 'hcComfortSetpoint',
      circuitId: 'hc1',
      value: 23,
    })
  })

  it('in auto mode refuses when the active level cannot be told from the reading', () => {
    const neither = withHc({ ...AUTO, currentRoomSetpoint: setting(20.5) })
    expect(() => bridgeSetpointWrite(neither, 'hc1', 21)).toThrow(/active level/)
    const both = withHc({
      ...AUTO,
      ecoSetpoint: setting(22, { min: 10, max: 25, writeable: true }),
      currentRoomSetpoint: setting(22),
    })
    expect(() => bridgeSetpointWrite(both, 'hc1', 21)).toThrow(/active level/)
    expect(snapshotOf(both).circuits[0]).toMatchObject({ minTemp: null, maxTemp: null })
  })
})

describe('HomeCom hot water (bridge) is mode-driven', () => {
  it('offers only the modes the gateway lists, and the level limits it reports', () => {
    const dhw = snapshotOf(k40Reading()).dhw
    expect(dhw).toMatchObject({
      availableModes: ['Off', 'low', 'high', 'ownprogram', 'eco'],
      targetTemp: 51,
      minTemp: 30,
      maxTemp: 60,
    })
  })

  it('invents no mode and no limit the gateway did not state', () => {
    const r = k40Reading()
    const bare: HomeComBridgeReading = {
      ...r,
      dhwCircuits: r.dhwCircuits.map((c) => ({
        ...c,
        operationMode: setting('eco'),
        temperatureLevels: { eco: setting(51) },
      })),
    }
    expect(snapshotOf(bare).dhw).toMatchObject({
      availableModes: [],
      minTemp: null,
      maxTemp: null,
    })
  })
})
