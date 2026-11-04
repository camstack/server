import { describe, expect, it } from 'vitest'
import {
  brokersExposing,
  devicesForBroker,
  type ExportMembership,
  isExposed,
  setExposed,
} from '../membership.js'

const M: ExportMembership = { ha_home: ['101', '102'], ha_office: ['101'] }

describe('per-broker membership', () => {
  it('lets two Home Assistant instances see different sets', () => {
    expect(devicesForBroker(M, 'ha_home')).toEqual(['101', '102'])
    expect(devicesForBroker(M, 'ha_office')).toEqual(['101'])
    expect(isExposed(M, 'ha_office', '102')).toBe(false)
  })

  it('answers empty for a broker nobody was exposed to', () => {
    expect(devicesForBroker(M, 'ha_new')).toEqual([])
  })

  it('names every broker a device is exposed to', () => {
    expect(brokersExposing(M, '101')).toEqual(['ha_home', 'ha_office'])
    expect(brokersExposing(M, '102')).toEqual(['ha_home'])
    expect(brokersExposing(M, '999')).toEqual([])
  })

  it('adds without mutating the original', () => {
    const next = setExposed(M, 'ha_office', '102', true)
    expect(devicesForBroker(next, 'ha_office')).toEqual(['101', '102'])
    expect(devicesForBroker(M, 'ha_office')).toEqual(['101'])
  })

  it('is idempotent on a repeated expose', () => {
    expect(setExposed(M, 'ha_home', '101', true)).toEqual(M)
  })

  it('removes only from the broker asked, never the others', () => {
    const next = setExposed(M, 'ha_home', '101', false)
    expect(devicesForBroker(next, 'ha_home')).toEqual(['102'])
    expect(devicesForBroker(next, 'ha_office')).toEqual(['101'])
  })
})
