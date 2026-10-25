/**
 * One-time integration-id backfill for devices created before the
 * device-manager forwarder started stamping `integrationId` (camera
 * providers). Maps each addon that hosts EXACTLY ONE integration to that
 * integration id, then stamps top-level untagged devices of those addons.
 * Multi-instance addons (e.g. Home Assistant with several brokers) are
 * ambiguous on `addonId` alone and are skipped — they stamp going forward.
 */

export interface BackfillIntegration {
  readonly id: string
  readonly addonId: string
}

export interface BackfillDevice {
  readonly id: number
  readonly addonId: string
  readonly parentDeviceId: number | null
  readonly integrationId?: string
}

export interface BackfillStamp {
  readonly deviceId: number
  readonly integrationId: string
}

export function planIntegrationIdBackfill(
  integrations: readonly BackfillIntegration[],
  devices: readonly BackfillDevice[],
): readonly BackfillStamp[] {
  const singleByAddon = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const integration of integrations) {
    if (ambiguous.has(integration.addonId)) continue
    if (singleByAddon.has(integration.addonId)) {
      singleByAddon.delete(integration.addonId)
      ambiguous.add(integration.addonId)
      continue
    }
    singleByAddon.set(integration.addonId, integration.id)
  }

  const stamps: BackfillStamp[] = []
  for (const device of devices) {
    if (device.parentDeviceId !== null) continue
    if (device.integrationId !== undefined && device.integrationId !== '') continue
    const integrationId = singleByAddon.get(device.addonId)
    if (integrationId === undefined) continue
    stamps.push({ deviceId: device.id, integrationId })
  }
  return stamps
}

/**
 * Stamps to apply at integration-DELETE time so a cascade removes legacy
 * un-tagged devices too. The boot backfill only runs on startup; a device
 * created before stamping (or whose provider never stamps, e.g. `provider-rtsp`)
 * keeps no `integrationId`, so once its integration is deleted it would orphan
 * forever — `removeByIntegration` matches on `integrationId` and finds nothing.
 *
 * Run this in the delete handler BEFORE deleting the integration record (while
 * it is still present in `integrations`), then stamp the returned devices and
 * let `removeByIntegration` cascade them. Reuses the boot backfill's safety
 * rule (only addons hosting exactly ONE integration are unambiguous) and
 * filters to the integration being deleted so siblings are never touched.
 */
export function planDeleteTimeStamps(
  integrationId: string,
  integrations: readonly BackfillIntegration[],
  devices: readonly BackfillDevice[],
): readonly BackfillStamp[] {
  return planIntegrationIdBackfill(integrations, devices).filter(
    (stamp) => stamp.integrationId === integrationId,
  )
}

export interface BackfillLogger {
  readonly info: (message: string, meta?: Record<string, unknown>) => void
  readonly warn: (message: string, meta?: Record<string, unknown>) => void
}

export interface IntegrationIdBackfillDeps {
  readonly listIntegrations: () => Promise<readonly BackfillIntegration[]>
  readonly listDevices: () => Promise<readonly BackfillDevice[]>
  readonly setIntegrationId: (deviceId: number, integrationId: string) => Promise<void>
  readonly logger: BackfillLogger
}

export async function runIntegrationIdBackfill(
  deps: IntegrationIdBackfillDeps,
): Promise<{ stamped: number }> {
  const [integrations, devices] = await Promise.all([deps.listIntegrations(), deps.listDevices()])
  const stamps = planIntegrationIdBackfill(integrations, devices)
  let stamped = 0
  for (const stamp of stamps) {
    try {
      await deps.setIntegrationId(stamp.deviceId, stamp.integrationId)
      stamped++
    } catch (err) {
      deps.logger.warn('integrationId backfill: stamp failed', {
        deviceId: stamp.deviceId,
        integrationId: stamp.integrationId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  if (stamped > 0) deps.logger.info('integrationId backfill complete', { stamped })
  return { stamped }
}
