import { describe, expect, it } from 'vitest'

import { DeviceType } from '@camstack/types'
import {
  buildSyncDevice,
  resolveGoogleDeviceType,
  SUPPORTED_DEVICE_KINDS,
} from '../google-home/device-model.js'
import { facts } from './fakes.js'

describe('buildSyncDevice', () => {
  it('projects a dimmable light as LIGHT with both traits', () => {
    const device = buildSyncDevice(
      facts({
        deviceId: 101,
        name: 'Kitchen lamp',
        deviceType: 'light',
        capNames: ['switch', 'brightness'],
      }),
    )
    expect(device).toEqual({
      id: '101',
      type: 'action.devices.types.LIGHT',
      traits: ['action.devices.traits.OnOff', 'action.devices.traits.Brightness'],
      name: { name: 'Kitchen lamp' },
      willReportState: false,
      deviceInfo: { manufacturer: 'CamStack', model: 'light' },
    })
  })

  it('never promises Report State — this addon holds no HomeGraph credential', () => {
    const device = buildSyncDevice(facts())
    expect(device?.willReportState).toBe(false)
  })

  it('projects a siren as SWITCH, not a security system', () => {
    // Google has no siren type, and SECURITYSYSTEM would promise ArmDisarm,
    // which nothing here answers.
    const device = buildSyncDevice(facts({ deviceType: 'siren', capNames: ['switch'] }))
    expect(device?.type).toBe('action.devices.types.SWITCH')
  })

  it('lets the trait, not the device type, decide a lock and a cover', () => {
    expect(
      buildSyncDevice(facts({ deviceType: 'generic', capNames: ['lock-control'] }))?.type,
    ).toBe('action.devices.types.LOCK')
    expect(buildSyncDevice(facts({ deviceType: 'generic', capNames: ['cover'] }))?.type).toBe(
      'action.devices.types.SHUTTER',
    )
  })

  it('carries the cover attributes the trait contributes', () => {
    const discrete = buildSyncDevice(facts({ deviceType: 'cover', capNames: ['cover'] }))
    expect(discrete?.attributes).toEqual({ discreteOnlyOpenClose: true })

    const positionable = buildSyncDevice(
      facts({ deviceType: 'cover', capNames: ['cover'], features: ['cover-positionable'] }),
    )
    expect(positionable?.attributes).toEqual({ discreteOnlyOpenClose: false })
  })

  it('omits `attributes` entirely when no trait contributes one', () => {
    const device = buildSyncDevice(facts())
    expect(device).not.toHaveProperty('attributes')
  })

  it('returns null for a device with no exported capability', () => {
    // A camera. Declaring it would produce a Google device whose every command
    // fails — see adr-0273.
    expect(
      buildSyncDevice(
        facts({ deviceType: 'camera', capNames: ['camera-streams', 'snapshot', 'ptz'] }),
      ),
    ).toBeNull()
  })

  it('returns null for a device with no capabilities at all', () => {
    expect(buildSyncDevice(facts({ capNames: [] }))).toBeNull()
  })
})

describe('SUPPORTED_DEVICE_KINDS', () => {
  it('offers exactly the kinds the catalog can represent', () => {
    expect(SUPPORTED_DEVICE_KINDS.toSorted()).toEqual(
      ['cover', 'light', 'lock', 'siren', 'switch'].toSorted(),
    )
  })

  it('does not turn a washer into a switch just because power could look like OnOff', () => {
    expect(resolveGoogleDeviceType(DeviceType.Washer, ['action.devices.traits.OnOff'])).toBeNull()
    expect(SUPPORTED_DEVICE_KINDS).not.toContain(DeviceType.Washer)
    expect(SUPPORTED_DEVICE_KINDS).not.toContain(DeviceType.Dryer)
    expect(SUPPORTED_DEVICE_KINDS).not.toContain(DeviceType.Dishwasher)
  })
})
