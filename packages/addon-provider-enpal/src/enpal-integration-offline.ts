import { ENPAL_SYSTEM } from './config.js'

export interface OfflineTarget {
  readonly online: boolean
  readonly config: { get(key: string): unknown }
  markOnline(online: boolean): void
}

/**
 * Set every Enpal device of `integrationId` (containers and their sensors) to `online`.
 * Churn-free: a device already in that state is left alone. Returns how many changed.
 */
export function setIntegrationDevicesOnline(
  devices: ReadonlyArray<OfflineTarget>,
  integrationId: string,
  online: boolean,
): number {
  let count = 0
  for (const dev of devices) {
    if (dev.config.get('system') !== ENPAL_SYSTEM) continue
    if (dev.config.get('integrationId') !== integrationId) continue
    if (dev.online === online) continue
    dev.markOnline(online)
    count += 1
  }
  return count
}
