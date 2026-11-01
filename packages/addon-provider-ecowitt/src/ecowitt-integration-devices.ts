import { errMsg, type DeviceManagerApi, type IScopedLogger } from '@camstack/types'
import { ECOWITT_SYSTEM } from './config.js'

export interface OfflineTarget {
  readonly online: boolean
  readonly config: { get(key: string): unknown }
  markOnline(online: boolean): void
}

/**
 * Set every Ecowitt device of a gateway (Gateway device, Containers and their sensors) to
 * `online`. They share the gateway key as `gatewayId`, whether or not they were migrated yet.
 * Churn-free: a device already in that state is left alone. Returns how many changed.
 */
export function setGatewayDevicesOnline(
  devices: ReadonlyArray<OfflineTarget>,
  gatewayKey: string,
  online: boolean,
): number {
  let count = 0
  for (const dev of devices) {
    if (dev.config.get('gatewayId') !== gatewayKey) continue
    if (dev.online === online) continue
    dev.markOnline(online)
    count += 1
  }
  return count
}

/**
 * Remove every top-level device of an integration that was deleted or disabled (the Gateway
 * device and the group Containers); the kernel takes the sensors with their Container.
 */
export async function cascadeRemoveDevicesForIntegration(input: {
  readonly reg: {
    getAllForAddon(addonId: string): ReadonlyArray<{
      readonly id: number
      readonly parentDeviceId: number | null
    }>
  }
  readonly devices: Pick<DeviceManagerApi, 'loadConfig' | 'remove'>
  readonly addonId: string
  readonly integrationId: string
  readonly logger: IScopedLogger
}): Promise<number> {
  const { reg, devices, addonId, integrationId, logger } = input
  let removed = 0
  for (const d of reg.getAllForAddon(addonId)) {
    if (d.parentDeviceId !== null) continue
    const cfg = await devices.loadConfig(d.id).catch((): Record<string, unknown> => ({}))
    if (cfg['system'] !== ECOWITT_SYSTEM || cfg['integrationId'] !== integrationId) continue
    try {
      await devices.remove(d.id)
      removed += 1
    } catch (err) {
      logger.warn('ecowitt: integration cascade-remove failed', {
        tags: { deviceId: d.id },
        meta: { integrationId, error: errMsg(err) },
      })
    }
  }
  return removed
}
