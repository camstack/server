/**
 * D985 — boot migration of the old Reolink Hub DEVICE into an INTEGRATION.
 *
 * A Hub used to be a device with the NVR's credentials in its config and its channels as
 * parented child cameras. Now the NVR is an integration (credentials in its keychain-backed
 * settings) and the channels are top-level cameras stamped with its id. For every Hub row:
 *
 *   1. create (or reuse) an integration named after it, config + password moved as settings;
 *   2. keep every child's deviceId and stableId, stamp it with the integrationId, un-parent it
 *      and make sure its persisted blob can be restored on its own;
 *   3. only AFTER the children restored and the hub has none left, retire the hub by tombstone.
 *
 * Idempotent (a second run finds no Hub rows) and all-or-nothing per hub: a step that throws
 * leaves the hub device and its children's parentage exactly as they were, and the next boot
 * starts over. A locked secret is never read as an empty password and no replacement is minted.
 */
import { DeviceType, errMsg, type IScopedLogger, type SavedDevice } from '@camstack/types'
import { readHubConnection } from './hub-connection.js'
import { reolinkHubStableId } from './reolink-discovery-map.js'

export interface MigrationIntegration {
  readonly id: string
  readonly addonId: string
  readonly name: string
  readonly info: Readonly<Record<string, unknown>>
  readonly originStableId?: string | undefined
}

export interface CreateHubIntegrationInput {
  readonly addonId: string
  readonly name: string
  readonly info: Readonly<Record<string, unknown>>
  readonly originStableId: string
  readonly settings: Readonly<Record<string, unknown>>
  readonly secretKeys: readonly string[]
}

/** Everything the migration touches outside itself, so a spec can drive it without a kernel. */
export interface HubMigrationPorts {
  readonly addonId: string
  readonly logger: IScopedLogger
  listIntegrations(): Promise<readonly MigrationIntegration[]>
  createIntegration(input: CreateHubIntegrationInput): Promise<{ readonly id: string }>
  setIntegrationId(deviceId: number, integrationId: string): Promise<void>
  /** Overwrite a device's persisted blob (what `persistInitialConfig` does). */
  persistConfig(stableId: string, config: Record<string, unknown>): Promise<void>
  /** The ids of the devices still parented under `parentDeviceId`, read from the store. */
  childIdsOf(parentDeviceId: number): Promise<readonly number[]>
  /** Retire a device: removes it and writes the tombstone (D865). */
  removeDevice(deviceId: number): Promise<void>
}

export interface PendingHubRetirement {
  readonly hubDeviceId: number
  readonly hubName: string
  readonly integrationId: string
}

export interface HubMigrationPlan {
  /** The rows the provider restores: Hub rows gone, migrated children rewritten and top-level. */
  readonly rows: readonly SavedDevice[]
  readonly retirements: readonly PendingHubRetirement[]
}

/** The marker an integration carries so a re-run reuses it instead of minting a second one. */
export const MIGRATED_FROM_HUB_KEY = 'migratedFromHubDeviceId'

function positivePort(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

const CONNECTION_FIELDS = ['host', 'port', 'username', 'transport'] as const

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function migratedChildConfig(
  child: Readonly<Record<string, unknown>>,
  hub: Readonly<Record<string, unknown>>,
  integrationId: string,
): Record<string, unknown> {
  const filled: Record<string, unknown> = {}
  for (const key of CONNECTION_FIELDS) {
    const own = child[key]
    const inherited = hub[key]
    if ((own === undefined || own === null || own === '') && inherited !== undefined) {
      filled[key] = inherited
    }
  }
  return { ...child, ...filled, integrationId }
}

async function migrateOneHub(
  hub: SavedDevice,
  children: readonly SavedDevice[],
  integrations: readonly MigrationIntegration[],
  ports: HubMigrationPorts,
): Promise<{
  readonly rows: readonly SavedDevice[]
  readonly retirement: PendingHubRetirement
}> {
  const read = readHubConnection(hub.config)
  if (read.kind !== 'ok') {
    throw new Error(`hub connection unusable (${read.kind}) — left in place`)
  }
  const { connection } = read
  const uid = str(hub.config['uid'])
  const existing = integrations.find(
    (i) => i.addonId === ports.addonId && i.info[MIGRATED_FROM_HUB_KEY] === hub.id,
  )
  const integrationId =
    existing?.id ??
    (
      await ports.createIntegration({
        addonId: ports.addonId,
        name: hub.name,
        info: { [MIGRATED_FROM_HUB_KEY]: hub.id },
        originStableId: reolinkHubStableId({
          ...(uid !== undefined ? { uid } : {}),
          host: connection.host,
        }),
        settings: {
          host: connection.host,
          port: connection.port,
          rtspPort: positivePort(hub.config['rtspPort']) ?? connection.rtspPort,
          username: connection.username,
          password: connection.password,
          transport: connection.transport,
          ...(uid !== undefined ? { uid } : {}),
          debugGeneral: connection.debugGeneral,
          debugSocketLogs: connection.debugSocketLogs,
        },
        secretKeys: ['password'],
      })
    ).id

  const rewritten: SavedDevice[] = []
  for (const child of children) {
    const config = migratedChildConfig(child.config, hub.config, integrationId)
    await ports.persistConfig(child.stableId, config)
    await ports.setIntegrationId(child.id, integrationId)
    rewritten.push({ ...child, config, parentDeviceId: null })
  }
  return {
    rows: rewritten,
    retirement: { hubDeviceId: hub.id, hubName: hub.name, integrationId },
  }
}

/** Plan and persist the migration of every Hub row in `saved`. Never throws. */
export async function planHubMigration(
  saved: readonly SavedDevice[],
  ports: HubMigrationPorts,
): Promise<HubMigrationPlan> {
  const hubs = saved.filter((row) => row.type === DeviceType.Hub)
  if (hubs.length === 0) return { rows: saved, retirements: [] }

  let integrations: readonly MigrationIntegration[]
  try {
    integrations = await ports.listIntegrations()
  } catch (err) {
    ports.logger.warn('Reolink hub migration: integrations unreadable — hubs left in place', {
      meta: { error: errMsg(err) },
    })
    return {
      rows: saved.filter((row) => row.type !== DeviceType.Hub),
      retirements: [],
    }
  }

  const hubIds = new Set(hubs.map((h) => h.id))
  const rewrittenById = new Map<number, SavedDevice>()
  const retirements: PendingHubRetirement[] = []
  for (const hub of hubs) {
    const children = saved.filter((row) => row.parentDeviceId === hub.id)
    try {
      const done = await migrateOneHub(hub, children, integrations, ports)
      for (const row of done.rows) rewrittenById.set(row.id, row)
      retirements.push(done.retirement)
      ports.logger.info('Reolink hub migrated to an integration', {
        tags: { deviceId: hub.id },
        meta: {
          integrationId: done.retirement.integrationId,
          children: children.length,
          name: hub.name,
        },
      })
    } catch (err) {
      ports.logger.warn('Reolink hub migration failed — the hub device is left in place', {
        tags: { deviceId: hub.id },
        meta: { error: errMsg(err), name: hub.name },
      })
    }
  }
  const rows = saved
    .filter((row) => !hubIds.has(row.id))
    .map((row) => rewrittenById.get(row.id) ?? row)
  return { rows, retirements }
}

/**
 * Retire the hubs whose children all restored. A hub that still has a child in the store is left
 * and named: removing it would cascade the camera away with it.
 */
export async function retireMigratedHubs(
  retirements: readonly PendingHubRetirement[],
  ports: HubMigrationPorts,
): Promise<number> {
  let retired = 0
  for (const r of retirements) {
    try {
      const remaining = await ports.childIdsOf(r.hubDeviceId)
      if (remaining.length > 0) {
        ports.logger.warn(
          'Reolink hub kept — a child did not restore, retiring it would remove it',
          {
            tags: { deviceId: r.hubDeviceId },
            meta: { remaining: [...remaining], integrationId: r.integrationId },
          },
        )
        continue
      }
      await ports.removeDevice(r.hubDeviceId)
      retired++
      ports.logger.info('Reolink hub device retired', {
        tags: { deviceId: r.hubDeviceId },
        meta: { integrationId: r.integrationId },
      })
    } catch (err) {
      ports.logger.warn('Reolink hub retirement failed — retried next boot', {
        tags: { deviceId: r.hubDeviceId },
        meta: { error: errMsg(err) },
      })
    }
  }
  return retired
}
