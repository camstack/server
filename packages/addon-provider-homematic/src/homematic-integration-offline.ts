/**
 * Narrow interface covering the three members the helper touches on a device.
 * Both `IDevice` (production) and test fakes satisfy it structurally without
 * any casts.
 */
export interface OfflineTarget {
  readonly online: boolean
  readonly config: { get(key: string): unknown }
  markOnline(online: boolean): void
}

/**
 * Set every Homematic device belonging to `integrationId` (the CCU box and
 * its products) to the requested online state. Called in two directions:
 *
 * - **offline** (`online: false`): when the CCU connection drops — devices
 *   that have lost their physical link should not appear reachable in the UI.
 * - **online** (`online: true`): when the CCU reconnects — restores liveness
 *   for the devices whose session is back.
 *
 * `devices` is the addon-scoped device list (`deviceRegistry.getAllForAddon`),
 * so the only remaining filter is the integration id. Every Homematic device
 * (the CCU box, a Container, and each accessory child) carries it in its config
 * blob.
 *
 * The helper is churn-free: it skips any device already in the target state,
 * so reconnect storms do not produce spurious `markOnline` events.
 *
 * Returns the count of devices whose state was actually changed.
 */
export function setIntegrationDevicesOnline(
  devices: ReadonlyArray<OfflineTarget>,
  integrationId: string,
  online: boolean,
): number {
  let count = 0
  for (const dev of devices) {
    if (dev.config.get('integrationId') !== integrationId) continue
    if (dev.online === online) continue
    dev.markOnline(online)
    count += 1
  }
  return count
}
