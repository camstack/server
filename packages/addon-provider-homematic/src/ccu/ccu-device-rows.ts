import type { HmChannel, HmDevice, HmValue } from 'nodehomematic'
import type { CcuDeviceRow } from './ccu-schemas.js'

/** `RSSI_*` reports this when the device has no signal reading. */
const RSSI_UNKNOWN = 65535

function maintenanceChannel(device: HmDevice): HmChannel | undefined {
  return (
    device.channels.find((channel) => channel.type?.toUpperCase() === 'MAINTENANCE') ??
    device.channels.find((channel) => channel.index === 0)
  )
}

function readParam(channel: HmChannel | undefined, names: readonly string[]): HmValue {
  if (channel === undefined) return null
  for (const name of names) {
    const dp = channel.dataPoints.find((point) => point.parameter.toUpperCase() === name)
    if (dp !== undefined) return dp.value
  }
  return null
}

function asBool(value: HmValue): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  return null
}

function asNumber(value: HmValue): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asRssi(value: HmValue): number | null {
  const n = asNumber(value)
  return n === null || n === RSSI_UNKNOWN || n === 0 ? null : n
}

/** One CCU device as a table row: identity and firmware from the descriptor, health from its MAINTENANCE channel. */
export function toCcuDeviceRow(device: HmDevice): CcuDeviceRow {
  const maintenance = maintenanceChannel(device)
  const duty = readParam(maintenance, ['DUTY_CYCLE', 'DUTY_CYCLE_LEVEL'])
  return {
    address: device.address,
    type: device.type,
    name: device.name ?? null,
    rooms: [...(device.rooms ?? [])],
    functions: [...(device.functions ?? [])],
    firmware: device.firmware ?? null,
    availableFirmware: device.availableFirmware ?? null,
    updatable: device.updatable ?? null,
    rssi: asRssi(readParam(maintenance, ['RSSI_DEVICE'])),
    rssiPeer: asRssi(readParam(maintenance, ['RSSI_PEER'])),
    dutyCycle: typeof duty === 'number' ? duty : null,
    dutyCycleLimited: typeof duty === 'boolean' ? duty : null,
    lowBattery: asBool(readParam(maintenance, ['LOW_BAT', 'LOWBAT'])),
    unreach: asBool(readParam(maintenance, ['UNREACH', 'STICKY_UNREACH'])),
    configPending: asBool(readParam(maintenance, ['CONFIG_PENDING'])),
    sabotage: asBool(readParam(maintenance, ['SABOTAGE', 'ERROR_SABOTAGE'])),
  }
}
