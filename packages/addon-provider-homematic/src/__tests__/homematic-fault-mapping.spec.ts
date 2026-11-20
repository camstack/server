/**
 * The CCU's faults as `error` cap readings: the WatchDog system variables of the
 * box, and the MAINTENANCE service flags of a device. Pure mapping, no session.
 */
import { ERROR_STATUS_COLD } from '@camstack/types'
import type { HmSysVar, HmValue } from 'nodehomematic'
import { describe, expect, it } from 'vitest'
import {
  maintenanceFaultReading,
  watchdogFaultReading,
  WATCHDOG_FAULTS,
} from '../homematic-fault-mapping.js'

const NOW = 1_700_000_000_000

function sysvar(name: string, value: HmValue): HmSysVar {
  return {
    id: name,
    name,
    type: 'LOGIC',
    value,
    writable: false,
    isInternal: false,
  }
}

const allWatchdog = (value: HmValue): HmSysVar[] =>
  WATCHDOG_FAULTS.map((f) => sysvar(`SV WatchDog: ${f.key}`, value))

describe('watchdogFaultReading', () => {
  it('is unknown, never "no fault", when the CCU gave no system variables', () => {
    expect(watchdogFaultReading([], NOW)).toEqual({ ...ERROR_STATUS_COLD, lastFetchedAt: NOW })
  })

  it('is unknown when variables exist but none is a WatchDog one', () => {
    const reading = watchdogFaultReading([sysvar('Presence', true)], NOW)
    expect(reading.active).toBeNull()
  })

  it.each([
    ['hb-rf-eth-connection', 'error'],
    ['low-voltage', 'error'],
    ['rfd-restart', 'warning'],
    ['regahss-restart', 'warning'],
    ['no-internet', 'warning'],
    ['unclean-shutdown', 'warning'],
  ])('%s on is one fault of severity %s', (key, severity) => {
    const vars = allWatchdog(false).map((v) =>
      v.name === `SV WatchDog: ${key}` ? { ...v, value: true } : v,
    )
    const reading = watchdogFaultReading(vars, NOW)
    expect(reading.active).toBe(true)
    expect(reading.code).toBe(key)
    expect(reading.severity).toBe(severity)
    expect(reading.faults).toHaveLength(1)
    expect(reading.label).toBeTruthy()
    expect(reading.lastFetchedAt).toBe(NOW)
  })

  it('clears to active:false when every variable is off', () => {
    const reading = watchdogFaultReading(allWatchdog(false), NOW)
    expect(reading).toMatchObject({ active: false, code: null, label: null, faults: [] })
  })

  it('puts the error-severity fault first among several', () => {
    const vars = [
      sysvar('SV WatchDog: no-internet', true),
      sysvar('SV WatchDog: hb-rf-eth-connection', true),
    ]
    const reading = watchdogFaultReading(vars, NOW)
    expect(reading.faults?.map((f) => f.code)).toEqual(['hb-rf-eth-connection', 'no-internet'])
    expect(reading.code).toBe('hb-rf-eth-connection')
    expect(reading.severity).toBe('error')
  })

  it('reads LOGIC values written as numbers or text', () => {
    expect(watchdogFaultReading([sysvar('SV WatchDog: low-voltage', 1)], NOW).active).toBe(true)
    expect(watchdogFaultReading([sysvar('SV WatchDog: low-voltage', 'true')], NOW).active).toBe(
      true,
    )
    expect(watchdogFaultReading([sysvar('SV WatchDog: low-voltage', 0)], NOW).active).toBe(false)
  })

  it('treats a variable whose value is null as unread, not as off', () => {
    expect(watchdogFaultReading([sysvar('SV WatchDog: low-voltage', null)], NOW).active).toBeNull()
  })
})

describe('maintenanceFaultReading', () => {
  const values = (entries: Record<string, HmValue>): ReadonlyMap<string, HmValue> =>
    new Map(Object.entries(entries))

  it('is unknown while no service flag has a value yet', () => {
    expect(maintenanceFaultReading(values({ UNREACH: null }), NOW).active).toBeNull()
    expect(maintenanceFaultReading(values({}), NOW).active).toBeNull()
  })

  it('is clear when the flags are known and all off', () => {
    const reading = maintenanceFaultReading(values({ UNREACH: false, LOW_BAT: false }), NOW)
    expect(reading).toMatchObject({ active: false, faults: [] })
  })

  it.each([
    ['UNREACH', 'error'],
    ['STICKY_UNREACH', 'warning'],
    ['LOW_BAT', 'warning'],
    ['LOWBAT', 'warning'],
    ['CONFIG_PENDING', 'warning'],
    ['DUTY_CYCLE', 'warning'],
    ['ERROR_OVERHEAT', 'error'],
    ['ERROR_JAMMED', 'error'],
  ])('%s on is a fault of severity %s', (param, severity) => {
    const reading = maintenanceFaultReading(values({ [param]: true }), NOW)
    expect(reading.active).toBe(true)
    expect(reading.code).toBe(param)
    expect(reading.severity).toBe(severity)
  })

  it('ranks errors before warnings and keeps every fault', () => {
    const reading = maintenanceFaultReading(
      values({ LOW_BAT: true, UNREACH: true, CONFIG_PENDING: true }),
      NOW,
    )
    expect(reading.faults?.map((f) => f.code)).toEqual(['UNREACH', 'LOW_BAT', 'CONFIG_PENDING'])
    expect(reading.code).toBe('UNREACH')
  })

  it('ignores an ERROR_ parameter that is not a boolean flag', () => {
    const reading = maintenanceFaultReading(values({ UNREACH: false, ERROR_CODE: 7 }), NOW)
    expect(reading.active).toBe(false)
  })
})
