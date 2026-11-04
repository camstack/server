import { errMsg, type DeviceManagerApi, type IScopedLogger } from '@camstack/types'
import { VESYNC_SYSTEM } from './config.js'

export interface OnlineTarget {
  readonly online: boolean
  readonly config: { get(key: string): unknown }
  markOnline(online: boolean): void
}

/**
 * Set every VeSync device of an integration (the Gateway, the purifiers and their
 * accessories) to `online`. They share `integrationId`. A device already in that
 * state is left alone. Returns how many changed.
 */
export function setIntegrationDevicesOnline(
  devices: ReadonlyArray<OnlineTarget>,
  integrationId: string,
  online: boolean,
): number {
  let count = 0
  for (const dev of devices) {
    if (dev.config.get('integrationId') !== integrationId) continue
    if (dev.online === online) continue
    dev.markOnline(online)
    count += 1
  }
  return count
}

/**
 * Remove every top-level device of an integration that was deleted or disabled (the
 * Gateway and the purifiers). The kernel takes the accessories with their purifier.
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
    if (cfg['system'] !== VESYNC_SYSTEM || cfg['integrationId'] !== integrationId) continue
    try {
      await devices.remove(d.id)
      removed += 1
    } catch (err) {
      logger.warn('vesync: integration cascade-remove failed', {
        tags: { deviceId: d.id },
        meta: { integrationId, error: errMsg(err) },
      })
    }
  }
  return removed
}
