import {
  errMsg,
  type IDeviceRegistry,
  type DeviceManagerApi,
  type IScopedLogger,
} from '@camstack/types'

/**
 * Remove every adopted Alexa device whose persisted config carries
 * `{ system: 'alexa', brokerId }`. Used on broker.remove and integration delete.
 * Alexa appliances are flat (standalone) devices, so this removes top-level
 * devices directly. Best-effort per device; returns the count removed. Mirrors
 * the Ecowitt cascade helper.
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
    if (cfg['system'] !== 'alexa' || cfg['brokerId'] !== brokerId) continue
    try {
      await devices.remove(d.id)
      removed += 1
    } catch (err) {
      logger.warn('alexa: broker cascade-remove failed', {
        tags: { deviceId: d.id },
        meta: { brokerId, error: errMsg(err) },
      })
    }
  }
  return removed
}
