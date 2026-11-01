/**
 * D987 / #259 — the Ecowitt gateway used to be a Hub DEVICE holding the connection in its
 * config, with the station's group Containers as its children and their sensors below them.
 * Now the gateway is an INTEGRATION (connection in its keychain-backed settings), the group
 * Containers are top-level, and the gateway device is a Gateway SIBLING of them.
 *
 * For every Hub row, in order, each step safe to observe already done:
 *
 *   1. create (or reuse, by `originStableId` = the hub's stableId) the integration, with the
 *      connection as settings and the password through the keychain;
 *   2. re-stamp every Container and Sensor under the hub with the integration id, keeping its
 *      `deviceId`, `stableId`, name and every field of its persisted blob (history follows the id);
 *   3. restore the Containers top-level, so none is parented under the hub any more;
 *   4. create the Gateway device as a sibling (parent null);
 *   5. only when no child is left under the hub, retire it by tombstone. A hub that still has a
 *      child is NEVER removed (it would cascade): the migration fails and the hub stays.
 *
 * A locked password is never read as an empty one and no replacement is minted.
 */
import { DeviceType, errMsg, isSecretMarkerLike, type SavedDevice } from '@camstack/types'
import type { MigrationProcedureResult } from '@camstack/types'
import { settingsToEcowittConfig } from '../config.js'
import type { EcowittMigrationPorts } from './ports.js'

/** The persisted `connection` of a hub row as the flat settings of the integration, or why not. */
function connectionSettings(hub: SavedDevice): {
  readonly settings: Record<string, unknown>
  readonly secretKeys: readonly string[]
} {
  const raw = hub.config['connection']
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`hub ${hub.id} has no connection to move — left in place`)
  }
  const password = Reflect.get(raw, 'password')
  if (isSecretMarkerLike(password)) {
    throw new Error(
      `hub ${hub.id} password is stored but the keychain cannot serve it now — left in place, retry once it is unlocked`,
    )
  }
  const connection = settingsToEcowittConfig(raw)
  const settings: Record<string, unknown> = { ...connection }
  if (connection.transport === 'local' && connection.password.length > 0) {
    return { settings, secretKeys: ['password'] }
  }
  delete settings['password']
  return { settings, secretKeys: [] }
}

/** Every row below `rootId`, container first then its sensors (any depth). */
function descendantsOf(rootId: number, rows: readonly SavedDevice[]): readonly SavedDevice[] {
  const out: SavedDevice[] = []
  let frontier = [rootId]
  while (frontier.length > 0) {
    const next = rows.filter(
      (row) => row.parentDeviceId !== null && frontier.includes(row.parentDeviceId),
    )
    out.push(...next)
    frontier = next.map((row) => row.id)
  }
  return out
}

async function migrateOneHub(
  hub: SavedDevice,
  rows: readonly SavedDevice[],
  ports: EcowittMigrationPorts,
): Promise<{ readonly children: number; readonly integrationId: string }> {
  const { settings, secretKeys } = connectionSettings(hub)
  const integrations = await ports.listIntegrations()
  const existing = integrations.find(
    (i) => i.addonId === ports.addonId && i.originStableId === hub.stableId,
  )
  const integrationId =
    existing?.id ??
    (
      await ports.createIntegration({
        addonId: ports.addonId,
        name: hub.name,
        info: {},
        originStableId: hub.stableId,
        settings,
        secretKeys,
      })
    ).id

  const below = descendantsOf(hub.id, rows)
  for (const row of below) {
    await ports.persistConfig(row.stableId, { ...row.config, integrationId })
    await ports.setIntegrationId(row.id, integrationId)
  }
  const containers = below
    .filter((row) => row.type === DeviceType.Container && row.parentDeviceId === hub.id)
    .map(
      (row): SavedDevice => ({
        ...row,
        config: { ...row.config, integrationId },
        parentDeviceId: null,
      }),
    )
  if (containers.length > 0) await ports.restoreRows(containers)

  await ports.createGateway({ integrationId, name: hub.name })

  const remaining = await ports.childIdsOf(hub.id)
  if (remaining.length > 0) {
    throw new Error(
      `hub ${hub.id} still has ${remaining.length} child(ren) after the restore — kept, retiring it would remove them`,
    )
  }
  await ports.removeDevice(hub.id)
  return { children: below.length, integrationId }
}

/** The procedure body. Idempotent: no Hub row left means the work is done. */
export async function migrateEcowittHubs(
  ports: EcowittMigrationPorts,
): Promise<MigrationProcedureResult> {
  const rows = await ports.listSavedDevices()
  const hubs = rows.filter((row) => row.type === DeviceType.Hub)
  if (hubs.length === 0) return { outcome: 'already-done', summary: { hubs: 0 } }
  const migrated: Array<{
    hubDeviceId: number
    integrationId: string
    children: number
  }> = []
  for (const hub of hubs) {
    try {
      const done = await migrateOneHub(hub, rows, ports)
      migrated.push({ hubDeviceId: hub.id, ...done })
      ports.logger.info('Ecowitt hub migrated to an integration with a Gateway sibling', {
        tags: { deviceId: hub.id },
        meta: { integrationId: done.integrationId, children: done.children },
      })
    } catch (err) {
      ports.logger.warn('Ecowitt hub migration failed — the hub device is left in place', {
        tags: { deviceId: hub.id },
        meta: { error: errMsg(err) },
      })
      throw err
    }
  }
  return { outcome: 'done', summary: { hubs: migrated.length, migrated } }
}
