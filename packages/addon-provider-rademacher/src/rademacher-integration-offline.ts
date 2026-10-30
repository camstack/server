export interface OfflineTarget {
  readonly online: boolean
  readonly config: { get(key: string): unknown }
  markOnline(online: boolean): void
}

/**
 * Flip every Rademacher device of an integration (the hub box and its covers)
 * online or offline with its session. Returns how many changed.
 */
export function setIntegrationDevicesOnline(
  devices: ReadonlyArray<OfflineTarget>,
  integrationId: string,
  online: boolean,
): number {
  let count = 0
  for (const dev of devices) {
    if (dev.config.get('system') !== 'rademacher') continue
    if (dev.config.get('integrationId') !== integrationId) continue
    if (dev.online === online) continue
    dev.markOnline(online)
    count += 1
  }
  return count
}
