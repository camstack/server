import { describe, expect, it } from 'vitest'
import { DeviceType } from '../../device/device-type.js'
import { HISTORY_CATALOG } from '../../generated/history-catalog.js'
import {
  emptyVehicleStatus,
  VEHICLE_REFRESH_REFUSALS,
  VehicleRefreshResultSchema,
  VehicleStatusSchema,
  vehicleCapability,
} from '../vehicle.cap.js'

describe('vehicle cap — status schema', () => {
  it('an all-null status parses: nothing defaults to 0 or false', () => {
    const empty = emptyVehicleStatus()
    expect(VehicleStatusSchema.safeParse(empty).success).toBe(true)
    expect(empty.odometer).toBeNull()
    expect(empty.range).toBeNull()
    expect(empty.engineOn).toBeNull()
    expect(empty.doors.frontLeft).toBeNull()
    expect(empty.windows.rearRight).toBeNull()
    expect(empty.trunkOpen).toBeNull()
    expect(empty.tyreWarnings.frontRight).toBeNull()
    expect(empty.auxBatteryLevel).toBeNull()
    expect(empty.reportedAt).toBeNull()
  })

  it('refuses a negative odometer and a battery level over 100', () => {
    expect(VehicleStatusSchema.safeParse({ ...emptyVehicleStatus(), odometer: -1 }).success).toBe(
      false,
    )
    expect(
      VehicleStatusSchema.safeParse({ ...emptyVehicleStatus(), auxBatteryLevel: 101 }).success,
    ).toBe(false)
  })
})

describe('vehicle cap — refresh result', () => {
  it('accepts a success and a refusal with a retry time', () => {
    expect(VehicleRefreshResultSchema.safeParse({ ok: true, reportedAt: 5 }).success).toBe(true)
    expect(
      VehicleRefreshResultSchema.safeParse({ ok: false, reason: 'too-soon', retryAt: 9 }).success,
    ).toBe(true)
    expect(
      VehicleRefreshResultSchema.safeParse({ ok: false, reason: 'too-soon', retryAt: null })
        .success,
    ).toBe(true)
  })

  it('refuses an unknown reason and a refusal without retryAt', () => {
    expect(
      VehicleRefreshResultSchema.safeParse({ ok: false, reason: 'because', retryAt: null }).success,
    ).toBe(false)
    expect(VehicleRefreshResultSchema.safeParse({ ok: false, reason: 'too-soon' }).success).toBe(
      false,
    )
  })

  it('names six refusals', () => {
    expect([...VEHICLE_REFRESH_REFUSALS].sort()).toEqual([
      'account-error',
      'budget-exhausted',
      'in-progress',
      'not-supported',
      'too-soon',
      'vehicle-unreachable',
    ])
  })
})

describe('vehicle cap — shape', () => {
  it('binds on the vehicle type only', () => {
    expect([...vehicleCapability.deviceTypes]).toEqual([DeviceType.Vehicle])
  })

  it('records the 15 declared series, the odometer as a counter in metres', () => {
    const fields = HISTORY_CATALOG['vehicle']
    expect(fields).toBeDefined()
    expect(Object.keys(fields ?? {})).toHaveLength(15)
    expect(fields?.['odometer']?.kind).toBe('counter')
    expect(fields?.['odometer']?.unit).toBe('m')
    expect(fields?.['range']?.unit).toBe('m')
  })

  it('records no window, sunroof or report-time series', () => {
    const names = Object.keys(HISTORY_CATALOG['vehicle'] ?? {})
    expect(names.filter((n) => n.startsWith('windows') || n === 'sunroofOpen')).toEqual([])
    expect(names).not.toContain('reportedAt')
  })
})
