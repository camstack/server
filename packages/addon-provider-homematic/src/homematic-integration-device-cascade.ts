import {
  errMsg,
  type IDeviceRegistry,
  type DeviceManagerApi,
  type IScopedLogger,
} from '@camstack/types'

/**
 * Remove every adopted Homematic PARENT device (children cascade via the
 * kernel) whose persisted config carries `{ system: 'homematic', integrationId }`
 * (the CCU box and its products). Used when the integration is deleted or
 * disabled out from under its devices.
 * Best-effort per device: a failed remove is logged, not thrown.
 *
 * Returns the count of devices successfully removed.
 */
export async function cascadeRemoveDevicesForIntegration(input: {
  readonly reg: Pick<IDeviceRegistry, 'getAllForAddon'>
  readonly devices: Pick<DeviceManagerApi, 'loadConfig' | 'remove'>
  readonly addonId: string
  readonly integrationId: string
  readonly logger: IScopedLogger
}): Promise<number> {
  const { reg, devices, addonId, integrationId, logger } = input
  let removed = 0
  for (const d of reg.getAllForAddon(addonId)) {
    // Only process top-level (parent) devices — children cascade via kernel.
    if (d.parentDeviceId !== null) continue
    const cfg = await devices.loadConfig(d.id).catch((): Record<string, unknown> => ({}))
    // Homematic provenance is stored at the top level of the config blob as
    // `{ system: 'homematic', integrationId }`.
    if (cfg['system'] !== 'homematic' || cfg['integrationId'] !== integrationId) continue
    try {
      await devices.remove(d.id)
      removed += 1
    } catch (err) {
      logger.warn('homematic: integration cascade-remove failed', {
        tags: { deviceId: d.id },
        meta: { integrationId, error: errMsg(err) },
      })
    }
  }
  return removed
}
