import { DeviceType } from '@dominevo/types'
import { isEcowittGroupType } from './ecowitt-mapping.js'
import { isStationReadingSensorId } from './station-reading.js'
import { configDeviceGroup, sensorKeyOf, sensorOwnerOf } from './ecowitt-sensor-groups.js'

/** One persisted device of this addon, as the cleanup reads it. */
export interface DuplicateScanRow {
  readonly id: number
  readonly type: DeviceType
  readonly parentDeviceId: number | null
  readonly config: Record<string, unknown>
}

function str(config: Record<string, unknown>, key: string): string | null {
  const v = config[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * Sensors minted under the `gateway` group Container (id `gateway:<key>`) that are the SAME reading
 * as a hardware-owned child (`<hw>:<key>`) of the weather-station / CH1 Container of the same
 * gateway. Early snapshots carry no
 * model for a sensor, which nodewitt classifies as `gateway`, so a weather-station reading was
 * once minted under the gateway Container as well; the live readings reach only the sensor under
 * its own group. Only a duplicate is returned: a sensor that exists nowhere else is the
 * gateway's own and is never touched. `scanned` is the number of sensor children seen, so a
 * caller can tell "nothing to remove" from "children not spawned yet".
 */
export function findDuplicateGatewaySensors(rows: readonly DuplicateScanRow[]): {
  readonly duplicates: readonly number[]
  readonly scanned: number
} {
  const containers = new Map<number, { gatewayId: string; gateway: boolean }>()
  for (const row of rows) {
    if (!isEcowittGroupType(row.type)) continue
    const gatewayId = str(row.config, 'gatewayId')
    if (gatewayId === null) continue
    containers.set(row.id, {
      gatewayId,
      gateway: configDeviceGroup(row.config) === 'gateway',
    })
  }
  const ownedElsewhere = new Set<string>()
  const underGateway: Array<{ id: number; key: string }> = []
  let scanned = 0
  for (const row of rows) {
    if (row.type !== DeviceType.Sensor || row.parentDeviceId === null) continue
    const container = containers.get(row.parentDeviceId)
    const sensorId = str(row.config, 'sensorId')
    if (container === undefined || sensorId === null) continue
    scanned += 1
    const key = `${container.gatewayId}\u0000${sensorKeyOf(sensorId)}`
    const owner = sensorOwnerOf(sensorId)
    if (container.gateway) {
      if (owner === 'gateway') underGateway.push({ id: row.id, key })
    } else if (owner !== 'gateway' && owner !== '') ownedElsewhere.add(key)
  }
  return {
    duplicates: underGateway.filter((s) => ownedElsewhere.has(s.key)).map((s) => s.id),
    scanned,
  }
}

/**
 * Sensor children of a weather-station Container whose reading the station now supplies on its
 * own slice (with history). They are retired once, through the normal device removal. Only a
 * child whose sensor id the station reading table knows is returned: a battery or lightning
 * child of the same Container stays.
 */
export function findStationReadingChildren(rows: readonly DuplicateScanRow[]): readonly number[] {
  const stations = new Set<number>()
  for (const row of rows) {
    if (!isEcowittGroupType(row.type)) continue
    if (configDeviceGroup(row.config) === 'weather-station') stations.add(row.id)
  }
  const ids: number[] = []
  for (const row of rows) {
    if (row.type !== DeviceType.Sensor || row.parentDeviceId === null) continue
    if (!stations.has(row.parentDeviceId)) continue
    const sensorId = str(row.config, 'sensorId')
    // The derived illuminance child shares the solar sensor id and stays.
    if (str(row.config, 'quantity') === 'illuminance') continue
    if (sensorId !== null && isStationReadingSensorId(sensorId)) ids.push(row.id)
  }
  return ids
}

/** A persisted row as far as the restore-time scan needs it. */
export interface RestoredRow {
  readonly config: Record<string, unknown>
}

/** The distinct gateways the restored rows belong to, so the retire scan can run per gateway. */
export function restoredGatewayKeys(rows: readonly RestoredRow[]): readonly string[] {
  const keys = new Set<string>()
  for (const row of rows) {
    const key = str(row.config, 'gatewayId')
    if (key !== null) keys.add(key)
  }
  return [...keys]
}
