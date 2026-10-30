import { type DeviceManagerApi, errMsg, type IScopedLogger } from '@camstack/types'

/** The part of the device registry the cascade reads: which devices the addon owns, and their parent. */
export interface RademacherDeviceRegistryView {
  getAllForAddon(
    addonId: string,
  ): ReadonlyArray<{ readonly id: number; readonly parentDeviceId: number | null }>
}

/**
 * Remove every top-level Rademacher device of an integration that went away. Children
 * (a window's cover and rain sensor) go with their container.
 */
export async function cascadeRemoveDevicesForIntegration(input: {
  readonly reg: RademacherDeviceRegistryView
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
    if (cfg['system'] !== 'rademacher' || cfg['integrationId'] !== integrationId) continue
    try {
      await devices.remove(d.id)
      removed += 1
    } catch (err) {
      logger.warn('rademacher: integration cascade-remove failed', {
        tags: { deviceId: d.id },
        meta: { integrationId, error: errMsg(err) },
      })
    }
  }
  return removed
}
