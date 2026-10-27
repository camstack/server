import {
  errMsg,
  type DeviceManagerApi,
  type IDeviceRegistry,
  type IScopedLogger,
} from '@camstack/types'

/** The three members this helper touches on a device; test fakes satisfy it structurally. */
export interface OfflineTarget {
  readonly online: boolean
  readonly config: { get(key: string): unknown }
  markOnline(online: boolean): void
}

/**
 * Flip every device of `brokerId` to the requested online state. A board that
 * drops is offline, not zero: the children keep their last reading and only the
 * liveness changes. Churn-free: a device already in the target state is skipped.
 * Returns the number of devices changed.
 */
export function setBrokerDevicesOnline(
  devices: ReadonlyArray<OfflineTarget>,
  brokerId: string,
  online: boolean,
): number {
  let count = 0
  for (const dev of devices) {
    if (dev.config.get('brokerId') !== brokerId) continue
    if (dev.online === online) continue
    dev.markOnline(online)
    count += 1
  }
  return count
}

/**
 * Remove every adopted board container sourced from `brokerId` (children cascade
 * through the kernel). Best-effort per device. Returns the number removed.
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
    if (cfg['system'] !== 'esphome' || cfg['brokerId'] !== brokerId) continue
    try {
      await devices.remove(d.id)
      removed += 1
    } catch (err: unknown) {
      logger.warn('esphome: broker cascade-remove failed', {
        tags: { deviceId: d.id },
        meta: { brokerId, error: errMsg(err) },
      })
    }
  }
  return removed
}
