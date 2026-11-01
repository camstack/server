import { DeviceType } from '@camstack/types'
import { ECOWITT_SYSTEM } from './config.js'
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
    if (row.type !== DeviceType.Container || row.config['system'] !== ECOWITT_SYSTEM) continue
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
