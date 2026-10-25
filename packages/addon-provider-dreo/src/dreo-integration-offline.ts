/**
 * Narrow interface covering the three members the helper touches on a device.
 * Both `IDevice` (production) and test fakes satisfy it structurally — no cast.
 */
export interface OfflineTarget {
  readonly online: boolean
  readonly config: { get(key: string): unknown }
  markOnline(online: boolean): void
}

/**
 * Set every Dreo device belonging to `integrationId` to the requested online
 * state. `devices` is the addon-scoped device list; every Dreo top-level
 * Container carries `{ system: 'dreo', brokerId: integrationId }` in its config
 * blob (the `brokerId` field name is unchanged; it now holds the integrationId).
 *
 * Churn-free: skips any device already in the target state. Returns the count of
 * devices actually transitioned.
 */
export function setIntegrationDevicesOnline(
  devices: ReadonlyArray<OfflineTarget>,
  integrationId: string,
  online: boolean,
): number {
  let count = 0
  for (const dev of devices) {
    if (dev.config.get('system') !== 'dreo') continue
    if (dev.config.get('brokerId') !== integrationId) continue
    if (dev.online === online) continue
    dev.markOnline(online)
    count += 1
  }
  return count
}
