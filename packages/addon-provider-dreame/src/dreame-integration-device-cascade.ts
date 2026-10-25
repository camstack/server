import {
  errMsg,
  type IDeviceRegistry,
  type DeviceManagerApi,
  type IScopedLogger,
} from '@camstack/types'

/**
 * Remove every adopted Dreame PARENT device (children cascade via the kernel)
 * whose persisted config carries `{ system: 'dreame', brokerId: integrationId }`.
 * Used when an integration is deleted. Best-effort per device; returns the count
 * removed.
 *
 * NOTE: the persisted config field is still named `brokerId` (unchanged
 * device-side schema) but under the account model it holds the `integrationId`.
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
    if (d.parentDeviceId !== null) continue
    const cfg = await devices.loadConfig(d.id).catch((): Record<string, unknown> => ({}))
    if (cfg['system'] !== 'dreame' || cfg['brokerId'] !== integrationId) continue
    try {
      await devices.remove(d.id)
      removed += 1
    } catch (err) {
      logger.warn('dreame: integration cascade-remove failed', {
        tags: { deviceId: d.id },
        meta: { integrationId, error: errMsg(err) },
      })
    }
  }
  return removed
}
