/**
 * The hub migration against real SQLite: the purifier row is updated in the database,
 * and a field the migration does not know, plus the device id, are still there afterwards.
 * The password is in the keychain table, not in the account-record body.
 */
import Database from 'better-sqlite3'
import {
  DeviceType,
  defineAddonMigrations,
  type IScopedLogger,
  type MigrationIntegration,
  runAddonMigrations,
  type AddonMigrationHost,
  type MigrationMeta,
  type MigrationOwnerResult,
  type SavedDevice,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { ADDON_MIGRATIONS } from '../migrations/index.js'
import type { VeSyncMigrationPorts } from '../migrations/ports.js'
import { gatewayStableId } from '../vesync-discovery.js'

const quiet: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
  withTags: () => quiet,
}

const HUB_STABLE = 'vesync:me-example-com'
const PASSWORD = 'sqlite-secret'
const PURIFIER_ID = 21

function deviceType(value: string): DeviceType {
  const known = [
    DeviceType.Hub,
    DeviceType.Fan,
    DeviceType.Gateway,
    DeviceType.Switch,
    DeviceType.Sensor,
  ]
  const found = known.find((item) => item === value)
  if (found === undefined) throw new Error(`unknown device type ${value}`)
  return found
}

function openDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE devices (
      device_id INTEGER PRIMARY KEY,
      stable_id TEXT NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      parent_id INTEGER,
      config TEXT NOT NULL
    );
    CREATE TABLE account_records (
      integration_id TEXT PRIMARY KEY,
      body TEXT NOT NULL
    );
    CREATE TABLE keychain (
      ref TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
  return db
}

function insert(db: Database.Database, row: SavedDevice): void {
  db.prepare(
    'INSERT INTO devices (device_id, stable_id, type, name, parent_id, config) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(row.id, row.stableId, row.type, row.name, row.parentDeviceId, JSON.stringify(row.config))
}

function readRow(db: Database.Database, deviceId: number): SavedDevice | undefined {
  const found = db
    .prepare(
      'SELECT device_id, stable_id, type, name, parent_id, config FROM devices WHERE device_id = ?',
    )
    .get(deviceId)
  if (typeof found !== 'object' || found === null) return undefined
  const deviceIdValue = Reflect.get(found, 'device_id')
  const stableId = Reflect.get(found, 'stable_id')
  const type = Reflect.get(found, 'type')
  const name = Reflect.get(found, 'name')
  const parent = Reflect.get(found, 'parent_id')
  const config = Reflect.get(found, 'config')
  if (
    typeof deviceIdValue !== 'number' ||
    typeof stableId !== 'string' ||
    typeof type !== 'string' ||
    typeof name !== 'string' ||
    typeof config !== 'string'
  ) {
    return undefined
  }
  const parsed: unknown = JSON.parse(config)
  return {
    id: deviceIdValue,
    stableId,
    type: deviceType(type),
    name,
    location: null,
    disabled: false,
    parentDeviceId: typeof parent === 'number' ? parent : null,
    config:
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? Object.fromEntries(Object.entries(parsed))
        : {},
  }
}

function listRows(db: Database.Database): SavedDevice[] {
  const ids = db.prepare('SELECT device_id FROM devices ORDER BY device_id').all()
  return ids.flatMap((entry) => {
    const id = typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'device_id') : null
    if (typeof id !== 'number') return []
    const row = readRow(db, id)
    return row === undefined ? [] : [row]
  })
}

describe('VeSync hub migration on real SQLite', () => {
  it('keeps the purifier deviceId and a marked field, and reads the password back', async () => {
    const db = openDb()
    insert(db, {
      id: 10,
      stableId: HUB_STABLE,
      type: DeviceType.Hub,
      name: 'Home',
      location: null,
      disabled: false,
      parentDeviceId: null,
      config: {
        connection: {
          email: 'me@example.com',
          password: PASSWORD,
          region: 'EU',
          pollIntervalMs: 30_000,
        },
      },
    })
    insert(db, {
      id: PURIFIER_ID,
      stableId: `${HUB_STABLE}:purifier:cid-1`,
      type: DeviceType.Fan,
      name: 'Living room',
      location: null,
      disabled: false,
      parentDeviceId: 10,
      config: {
        purifierNativeId: 'cid-1',
        accountId: HUB_STABLE,
        system: 'vesync',
        operatorNote: 'by the window',
      },
    })

    const integrations: MigrationIntegration[] = []
    let nextId = 100
    const ports: VeSyncMigrationPorts = {
      addonId: 'provider-vesync',
      logger: quiet,
      listSavedDevices: async () => listRows(db),
      listIntegrations: async () => integrations,
      createIntegration: async (input) => {
        const id = `int-${integrations.length + 1}`
        integrations.push({
          id,
          addonId: input.addonId,
          name: input.name,
          info: input.info,
          originStableId: input.originStableId,
        })
        return { id }
      },
      setIntegrationId: async () => undefined,
      persistConfig: async (stableId, config) => {
        const changed = db
          .prepare('UPDATE devices SET config = ? WHERE stable_id = ?')
          .run(JSON.stringify(config), stableId)
        if (changed.changes !== 1) throw new Error(`no row ${stableId}`)
      },
      childIdsOf: async (parent) =>
        listRows(db)
          .filter((r) => r.parentDeviceId === parent)
          .map((r) => r.id),
      createGateway: async ({ integrationId, name }) => {
        const stableId = gatewayStableId(integrationId)
        const existing = listRows(db).find((r) => r.stableId === stableId)
        if (existing !== undefined) return { deviceId: existing.id }
        const id = nextId++
        insert(db, {
          id,
          stableId,
          type: DeviceType.Gateway,
          name,
          location: null,
          disabled: false,
          parentDeviceId: null,
          config: { kind: 'account', integrationId, system: 'vesync' },
        })
        return { deviceId: id }
      },
      removeDevice: async (id) => {
        const children = listRows(db).filter((r) => r.parentDeviceId === id)
        if (children.length > 0) {
          throw new Error(`refusing to cascade-remove ${id}`)
        }
        db.prepare('DELETE FROM devices WHERE device_id = ?').run(id)
      },
      restoreRows: async (rows) => {
        const update = db.prepare('UPDATE devices SET parent_id = NULL WHERE device_id = ?')
        for (const restored of rows) update.run(restored.id)
      },
      putAccountRecord: async (integrationId, body) => {
        const existing = db
          .prepare('SELECT integration_id FROM account_records WHERE integration_id = ?')
          .get(integrationId)
        if (existing !== undefined) return 'exists'
        const password = body['password']
        const stored: Record<string, unknown> = { ...body }
        delete stored['password']
        db.prepare('INSERT INTO account_records (integration_id, body) VALUES (?, ?)').run(
          integrationId,
          JSON.stringify(stored),
        )
        if (typeof password === 'string' && password.length > 0) {
          db.prepare('INSERT INTO keychain (ref, value) VALUES (?, ?)').run(
            `${integrationId}:password`,
            password,
          )
        }
        return 'created'
      },
      readAccountRecord: async (integrationId) => {
        const found = db
          .prepare('SELECT body FROM account_records WHERE integration_id = ?')
          .get(integrationId)
        if (typeof found !== 'object' || found === null) return null
        const raw = Reflect.get(found, 'body')
        if (typeof raw !== 'string') return null
        const parsed: unknown = JSON.parse(raw)
        const body =
          typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? Object.fromEntries(Object.entries(parsed))
            : {}
        const secret = db
          .prepare('SELECT value FROM keychain WHERE ref = ?')
          .get(`${integrationId}:password`)
        const value =
          typeof secret === 'object' && secret !== null ? Reflect.get(secret, 'value') : undefined
        return typeof value === 'string' ? { ...body, password: value } : body
      },
    }

    const ledger: MigrationOwnerResult[] = []
    const host = {
      declareOwner: async ({ metas }: { metas: MigrationMeta[] }) => ({
        bootId: 'b1',
        snapshot: 'none',
        steps: metas.map((m) => ({ id: m.id, action: 'run', state: 'pending' })),
      }),
      startMigration: async () => ({ proceed: true, state: 'pending', reason: null }),
      finishMigration: async ({ result }: { result: MigrationOwnerResult }) => {
        ledger.push(result)
        return { status: 'applied', error: null, rowsChanged: 0 }
      },
    } satisfies AddonMigrationHost
    const report = await runAddonMigrations(
      host,
      defineAddonMigrations(ADDON_MIGRATIONS, ports),
      quiet,
    )
    expect(report.applied).toEqual(['provider-vesync/2026-11-04-hub-to-integration-gateway'])

    const purifier = readRow(db, PURIFIER_ID)
    expect(purifier?.id).toBe(PURIFIER_ID)
    expect(purifier?.stableId).toBe(`${HUB_STABLE}:purifier:cid-1`)
    expect(purifier?.parentDeviceId).toBeNull()
    expect(purifier?.config['operatorNote']).toBe('by the window')
    expect(purifier?.config['integrationId']).toBe('int-1')
    expect(purifier?.config['purifierNativeId']).toBe('cid-1')
    expect(readRow(db, 10)).toBeUndefined()

    const stored = db
      .prepare('SELECT body FROM account_records WHERE integration_id = ?')
      .get('int-1')
    const body = typeof stored === 'object' && stored !== null ? Reflect.get(stored, 'body') : ''
    expect(typeof body === 'string' ? body : '').not.toContain(PASSWORD)
    const secret = db.prepare('SELECT value FROM keychain WHERE ref = ?').get('int-1:password')
    expect(
      typeof secret === 'object' && secret !== null ? Reflect.get(secret, 'value') : null,
    ).toBe(PASSWORD)

    const gateway = listRows(db).find((r) => r.type === DeviceType.Gateway)
    expect(gateway?.parentDeviceId).toBeNull()
    expect(ledger[0]).toMatchObject({ kind: 'procedure', result: { outcome: 'done' } })
    db.close()
  })
})
