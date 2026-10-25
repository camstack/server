import {
  errMsg,
  type DeviceManagerApi,
  type IDeviceRegistry,
  type IScopedLogger,
} from '@camstack/types'

export async function cascadeRemoveDevicesForIntegration(input: {
  readonly reg: Pick<IDeviceRegistry, 'getAllForAddon'>
  readonly devices: Pick<DeviceManagerApi, 'loadConfig' | 'remove'>
  readonly addonId: string
  readonly system: string
  readonly integrationId: string
  readonly logger: IScopedLogger
}): Promise<number> {
  const { reg, devices, addonId, system, integrationId, logger } = input
  let removed = 0
  for (const d of reg.getAllForAddon(addonId)) {
    if (d.parentDeviceId !== null) continue
    const cfg = await devices.loadConfig(d.id).catch((): Record<string, unknown> => ({}))
    if (cfg['system'] !== system || cfg['brokerId'] !== integrationId) continue
    try {
      await devices.remove(d.id)
      removed += 1
    } catch (err) {
      logger.warn(`${system}: integration cascade-remove failed`, {
        tags: { deviceId: d.id },
        meta: { integrationId, error: errMsg(err) },
      })
    }
  }
  return removed
}
