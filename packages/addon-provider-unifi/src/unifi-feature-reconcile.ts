import { errMsg, type DeviceManagerApi, type IScopedLogger } from '@camstack/types'
import { UNIFI_SYSTEM } from './config.js'
import { buildInfraFeatures, featuresEqual } from './unifi-mapping.js'
import { unifiControllers } from './unifi-node-resolver.js'

/** Narrow a persisted `features[]` blob to descriptors for the equality check. */
function readDescriptors(raw: readonly unknown[]): Parameters<typeof featuresEqual>[0] {
  const out: Array<Parameters<typeof featuresEqual>[0][number]> = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const rec: Record<string, unknown> = Object.fromEntries(Object.entries(entry))
    const kind = rec['kind']
    if (kind !== 'switch' && kind !== 'button' && kind !== 'sensor') continue
    const metric = rec['metric']
    out.push({
      kind,
      ...(rec['switchFeature'] === 'poe' || rec['switchFeature'] === 'led'
        ? { switchFeature: rec['switchFeature'] }
        : {}),
      ...(rec['buttonAction'] === 'restart' || rec['buttonAction'] === 'power-cycle'
        ? { buttonAction: rec['buttonAction'] }
        : {}),
      ...(typeof rec['portIdx'] === 'number' ? { portIdx: rec['portIdx'] } : {}),
      ...(metric === 'cpu_utilization' ||
      metric === 'cpu_temperature' ||
      metric === 'clients' ||
      metric === 'state' ||
      metric === 'uptime'
        ? { metric }
        : {}),
    })
  }
  return out
}

/**
 * Re-derive every adopted infra Container's `features[]` of this integration from the live
 * snapshot and re-persist via `applyDerivedSpec` when it changed, so new ports and sensors
 * appear without re-adoption. Best-effort per device; returns how many changed. A device
 * the controller no longer lists is left alone (never pruned on a failed read).
 */
export async function reconcileInfraFeatures(input: {
  readonly reg: {
    getAllForAddon(addonId: string): ReadonlyArray<{
      readonly id: number
      readonly parentDeviceId: number | null
    }>
  }
  readonly devices: Pick<DeviceManagerApi, 'loadConfig' | 'applyDerivedSpec'>
  readonly addonId: string
  readonly integrationId: string
  readonly logger: IScopedLogger
}): Promise<number> {
  const { reg, devices, addonId, integrationId, logger } = input
  let changed = 0
  for (const d of reg.getAllForAddon(addonId)) {
    if (d.parentDeviceId !== null) continue
    const cfg = await devices.loadConfig(d.id).catch((): Record<string, unknown> => ({}))
    if (cfg['system'] !== UNIFI_SYSTEM || cfg['integrationId'] !== integrationId) continue
    const infraId = cfg['infraNativeId']
    if (typeof infraId !== 'string') continue
    const infra = unifiControllers.getInfra(integrationId, infraId)
    if (infra === null) continue
    const next = buildInfraFeatures(infra)
    const current = Array.isArray(cfg['features']) ? cfg['features'] : []
    if (featuresEqual(readDescriptors(current), next)) continue
    try {
      await devices.applyDerivedSpec(d.id, { config: { features: next } })
      changed += 1
      logger.info('UniFi: infra features reconciled', {
        tags: { deviceId: d.id },
        meta: { integrationId, infraId, featureCount: next.length },
      })
    } catch (err) {
      logger.warn('UniFi: infra feature reconcile failed', {
        tags: { deviceId: d.id },
        meta: { integrationId, error: errMsg(err) },
      })
    }
  }
  return changed
}
