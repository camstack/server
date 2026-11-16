import { errMsg, type DeviceManagerApi, type IScopedLogger } from '@camstack/types'
import {
  UNIFI_SYSTEM,
  type UnifiFeatureDescriptor,
  unifiFeatureDescriptorSchema,
} from './config.js'
import { buildInfraFeatures, featuresEqual, mergeInfraFeatures } from './unifi-mapping.js'
import { unifiControllers } from './unifi-node-resolver.js'

/** Narrow a persisted `features[]` blob to descriptors; an entry that does not parse is skipped. */
function readDescriptors(raw: readonly unknown[]): UnifiFeatureDescriptor[] {
  const out: UnifiFeatureDescriptor[] = []
  for (const entry of raw) {
    const parsed = unifiFeatureDescriptorSchema.safeParse(entry)
    if (parsed.success) out.push(parsed.data)
  }
  return out
}

/**
 * Re-derive every adopted infra Container's `features[]` of this integration from the live
 * snapshot and re-persist via `applyDerivedSpec` when it changed, so new ports and sensors
 * appear without re-adoption. Best-effort per device; returns how many changed. Additive
 * (`mergeInfraFeatures`): a port or sensor missing from one poll is a read that did not answer,
 * never a child to prune; a device the controller no longer lists is left alone.
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
    const current = readDescriptors(Array.isArray(cfg['features']) ? cfg['features'] : [])
    const next = mergeInfraFeatures(current, buildInfraFeatures(infra))
    if (featuresEqual(current, next)) continue
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
