/**
 * A battery level that is NOT YET KNOWN publishes nothing to HomeKit.
 *
 * `BatteryStatus.level` used to be non-nullable, so a provider with no
 * reading yet could only seed `0`. Every battery camera behind a Reolink NVR
 * therefore announced a flat battery on each hub start and corrected itself a
 * moment later — long enough for HomeKit to raise StatusLowBattery and for the
 * notification rules to fire. Unknown is not empty, and on a battery reading
 * the difference is an alarm.
 */
import { describe, expect, it } from 'vitest'
import { Characteristic } from '@homebridge/hap-nodejs'
import { batteryCharacteristicUpdates } from '../battery.js'

const readOf = (updates: readonly { characteristic: unknown; value: unknown }[], c: unknown) =>
  updates.find((u) => u.characteristic === c)

describe('batteryCharacteristicUpdates — an unknown level', () => {
  it('publishes no BatteryLevel at all', () => {
    const updates = batteryCharacteristicUpdates({
      level: null,
      charging: 'none',
      sleeping: false,
      lastUpdated: 1,
    })
    expect(readOf(updates, Characteristic.BatteryLevel)).toBeUndefined()
  })

  it('never raises the LOW warning on a level it does not have', () => {
    const updates = batteryCharacteristicUpdates({
      level: null,
      charging: 'none',
      sleeping: false,
      lastUpdated: 1,
    })
    expect(readOf(updates, Characteristic.StatusLowBattery)).toBeUndefined()
  })

  it('still reports the charging state, which IS known', () => {
    const updates = batteryCharacteristicUpdates({
      level: null,
      charging: 'solar',
      sleeping: false,
      lastUpdated: 1,
    })
    expect(readOf(updates, Characteristic.ChargingState)?.value).toBe(
      Characteristic.ChargingState.CHARGING,
    )
  })

  it('publishes a real level normally', () => {
    const updates = batteryCharacteristicUpdates({
      level: 42,
      charging: 'none',
      sleeping: false,
      lastUpdated: 1,
    })
    expect(readOf(updates, Characteristic.BatteryLevel)?.value).toBe(42)
    expect(readOf(updates, Characteristic.StatusLowBattery)?.value).toBe(
      Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    )
  })

  it('writes no ChargingState for an UNKNOWN power source — it is not a claim either way', () => {
    const updates = batteryCharacteristicUpdates({
      level: 64,
      charging: 'unknown',
      sleeping: false,
      lastUpdated: 1,
    })
    expect(readOf(updates, Characteristic.BatteryLevel)?.value).toBe(64)
    expect(readOf(updates, Characteristic.ChargingState)).toBeUndefined()
  })
})
