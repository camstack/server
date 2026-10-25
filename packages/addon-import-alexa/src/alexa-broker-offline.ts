/** Narrow interface covering the members the helper touches on a device. */
export interface OfflineTarget {
  readonly online: boolean
  readonly config: { get(key: string): unknown }
  markOnline(online: boolean): void
}

/**
 * Set every Alexa device belonging to `brokerId` to the requested online state.
 * Every Alexa device carries `{ system: 'alexa', brokerId }`. Churn-free;
 * returns the count transitioned. Mirrors the Ecowitt offline helper.
 */
export function setBrokerDevicesOnline(
  devices: ReadonlyArray<OfflineTarget>,
  brokerId: string,
  online: boolean,
): number {
  let count = 0
  for (const dev of devices) {
    if (dev.config.get('system') !== 'alexa') continue
    if (dev.config.get('brokerId') !== brokerId) continue
    if (dev.online === online) continue
    dev.markOnline(online)
    count += 1
  }
  return count
}
