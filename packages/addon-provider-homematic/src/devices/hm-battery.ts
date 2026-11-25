import {
  batteryCapability,
  type BatteryStatus,
  type DeviceContext,
  type IDeviceRuntimeState,
  type InferNativeProvider,
} from '@camstack/types'
import type { HmChannel, HmDevice } from 'nodehomematic'
import { isBatteryOperatedDevice } from '../homematic-diagnostics-mapping.js'

/**
 * The `battery` cap on a FUNCTIONAL Homematic child (a sensor or an actuator),
 * fed from the device's MAINTENANCE channel. The container carries no card
 * logic: the operator reads the battery on the device the card is drawn for.
 *
 * LOW_BAT is a BINARY source, so it uses the cap's existing binary shape —
 * `binary: true` with a coarse stand-in level (the same one the Home Assistant
 * provider writes) — and OPERATING_VOLTAGE rides in the same slice as
 * `voltage`. Until a reading lands the slice is absent and `getStatus` answers
 * `level: null` (unknown, never 0 — D315).
 */

export const HM_BATTERY_CAP = 'battery'

/** Stand-in levels for the binary LOW_BAT source, as the Home Assistant provider writes them. */
const BINARY_NORMAL_PCT = 100
const BINARY_LOW_PCT = 15

const COLD_BATTERY: BatteryStatus = {
  level: null,
  charging: 'unknown',
  sleeping: false,
  lastUpdated: 0,
  binary: true,
}

const MAINTENANCE_CHANNEL_TYPE = 'MAINTENANCE'
const LOW_BAT = 'LOW_BAT'
const OPERATING_VOLTAGE = 'OPERATING_VOLTAGE'

/** Is this datapoint one of the two a child's battery slice is built from? */
export function isBatteryDatapoint(channel: HmChannel, parameter: string): boolean {
  return (
    channel.type?.toUpperCase() === MAINTENANCE_CHANNEL_TYPE &&
    (parameter === LOW_BAT || parameter === OPERATING_VOLTAGE)
  )
}

/**
 * Register the `battery` cap on a functional child when its device is battery
 * operated. Returns whether it registered. A device that cannot be resolved yet
 * registers anyway: the persisted capability list was derived from the device,
 * and cap presence must not depend on facade timing. A resolved device without
 * LOW_BAT is a skipped binding and is logged with the device id.
 */
export function registerChildBatteryCap(
  ctx: DeviceContext,
  runtimeState: IDeviceRuntimeState,
  hmDevice: HmDevice | null,
): boolean {
  if (hmDevice !== null && !isBatteryOperatedDevice(hmDevice)) {
    ctx.logger.warn('Homematic battery binding skipped: no LOW_BAT on the maintenance channel', {
      tags: { deviceId: ctx.id },
      meta: { address: hmDevice.address },
    })
    return false
  }
  const provider: InferNativeProvider<typeof batteryCapability> = {
    getStatus: async () => runtimeState.getCapState<BatteryStatus>('battery') ?? COLD_BATTERY,
  }
  ctx.registerNativeCap(batteryCapability, provider)
  return true
}

/** Fold one maintenance datapoint into the child's battery slice. */
export function decodeBatteryPush(
  runtimeState: IDeviceRuntimeState,
  parameter: string,
  value: unknown,
  now: number,
): void {
  const prev = runtimeState.getCapState<BatteryStatus>('battery') ?? COLD_BATTERY
  if (parameter === LOW_BAT && typeof value === 'boolean') {
    runtimeState.setCapState('battery', {
      ...prev,
      level: value ? BINARY_LOW_PCT : BINARY_NORMAL_PCT,
      charging: 'none',
      binary: true,
      lastUpdated: now,
    })
    return
  }
  if (parameter === OPERATING_VOLTAGE && typeof value === 'number') {
    runtimeState.setCapState('battery', { ...prev, voltage: value, binary: true, lastUpdated: now })
  }
}
