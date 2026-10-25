import {
  errMsg,
  type IDeviceRegistry,
  type DeviceManagerApi,
  type IScopedLogger,
} from '@camstack/types'

/**
 * Remove every adopted Homematic PARENT device (children cascade via the
 * kernel) whose persisted config carries `{ system: 'homematic', brokerId }`.
 * Used when a broker is removed directly (broker.remove) AND when its
 * spawning integration is deleted — both must take the devices down.
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
    // Only process top-level (parent) devices — children cascade via kernel.
    if (d.parentDeviceId !== null) continue
    const cfg = await devices.loadConfig(d.id).catch((): Record<string, unknown> => ({}))
    // Decision 6: Homematic provenance is stored at the top level of the
    // config blob as `{ system: 'homematic', brokerId }`.
    if (cfg['system'] !== 'homematic' || cfg['brokerId'] !== brokerId) continue
    try {
      await devices.remove(d.id)
      removed += 1
    } catch (err) {
      logger.warn('homematic: broker cascade-remove failed', {
        tags: { deviceId: d.id },
        meta: { brokerId, error: errMsg(err) },
      })
    }
  }
  return removed
}
