/**
 * The outdoor Ecowitt group was stored as a `container`. It is the physical
 * station: same row (deviceId, stableId, config, children), type
 * `weather-station`. Idempotent — a row already retyped is left alone.
 */
import {
  DeviceType,
  type AddonProcedureMigration,
  type MigrationProcedureResult,
} from '@dominevo/types'
import { ECOWITT_SYSTEM } from '../config.js'

export const ECOWITT_RETYPE_OUTDOOR_STATION_ID =
  'provider-ecowitt/2026-11-14-retype-outdoor-station'

export interface StationRetypeDevice {
  readonly id: number
  readonly stableId: string
  readonly type: string
  readonly parentDeviceId: number | null
  readonly config: Readonly<Record<string, unknown>>
}

export interface StationRetypePorts {
  /** Every persisted device of this addon, config included. */
  listDevices(): Promise<readonly StationRetypeDevice[]>
  /** Patch the type only. Config, stable id and children stay. */
  setType(deviceId: number, type: string): Promise<void>
}

function isOutdoorContainer(device: StationRetypeDevice): boolean {
  return (
    device.type === DeviceType.Container &&
    device.config['system'] === ECOWITT_SYSTEM &&
    device.config['deviceGroup'] === 'weather-station'
  )
}

function sameRecord(before: StationRetypeDevice, after: StationRetypeDevice): boolean {
  return (
    after.id === before.id &&
    after.stableId === before.stableId &&
    JSON.stringify(after.config) === JSON.stringify(before.config)
  )
}

/**
 * Retype every outdoor Ecowitt container. A marked config field and each
 * child's parent link are read back: a rewrite that dropped them fails the
 * step instead of reporting done.
 */
export async function retypeOutdoorStations(
  ports: StationRetypePorts,
): Promise<MigrationProcedureResult> {
  const before = await ports.listDevices()
  const targets = before.filter(isOutdoorContainer)
  if (targets.length === 0) {
    return { outcome: 'already-done', summary: { retyped: 0 } }
  }
  for (const device of targets) {
    await ports.setType(device.id, DeviceType.WeatherStation)
  }
  const after = await ports.listDevices()
  for (const device of targets) {
    const row = after.find((entry) => entry.id === device.id)
    if (row === undefined || row.type !== DeviceType.WeatherStation || !sameRecord(device, row)) {
      throw new Error(
        `outdoor station ${device.id} did not keep its id, stable id and config after the retype`,
      )
    }
    const childrenBefore = before.filter((entry) => entry.parentDeviceId === device.id)
    for (const child of childrenBefore) {
      const next = after.find((entry) => entry.id === child.id)
      if (next === undefined || next.parentDeviceId !== device.id) {
        throw new Error(`child ${child.id} lost its parent link to station ${device.id}`)
      }
    }
  }
  return { outcome: 'done', summary: { retyped: targets.length } }
}

export const ECOWITT_RETYPE_OUTDOOR_STATION_MIGRATION: AddonProcedureMigration<StationRetypePorts> =
  {
    meta: {
      id: ECOWITT_RETYPE_OUTDOOR_STATION_ID,
      owner: 'provider-ecowitt',
      level: 'addon-state',
      seq: 3,
      dependsOn: [],
      store: 'settings',
      scope: 'cluster',
      onFailure: 'block-owner',
      bodyKind: 'procedure',
      description:
        'Retype the Ecowitt outdoor container to weather-station, keeping its device id, stable id, config and children',
      fixtureMark: 'stationNote',
    },
    procedure: retypeOutdoorStations,
  }
