/**
 * A real SQLite file for the device-manager migrations (D1089): the records engine and its
 * provider over one connection, a `device-manager:devices` table with the real column names
 * (plus a `mark` column the migrations do not know), the canonical `addon-settings` table and
 * the migration target production builds (`migrateTargetOf`). Every assertion reads the file.
 */
import {
  createRecordsAccess,
  type MigrationMeta,
  type MigrationPlan,
  type RecordsAccess,
} from '@camstack/types'
import type Database from 'better-sqlite3'
import { makeRecordsWorld } from '../../../sqlite-storage/__tests__/support/records-world.js'
import {
  migrateTargetOf,
  type MigrateTarget,
} from '../../../sqlite-storage/migrations/migration-pass.js'
import { DEVICE_ROWS_COLLECTION } from '../../device-row-store.js'
import { deviceManagerRecordKinds } from '../../record-kinds.js'
import { ADDON_MIGRATIONS, type DeviceManagerMigrationPorts } from '../index.js'
import { deviceManagerMigrationPorts } from '../ports.js'

export const OWNER = 'device-manager'
const JSON_COLUMNS: readonly string[] = ['tags', 'tagIds']

export interface SeedDevice {
  readonly deviceId: number
  readonly location?: string | null
  readonly locationId?: string | null
  readonly tags?: readonly string[]
  readonly tagIds?: readonly string[]
  readonly name?: string
}

export interface MigrationWorld {
  readonly db: Database.Database
  readonly records: RecordsAccess
  readonly target: MigrateTarget
  readonly ports: DeviceManagerMigrationPorts
  /** Every info line the migration ports reported, in order. */
  readonly reports: { readonly message: string; readonly meta: Readonly<Record<string, unknown>> }[]
  /** The addon store rows as stored, by key. */
  readonly store: () => Record<string, unknown>
  /** Write one addon store key (and the same key of a neighbour addon, which must survive). */
  setStore(key: string, value: unknown): void
  /** The device row as stored (JSON columns parsed). */
  device(deviceId: number): Record<string, unknown>
  /** Plan migration `id`, then apply the plan with the production transaction. */
  run(
    id: string,
    tamper?: (plan: MigrationPlan) => MigrationPlan,
  ): Promise<{
    readonly status: string
    readonly error: string | null
  }>
  planOf(id: string): Promise<MigrationPlan>
}

export async function makeMigrationWorld(devices: readonly SeedDevice[]): Promise<MigrationWorld> {
  const world = makeRecordsWorld()
  await world.provider.init()
  const records = createRecordsAccess({
    owner: OWNER,
    transport: world.transportFor(OWNER),
    secrets: null,
  })
  await records.declare(deviceManagerRecordKinds)
  const db = world.settings.db
  db.exec(`
    CREATE TABLE "${DEVICE_ROWS_COLLECTION}" (
      id TEXT PRIMARY KEY NOT NULL, deviceId INTEGER NOT NULL, addonId TEXT NOT NULL,
      stableId TEXT NOT NULL, name TEXT NOT NULL, location TEXT, locationId TEXT,
      tags TEXT, tagIds TEXT, mark TEXT);
    CREATE TABLE "addon-settings" (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL);
  `)
  const insert = db.prepare(
    `INSERT INTO "${DEVICE_ROWS_COLLECTION}"
       (id, deviceId, addonId, stableId, name, location, locationId, tags, tagIds, mark)
     VALUES (?, ?, 'prov', ?, ?, ?, ?, ?, ?, 'marked-survives')`,
  )
  for (const d of devices) {
    insert.run(
      String(d.deviceId),
      d.deviceId,
      `s-${d.deviceId}`,
      d.name ?? `device ${d.deviceId}`,
      d.location ?? null,
      d.locationId ?? null,
      d.tags === undefined ? null : JSON.stringify(d.tags),
      d.tagIds === undefined ? null : JSON.stringify(d.tagIds),
    )
  }
  const upsert = db.prepare('INSERT OR REPLACE INTO "addon-settings" (id, data) VALUES (?, ?)')
  const storeRows = (): Record<string, unknown> =>
    Object.fromEntries(
      db
        .prepare<[], { id: string; data: string }>('SELECT id, data FROM "addon-settings"')
        .all()
        .filter((row) => row.id.startsWith(`${OWNER}.`))
        .map((row) => [row.id.slice(OWNER.length + 1), JSON.parse(row.data).value]),
    )
  const reports: { message: string; meta: Readonly<Record<string, unknown>> }[] = []
  const ports = deviceManagerMigrationPorts({
    report: (message, meta) => {
      reports.push({ message, meta })
    },
    readStoredKey: async (key) => {
      const all = storeRows()
      return key in all ? { kind: 'present', value: all[key] } : { kind: 'absent' }
    },
    rows: {
      readRawColumns: async (columns) =>
        db
          .prepare<[], Record<string, unknown>>(
            `SELECT ${columns.map((c) => `"${c}"`).join(', ')} FROM "${DEVICE_ROWS_COLLECTION}"`,
          )
          .all()
          .map((row) =>
            Object.fromEntries(
              Object.entries(row).map(([k, v]) => [
                k,
                JSON_COLUMNS.includes(k) && typeof v === 'string' ? JSON.parse(v) : v,
              ]),
            ),
          ),
    },
    rooms: records.kind(deviceManagerRecordKinds.rooms),
    zones: records.kind(deviceManagerRecordKinds.zones),
  })
  const target = migrateTargetOf(db, 'settings', [], world.settings.engine.migrationWriter())
  const migration = (id: string) => {
    const found = ADDON_MIGRATIONS.find((m) => m.meta.id === id)
    if (found === undefined || !('plan' in found)) throw new Error(`no plan migration ${id}`)
    return { meta: found.meta satisfies MigrationMeta, plan: found.plan }
  }
  const planOf = (id: string): Promise<MigrationPlan> => migration(id).plan(ports)
  let boot = 0
  return {
    db,
    records,
    target,
    ports,
    reports,
    store: storeRows,
    setStore: (key, value) => {
      upsert.run(`${OWNER}.${key}`, JSON.stringify({ addonId: OWNER, key, value }))
      upsert.run(
        `other-addon.${key}`,
        JSON.stringify({ addonId: 'other-addon', key, value: 'keep' }),
      )
    },
    device: (deviceId) => {
      const row = db
        .prepare<[number], Record<string, unknown>>(
          `SELECT * FROM "${DEVICE_ROWS_COLLECTION}" WHERE deviceId = ?`,
        )
        .get(deviceId)
      if (row === undefined) throw new Error(`no device ${deviceId}`)
      return Object.fromEntries(
        Object.entries(row).map(([k, v]) => [
          k,
          JSON_COLUMNS.includes(k) && typeof v === 'string' ? JSON.parse(v) : v,
        ]),
      )
    },
    planOf,
    run: async (id, tamper) => {
      const { meta, plan } = migration(id)
      const read = await plan(ports)
      boot += 1
      const out = target.applyPlan({
        meta,
        plan: tamper === undefined ? read : tamper(read),
        bootId: `boot-${boot}`,
        codeVersion: '1.0.0',
      })
      return { status: out.status, error: out.error }
    },
  }
}
