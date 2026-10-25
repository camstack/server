import {
  errMsg,
  type IDeviceRegistry,
  type DeviceManagerApi,
  type IScopedLogger,
} from '@camstack/types'
import { readHaSource } from './ha-device-source.js'

/**
 * Remove every adopted HA PARENT device (children cascade via the kernel)
 * whose persisted `source.brokerId` matches `brokerId`. Used when a broker is
 * removed directly (broker.remove) AND when its spawning integration is
 * deleted (integration.deleted reconcile) — both must take the devices down.
 * Best-effort per device: a failed remove is logged, not thrown.
 *
 * Returns the count of devices successfully removed.
 */
export async function cascadeRemoveDevicesForBroker(input: {
  readonly reg: Pick<IDeviceRegistry, 'getAllForAddon'>
  readonly devices: Pick<DeviceManagerApi, 'loadConfig' | 'remove'>
  readonly addonId: string
  readonly brokerId: string
  readonly logger: IScopedLogger
}): Promise<number> {
  const { reg, devices, addonId, brokerId, logger } = input
  let removed = 0
  for (const d of reg.getAllForAddon(addonId)) {
    if (d.parentDeviceId !== null) continue
    const cfg = await devices.loadConfig(d.id).catch((): Record<string, unknown> => ({}))
    const src = readHaSource(cfg)
    if (src?.brokerId !== brokerId) continue
    try {
      await devices.remove(d.id)
      removed += 1
    } catch (err) {
      logger.warn('ha: broker cascade-remove failed', {
        tags: { deviceId: d.id },
        meta: { brokerId, error: errMsg(err) },
      })
    }
  }
  return removed
}
