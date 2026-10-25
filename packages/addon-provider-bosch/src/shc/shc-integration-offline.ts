export interface OfflineTarget {
  readonly online: boolean
  readonly config: { get(key: string): unknown }
  markOnline(online: boolean): void
}

export function setIntegrationDevicesOnline(
  devices: ReadonlyArray<OfflineTarget>,
  integrationId: string,
  online: boolean,
): number {
  let count = 0
  for (const dev of devices) {
    if (dev.config.get('system') !== 'bosch-shc') continue
    if (dev.config.get('brokerId') !== integrationId) continue
    if (dev.online === online) continue
    dev.markOnline(online)
    count += 1
  }
  return count
}
