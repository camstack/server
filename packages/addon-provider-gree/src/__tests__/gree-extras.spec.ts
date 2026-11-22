import { DeviceType, DeviceRole } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  GREE_EXTRA_COLUMNS,
  GREE_TEMP_OFFSET,
  greeClimateAction,
  greeErrorReading,
  parseGreeExtras,
  planGreeSensorChildren,
} from '../gree-extras.js'

describe('parseGreeExtras', () => {
  it('a unit without an outdoor probe (raw 0) has no outdoor reading, never -40', () => {
    expect(parseGreeExtras({ OutEnvTem: 0, Defrost: 0, AllErr: 0 }).outdoorTemp).toBeNull()
  })

  it('asks for the three columns nobody read before', () => {
    expect([...GREE_EXTRA_COLUMNS]).toEqual(['OutEnvTem', 'Defrost', 'AllErr'])
  })

  it('removes the +40 offset from the outdoor temperature', () => {
    expect(GREE_TEMP_OFFSET).toBe(40)
    expect(parseGreeExtras({ OutEnvTem: 46, Defrost: 0, AllErr: 0 })).toEqual({
      outdoorTemp: 6,
      defrost: false,
      errorCode: 0,
    })
  })

  it('reads defrost 1 as active and a non-zero AllErr as the code', () => {
    const x = parseGreeExtras({ OutEnvTem: 40, Defrost: 1, AllErr: 7 })
    expect(x.defrost).toBe(true)
    expect(x.errorCode).toBe(7)
    expect(x.outdoorTemp).toBe(0)
  })

  it('a column the unit did not answer is null, never 0', () => {
    expect(parseGreeExtras({})).toEqual({ outdoorTemp: null, defrost: null, errorCode: null })
    expect(parseGreeExtras({ OutEnvTem: Number.NaN })).toMatchObject({ outdoorTemp: null })
  })
})

describe('greeClimateAction', () => {
  it('power off is off, defrost is idle, otherwise unknown', () => {
    expect(greeClimateAction({ power: false, defrost: true })).toBe('off')
    expect(greeClimateAction({ power: true, defrost: true })).toBe('idle')
    expect(greeClimateAction({ power: true, defrost: false })).toBeNull()
    expect(greeClimateAction({ power: true, defrost: null })).toBeNull()
  })
})

describe('greeErrorReading', () => {
  it('a column the unit did not answer is unknown, never "no fault"', () => {
    expect(greeErrorReading(null, 5)).toMatchObject({ active: null, code: null, lastFetchedAt: 5 })
  })

  it('0 is a clean reading', () => {
    expect(greeErrorReading(0, 5)).toMatchObject({ active: false, code: null, label: null })
  })

  it('a non-zero AllErr is an active fault named by its code', () => {
    expect(greeErrorReading(12, 5)).toEqual({
      active: true,
      code: 'E12',
      label: 'Error E12',
      severity: 'error',
      since: null,
      lastFetchedAt: 5,
    })
  })
})

describe('planGreeSensorChildren', () => {
  it('a unit that answers no column gets no sensor child', () => {
    expect(planGreeSensorChildren(null)).toEqual([])
    expect(planGreeSensorChildren({ outdoorTemp: null, defrost: null, errorCode: null })).toEqual(
      [],
    )
  })

  it('declares the outdoor temperature sensor; the fault is the error cap, not a child', () => {
    const plan = planGreeSensorChildren({ outdoorTemp: 6, defrost: false, errorCode: 7 })
    expect(plan.map((p) => p.kind)).toEqual(['outdoor'])
    expect(plan[0]).toMatchObject({
      suffix: 'outdoor',
      label: 'Temperatura esterna',
      type: DeviceType.Sensor,
      role: DeviceRole.TemperatureSensor,
    })
  })

  it('declares only what answered', () => {
    const plan = planGreeSensorChildren({ outdoorTemp: 6, defrost: null, errorCode: null })
    expect(plan.map((p) => p.kind)).toEqual(['outdoor'])
  })
})
