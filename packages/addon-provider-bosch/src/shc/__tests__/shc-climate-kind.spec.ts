/**
 * D1033 — a Bosch SHC radiator valve and a room climate are both `climate`
 * devices; the role says which, and a persisted row is rebuilt with the right
 * class although the two now share a type.
 */
import { DeviceRole, DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { deviceTypeForShcKind, shcClimateRole, shcClimateRowKind } from '../shc-domain-mapping.js'

describe('Bosch SHC climate kinds (D1033)', () => {
  it('a radiator valve is a climate device with the radiator role', () => {
    expect(deviceTypeForShcKind('trv')).toBe(DeviceType.Climate)
    expect(shcClimateRole('trv')).toBe(DeviceRole.ClimateRadiator)
  })

  it('a room climate is a climate thermostat', () => {
    expect(shcClimateRole('room-climate')).toBe(DeviceRole.ClimateThermostat)
  })

  it('a stored valve row (standalone or under a room) is rebuilt as a valve', () => {
    expect(
      shcClimateRowKind({ stableId: 'bosch-shc-x', config: { deviceModel: 'TRV_GEN2_DUAL' } }),
    ).toBe('trv')
    expect(shcClimateRowKind({ stableId: 'room-1-trv-hdm1_trv2' })).toBe('trv')
  })

  it('a stored room-climate accessory row is rebuilt as a room climate', () => {
    expect(
      shcClimateRowKind({
        stableId: 'room-1-climate',
        config: { deviceModel: 'ROOM_CLIMATE_CONTROL' },
      }),
    ).toBe('room-climate')
    expect(shcClimateRowKind({ stableId: 'room-1-climate' })).toBe('room-climate')
  })
})
