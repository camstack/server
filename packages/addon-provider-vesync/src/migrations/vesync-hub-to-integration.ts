/**
 * D987 / #259 — a VeSync account used to be a Hub DEVICE with credentials in
 * `config.connection` and its purifiers parented under it. Now the account is an
 * integration (a typed record, password through the keychain) and the purifiers are
 * top-level devices stamped with that id. The account itself is a Gateway sibling.
 *
 * For every Hub row, each step safe to observe already done:
 *
 *   1. create (or reuse, by `originStableId`) the integration, with the connection as
 *      settings and the password through the keychain;
 *   2. put the account record and read the password back — a mismatch or a locked
 *      secret leaves the hub in place;
 *   3. re-stamp every purifier and accessory with the integration id, keeping
 *      `deviceId`, `stableId` and every other field of the blob;
 *   4. restore the purifiers top-level, so none is parented under the hub;
 *   5. create the Gateway device as a sibling (parent null);
 *   6. only when no child is left under the hub, retire it by tombstone.
 *
 * A locked password is never read as an empty one and no replacement is minted.
 */
import {
  DeviceType,
  errMsg,
  isSecretMarkerLike,
  type MigrationProcedureResult,
  type SavedDevice,
} from '@camstack/types'
import { settingsToConnection } from '../config.js'
import type { VeSyncMigrationPorts } from './ports.js'

function hasNoConnection(hub: SavedDevice): boolean {
  const raw = hub.config['connection']
  return typeof raw !== 'object' || raw === null
}

interface MovedConnection {
  readonly settings: Record<string, unknown>
  readonly secretKeys: readonly string[]
  readonly password: string
}

/** The persisted `connection` of a hub row as flat account settings, or why not. */
function connectionSettings(hub: SavedDevice): MovedConnection {
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
  const connection = settingsToConnection(raw)
  const settings: Record<string, unknown> = {
    email: connection.email,
    region: connection.region,
    pollIntervalMs: connection.pollIntervalMs,
  }
  if (connection.password.length > 0) {
    settings['password'] = connection.password
    return { settings, secretKeys: ['password'], password: connection.password }
  }
  return { settings, secretKeys: [], password: '' }
}

/**
 * Every row that belongs to the hub: direct children, and anything parented under
 * those (accessories), plus a row a dead run already un-parented whose `accountId`
 * is still the hub stableId.
 */
function familyOf(hub: SavedDevice, rows: readonly SavedDevice[]): readonly SavedDevice[] {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const memo = new Map<number, boolean>()
  const belongs = (row: SavedDevice, stack: ReadonlySet<number>): boolean => {
    const cached = memo.get(row.id)
    if (cached !== undefined) return cached
    if (stack.has(row.id)) return false
    const next = new Set(stack)
    next.add(row.id)
    let yes = row.parentDeviceId === hub.id || row.config['accountId'] === hub.stableId
    if (!yes && row.parentDeviceId !== null) {
      const parent = byId.get(row.parentDeviceId)
      if (parent !== undefined && parent.id !== hub.id) yes = belongs(parent, next)
    }
    memo.set(row.id, yes)
    return yes
  }
  return rows.filter((row) => row.id !== hub.id && belongs(row, new Set()))
}

async function readPasswordBack(
  hub: SavedDevice,
  integrationId: string,
  password: string,
  ports: VeSyncMigrationPorts,
): Promise<void> {
  const back = await ports.readAccountRecord(integrationId)
  if (back === null) {
    throw new Error(`hub ${hub.id}: account record missing after it was put — left in place`)
  }
  if (password.length === 0) return
  const got = back['password']
  if (isSecretMarkerLike(got)) {
    throw new Error(
      `hub ${hub.id}: password is stored but the keychain cannot serve it now — left in place`,
    )
  }
  if (got !== password) {
    throw new Error(
      `hub ${hub.id}: password did not read back from the account record — left in place`,
    )
  }
}

async function migrateOneHub(
  hub: SavedDevice,
  rows: readonly SavedDevice[],
  ports: VeSyncMigrationPorts,
): Promise<{ readonly children: number; readonly integrationId: string | null }> {
  const family = familyOf(hub, rows)
  if (hasNoConnection(hub) && family.length === 0) {
    if ((await ports.childIdsOf(hub.id)).length > 0) {
      throw new Error(
        `hub ${hub.id} has no connection and a child the saved rows do not show — kept`,
      )
    }
    await ports.removeDevice(hub.id)
    return { children: 0, integrationId: null }
  }
  const moved = connectionSettings(hub)
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
        settings: moved.settings,
        secretKeys: moved.secretKeys,
      })
    ).id

  const body: Record<string, unknown> = { name: hub.name, ...moved.settings }
  await ports.putAccountRecord(integrationId, body)
  await readPasswordBack(hub, integrationId, moved.password, ports)

  for (const row of family) {
    await ports.persistConfig(row.stableId, { ...row.config, integrationId })
    await ports.setIntegrationId(row.id, integrationId)
  }
  const lifted = family
    .filter((row) => row.parentDeviceId === hub.id)
    .map(
      (row): SavedDevice => ({
        ...row,
        config: { ...row.config, integrationId },
        parentDeviceId: null,
      }),
    )
  if (lifted.length > 0) await ports.restoreRows(lifted)

  await ports.createGateway({ integrationId, name: hub.name })

  const remaining = await ports.childIdsOf(hub.id)
  if (remaining.length > 0) {
    throw new Error(
      `hub ${hub.id} still has ${remaining.length} child(ren) after the restore — kept, retiring it would remove them`,
    )
  }
  await ports.removeDevice(hub.id)
  return { children: family.length, integrationId }
}

/** The procedure body. Idempotent: no Hub row left means the work is done. */
export async function migrateVeSyncHubs(
  ports: VeSyncMigrationPorts,
): Promise<MigrationProcedureResult> {
  const rows = await ports.listSavedDevices()
  const hubs = rows.filter((row) => row.type === DeviceType.Hub)
  if (hubs.length === 0) return { outcome: 'already-done', summary: { hubs: 0 } }
  const migrated: Array<{
    hubDeviceId: number
    integrationId: string | null
    children: number
  }> = []
  const failed: Array<{ hubDeviceId: number; error: string }> = []
  for (const hub of hubs) {
    try {
      const done = await migrateOneHub(hub, rows, ports)
      migrated.push({ hubDeviceId: hub.id, ...done })
      ports.logger.info(
        done.integrationId === null
          ? 'VeSync hub with no connection and no children retired'
          : 'VeSync hub migrated to an integration with a Gateway sibling',
        {
          tags: { deviceId: hub.id },
          meta: { integrationId: done.integrationId, children: done.children },
        },
      )
    } catch (err) {
      ports.logger.warn('VeSync hub migration failed — the hub device is left in place', {
        tags: { deviceId: hub.id },
        meta: { error: errMsg(err) },
      })
      failed.push({ hubDeviceId: hub.id, error: errMsg(err) })
    }
  }
  if (failed.length > 0) {
    throw new Error(
      `vesync hub migration: ${failed.length} of ${hubs.length} hub(s) not migrated — ` +
        failed.map((f) => `hub ${f.hubDeviceId}: ${f.error}`).join('; '),
    )
  }
  return { outcome: 'done', summary: { hubs: migrated.length, migrated } }
}
