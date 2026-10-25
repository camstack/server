import type { IDevice } from '@camstack/types'

/**
 * Mark every HA device of `brokerId` — containers AND their entity-children —
 * `online=false`. Called when the broker's WS drops (A2): `device.online` is
 * the single source of truth for liveness, and an entity that never publishes
 * another push (because the WS is gone) would otherwise stay stale-online
 * forever. Reconnect restores online via the per-child availability chokepoint
 * (A1) on the next real state push; the container derives its own online from
 * its children (A3), so no online-true write happens here.
 *
 * `devices` is the addon-scoped device list (`ctx.kernel.devices.getAll()`,
 * already filtered to THIS addon). The only remaining filter is the broker:
 * both containers (`system:'homeassistant'`) and entity-children (no `system`
 * field) carry `brokerId` in their config. `markOnline` no-ops when unchanged,
 * so the pass is churn-free.
 *
 * Returns the count of devices transitioned to offline.
 */
export function markBrokerDevicesOffline(
  devices: ReadonlyArray<IDevice>,
  brokerId: string,
): number {
  let marked = 0
  for (const dev of devices) {
    if (dev.config.get('brokerId') !== brokerId) continue
    if (!dev.online) continue
    dev.markOnline(false)
    marked += 1
  }
  return marked
}
