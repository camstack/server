import { describe, expect, it } from 'vitest'
import { CcuDeviceRowSchema } from '../ccu/ccu-schemas.js'
import {
  belongsToDevice,
  ccuInterfaceOf,
  DEVICE_PARAM,
  deviceDetailPath,
  resolveDeviceSelection,
} from '../ui/device-route.js'

const row = (address: string) =>
  CcuDeviceRowSchema.parse({
    address,
    type: 'HmIP-BS2',
    name: null,
    rooms: [],
    functions: [],
    firmware: null,
    availableFirmware: null,
    updatable: null,
    rssi: null,
    rssiPeer: null,
    dutyCycle: null,
    dutyCycleLimited: null,
    lowBattery: null,
    unreach: null,
    configPending: null,
    sabotage: null,
  })

describe('deviceDetailPath', () => {
  it('addresses a device on the page: tab, CCU and the address in ?device=', () => {
    const path = deviceDetailPath('0001D3C99C5678', 'hm_1')
    const url = new URL(path, 'http://hub')
    expect(url.pathname).toBe('/addon/homematic-ccu')
    expect(url.searchParams.get('tab')).toBe('devices')
    expect(url.searchParams.get('ccu')).toBe('hm_1')
    expect(url.searchParams.get(DEVICE_PARAM)).toBe('0001D3C99C5678')
  })

  it('round-trips an address that needs escaping', () => {
    const url = new URL(deviceDetailPath('A B&C'), 'http://hub')
    expect(url.searchParams.get(DEVICE_PARAM)).toBe('A B&C')
  })
})

describe('resolveDeviceSelection', () => {
  const devices = [row('AAA'), row('BBB')]

  it('is the table when there is no ?device=', () => {
    expect(resolveDeviceSelection(null, devices)).toEqual({ kind: 'none' })
    expect(resolveDeviceSelection('', devices)).toEqual({ kind: 'none' })
  })

  it('opens the device whose address is in the URL', () => {
    const selection = resolveDeviceSelection('BBB', devices)
    expect(selection.kind === 'found' && selection.device.address).toBe('BBB')
  })

  it('is pending, never "not found", while the list has not answered', () => {
    expect(resolveDeviceSelection('BBB', undefined)).toEqual({ kind: 'pending', address: 'BBB' })
  })

  it('names an address the answered list lacks', () => {
    expect(resolveDeviceSelection('ZZZ', devices)).toEqual({ kind: 'missing', address: 'ZZZ' })
  })
})

describe('ccuInterfaceOf / belongsToDevice', () => {
  it('reads the interface from the type prefix', () => {
    expect(ccuInterfaceOf('HmIP-eTRV-2')).toBe('HmIP-RF')
    expect(ccuInterfaceOf('HmIPW-DRS8')).toBe('HmIP-Wired')
    expect(ccuInterfaceOf('HMW-IO-12')).toBe('BidCos-Wired')
    expect(ccuInterfaceOf('HM-CC-RT-DN')).toBe('BidCos-RF')
  })

  it('matches the device and its channels, not a longer address', () => {
    expect(belongsToDevice('ABC', 'ABC')).toBe(true)
    expect(belongsToDevice('ABC:3', 'ABC')).toBe(true)
    expect(belongsToDevice('ABCD:3', 'ABC')).toBe(false)
    expect(belongsToDevice(null, 'ABC')).toBe(false)
  })
})
