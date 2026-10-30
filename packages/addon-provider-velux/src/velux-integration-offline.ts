export interface OfflineTarget {
  readonly online: boolean
  readonly config: { get(key: string): unknown }
  markOnline(online: boolean): void
}

/**
 * Flip every Velux device of an integration (the gateway box, containers,
 * covers, rain sensors) online or offline with its session. Returns how many
 * changed.
 */
export function setIntegrationDevicesOnline(
  devices: ReadonlyArray<OfflineTarget>,
  integrationId: string,
  online: boolean,
): number {
  let count = 0
  for (const dev of devices) {
    if (dev.config.get('system') !== 'velux') continue
    if (dev.config.get('integrationId') !== integrationId) continue
    if (dev.online === online) continue
    dev.markOnline(online)
    count += 1
  }
  return count
}
