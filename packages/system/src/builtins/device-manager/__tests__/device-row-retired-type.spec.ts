import { DeviceRole, DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { decodeDeviceRow } from '../device-row-store.js'

// D1033 — `thermostat` was folded into `climate`. A row persisted before the
// fold is READ as climate (restore class lookup, bindings, UI), and the next
// registration of the device rewrites it. No migration runs.
function row(type: string, role?: string): Record<string, unknown> {
  return {
    deviceId: 4271,
    addonId: 'provider-homeassistant',
    stableId: 'climate.hall',
    type,
    name: 'Hall',
    ...(role !== undefined ? { role } : {}),
  }
}

describe('a row persisted with a retired type (D1033)', () => {
  it('a thermostat row decodes as climate', () => {
    expect(decodeDeviceRow(row('thermostat'))?.meta.type).toBe(DeviceType.Climate)
  })

  it('keeps the role the row carries', () => {
    const decoded = decodeDeviceRow(row('thermostat', DeviceRole.ClimateRadiator))
    expect(decoded?.meta.role).toBe(DeviceRole.ClimateRadiator)
  })

  it('a heater row is not aliased: it stays an unknown type, never dropped', () => {
    const decoded = decodeDeviceRow(row('heater'))
    expect(decoded).not.toBeNull()
    expect(decoded?.meta.type).toBe('heater')
  })
})
