import { errMsg, type DeviceManagerApi, type IScopedLogger } from '@camstack/types'
import { UNRAID_SYSTEM } from './config.js'
import { UNRAID_INSTANCE_ID } from './unraid-discovery.js'
import type { UnraidSnapshot } from './unraid-client-contract.js'
import { buildEntityIdentities, type UnraidEntityIdentity } from './unraid-mapping.js'

/** The entity identity list for a snapshot (empty before the first poll). */
export function identitiesOf(snapshot: UnraidSnapshot | null): readonly UnraidEntityIdentity[] {
  return snapshot === null ? [] : buildEntityIdentities(snapshot)
}

/**
 * Structural equality of a persisted identity list vs a freshly-derived one. Order is
 * deterministic (the mapping emits a stable order), so a positional JSON compare suffices.
 */
function identitiesEqual(a: readonly unknown[], b: readonly UnraidEntityIdentity[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < b.length; i += 1) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return false
  }
  return true
}

/**
 * Re-derive the integration's instance Container `entities[]` from the live snapshot and
 * re-persist via `applyDerivedSpec` when it changed, so new containers and disks appear and
 * removed ones prune without re-adoption. Best-effort per device; returns how many changed.
 */
export async function reconcileInstanceEntities(input: {
  readonly reg: {
    getAllForAddon(addonId: string): ReadonlyArray<{
      readonly id: number
      readonly parentDeviceId: number | null
    }>
  }
  readonly devices: Pick<DeviceManagerApi, 'loadConfig' | 'applyDerivedSpec'>
  readonly addonId: string
  readonly integrationId: string
  readonly snapshot: UnraidSnapshot | null
  readonly logger: IScopedLogger
}): Promise<number> {
  const { reg, devices, addonId, integrationId, snapshot, logger } = input
  // Without a snapshot there is nothing to derive from: never prune on a failed read.
  if (snapshot === null) return 0
  const next = identitiesOf(snapshot)
  let changed = 0
  for (const d of reg.getAllForAddon(addonId)) {
    if (d.parentDeviceId !== null) continue
    const cfg = await devices.loadConfig(d.id).catch((): Record<string, unknown> => ({}))
    if (cfg['system'] !== UNRAID_SYSTEM || cfg['integrationId'] !== integrationId) continue
    if (cfg['nativeId'] !== UNRAID_INSTANCE_ID) continue
    const current = Array.isArray(cfg['entities']) ? cfg['entities'] : []
    if (identitiesEqual(current, next)) continue
    try {
      await devices.applyDerivedSpec(d.id, { config: { entities: next } })
      changed += 1
      logger.info('Unraid: entities reconciled', {
        tags: { deviceId: d.id },
        meta: { integrationId, entityCount: next.length },
      })
    } catch (err) {
      logger.warn('Unraid: entity reconcile failed', {
        tags: { deviceId: d.id },
        meta: { integrationId, error: errMsg(err) },
      })
    }
  }
  return changed
}
