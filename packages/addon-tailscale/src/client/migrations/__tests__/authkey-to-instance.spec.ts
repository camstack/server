/**
 * The pre-auth key and hostname move from the hub's node settings into one `tailnet` record.
 * The records door is the real in-memory one (the key really leaves the body and comes back
 * resolved); the legacy rows are a real SQLite `addon-settings` table in the canonical layout, and
 * the drop plan is applied the way the engine does: precondition re-read, then the delete.
 */
import {
  defineAddonMigrations,
  makeInMemoryRecords,
  type MigrationOwnerResult,
  preconditionOf,
} from '@camstack/types'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ADDON_SETTINGS_TABLE } from '../../../settings-per-node.js'
import { effectiveCredentials } from '../../tailnet-credentials.js'
import { TAILNET_RECORD_ID, tailnetKind } from '../../tailnet-record-kinds.js'
import { AUTHKEY_TO_INSTANCE_ID, ADDON_MIGRATIONS, DROP_MOVED_KEYS_ID } from '../index.js'
import type { ClientCataloguePorts } from '../index.js'

const ADDON = 'tailscale-client'
const KEY = 'tskey-auth-kAbCdE123456'
/** A setting the migration does not know: it must survive both migrations untouched. */
const NEIGHBOUR = { acceptRoutes: true }

const hubRow = (key: string, value: unknown) => ({
  addonId: ADDON,
  key: `${key}@hub`,
  value,
  nodeId: 'hub',
})
const bareRow = (key: string, value: unknown) => ({ addonId: ADDON, key, value })

async function world(options: { readFails?: boolean; bare?: boolean } = {}) {
  const db = new Database(':memory:')
  db.exec(
    `CREATE TABLE "${ADDON_SETTINGS_TABLE}" (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL)`,
  )
  const put = (id: string, data: unknown): void => {
    db.prepare(`INSERT OR REPLACE INTO "${ADDON_SETTINGS_TABLE}" (id, data) VALUES (?, ?)`).run(
      id,
      JSON.stringify(data),
    )
  }
  const rows = (): Record<string, Record<string, unknown>> =>
    Object.fromEntries(
      db
        .prepare(`SELECT id, data FROM "${ADDON_SETTINGS_TABLE}"`)
        .all()
        .flatMap((row) =>
          typeof row === 'object' && row !== null && 'id' in row && 'data' in row
            ? [[String(row.id), JSON.parse(String(row.data))]]
            : [],
        ),
    )
  put(`${ADDON}.authKey@hub`, hubRow('authKey', KEY))
  put(`${ADDON}.hostname@hub`, hubRow('hostname', 'camstack-hub'))
  put(`${ADDON}.acceptRoutes@hub`, hubRow('acceptRoutes', true))
  if (options.bare !== false) {
    put(`${ADDON}.authKey`, bareRow('authKey', KEY))
    put(`${ADDON}.hostname`, bareRow('hostname', 'camstack-hub'))
  }
  const records = makeInMemoryRecords(ADDON)
  await records.records.declare({ tailnet: tailnetKind })
  const handle = records.records.kind(tailnetKind)
  const writes: string[] = []
  const warnings: string[] = []
  const valueOf = (key: string): unknown => rows()[`${ADDON}.${key}@hub`]?.['value']
  const ports: ClientCataloguePorts = {
    readStored: async (keys) =>
      Object.fromEntries(
        keys.flatMap((key) => {
          const row = rows()[`${ADDON}.${key}`]
          return row === undefined ? [] : [[key, row['value']]]
        }),
      ),
    readHub: async () => {
      if (options.readFails) throw new Error('keychain locked')
      return Object.fromEntries(
        ['authKey', 'hostname', 'acceptRoutes'].flatMap((key) =>
          valueOf(key) === undefined ? [] : [[key, valueOf(key)]],
        ),
      )
    },
    putRecord: async (body) => {
      if ((await handle.get(TAILNET_RECORD_ID)) !== null) return 'exists'
      writes.push('record')
      await handle.put({ id: TAILNET_RECORD_ID, data: body }, { ifRev: 0 })
      return 'created'
    },
    warn: (message) => {
      warnings.push(message)
    },
    readRecord: async () => {
      const row = await handle.getResolved(TAILNET_RECORD_ID)
      return row === null
        ? null
        : { hostname: row.data.hostname, hasAuthKey: (row.data.authKey ?? '').length > 0 }
    },
    clearOldAuthKey: async () => {
      writes.push('clear-key')
      db.prepare(`DELETE FROM "${ADDON_SETTINGS_TABLE}" WHERE id = ?`).run(`${ADDON}.authKey@hub`)
    },
  }
  const bound = defineAddonMigrations(ADDON_MIGRATIONS, ports)
  const run = async (id: string): Promise<MigrationOwnerResult> => {
    const entry = bound.find((b) => b.meta.id === id)
    if (entry === undefined) throw new Error(`no ${id}`)
    return entry.execute()
  }
  /** Apply a returned plan the way the engine does: the precondition is re-read first. */
  const applyDrop = async (): Promise<void> => {
    const result = await run(DROP_MOVED_KEYS_ID)
    if (result.kind === 'failed') throw new Error(result.error)
    if (result.kind !== 'plan') throw new Error('not a plan')
    for (const edit of result.plan.edits) {
      if (edit.op !== 'deleteKeys') throw new Error(`unexpected edit ${edit.op}`)
      const now = rows()
      const seen = Object.fromEntries(edit.keys.map((k) => [k, now[k] ?? null]))
      if (edit.precondition !== preconditionOf(seen)) throw new Error('precondition mismatch')
      for (const key of edit.keys) {
        db.prepare(`DELETE FROM "${ADDON_SETTINGS_TABLE}" WHERE id = ?`).run(key)
      }
    }
  }
  return { rows, handle, writes, warnings, run, applyDrop, put }
}

describe('tailscale-client/2026-11-06-authkey-to-instance', () => {
  it('moves the key and the hostname into the record; the key resolves and the neighbour survives', async () => {
    const w = await world()
    const result = await w.run(AUTHKEY_TO_INSTANCE_ID)
    expect(result).toMatchObject({ kind: 'procedure', result: { outcome: 'done' } })
    const row = await w.handle.getResolved(TAILNET_RECORD_ID)
    expect(row?.data).toMatchObject({ authKey: KEY, hostname: 'camstack-hub' })
    expect(w.rows()[`${ADDON}.authKey@hub`]).toBeUndefined()
    expect(w.rows()[`${ADDON}.acceptRoutes@hub`]?.['value']).toBe(NEIGHBOUR.acceptRoutes)
    expect(JSON.stringify(result)).not.toContain(KEY)
  })

  it('a joined hub keeps auto-rejoin after the restart: the join path reads the instance', async () => {
    const w = await world()
    await w.run(AUTHKEY_TO_INSTANCE_ID)
    await w.applyDrop()
    // After the restart nothing is left in the settings; the credentials come from the record.
    const record = await w.handle.getResolved(TAILNET_RECORD_ID)
    const credentials = effectiveCredentials(
      record === null
        ? null
        : { id: TAILNET_RECORD_ID, body: record.data, enabled: true, secrets: 'resolved' },
      { authKey: '', hostname: '' },
    )
    expect(credentials).toEqual({ authKey: KEY, hostname: 'camstack-hub' })
  })

  it('a rerun is a no-op', async () => {
    const w = await world()
    await w.run(AUTHKEY_TO_INSTANCE_ID)
    await w.applyDrop()
    const before = w.rows()
    const second = await w.run(AUTHKEY_TO_INSTANCE_ID)
    expect(second).toMatchObject({ kind: 'procedure', result: { outcome: 'already-done' } })
    await w.applyDrop()
    expect(w.rows()).toEqual(before)
    expect(w.writes.filter((x) => x === 'record')).toHaveLength(1)
  })

  it('no key and no hostname: no record, no error', async () => {
    const w = await world()
    for (const id of ['authKey', 'hostname']) {
      w.put(`${ADDON}.${id}@hub`, hubRow(id, ''))
    }
    const result = await w.run(AUTHKEY_TO_INSTANCE_ID)
    expect(result).toMatchObject({ kind: 'procedure', result: { outcome: 'already-done' } })
    expect(await w.handle.get(TAILNET_RECORD_ID)).toBeNull()
    expect(w.writes).toEqual([])
  })

  it('never overwrites an existing record; the old key is kept while the record holds none', async () => {
    const w = await world()
    await w.handle.put(
      { id: TAILNET_RECORD_ID, data: { name: 'Mine', hostname: 'chosen' } },
      { ifRev: 0 },
    )
    const result = await w.run(AUTHKEY_TO_INSTANCE_ID)
    expect(result).toMatchObject({ kind: 'procedure', result: { outcome: 'already-done' } })
    const row = await w.handle.getResolved(TAILNET_RECORD_ID)
    expect(row?.data).toMatchObject({ name: 'Mine', hostname: 'chosen' })
    expect(row?.data.authKey).toBeUndefined()
    expect(w.rows()[`${ADDON}.authKey@hub`]?.['value']).toBe(KEY)
    expect(w.warnings).toHaveLength(1)
    expect(w.warnings.join()).not.toContain(KEY)
  })

  it('a failed read of the old settings writes nothing', async () => {
    const w = await world({ readFails: true })
    expect(await w.run(AUTHKEY_TO_INSTANCE_ID)).toMatchObject({
      kind: 'failed',
      error: 'keychain locked',
    })
    expect(await w.handle.get(TAILNET_RECORD_ID)).toBeNull()
    expect(w.writes).toEqual([])
  })
})

describe('tailscale-client/2026-11-06-drop-moved-keys', () => {
  it('deletes both spellings of both keys once the record holds them, and nothing else', async () => {
    const w = await world()
    await w.run(AUTHKEY_TO_INSTANCE_ID)
    await w.applyDrop()
    const ids = Object.keys(w.rows())
    expect(ids.filter((id) => /\.(authKey|hostname)(@hub)?$/.test(id))).toEqual([])
    expect(w.rows()[`${ADDON}.acceptRoutes@hub`]?.['value']).toBe(true)
  })

  it('refuses while the record does not hold what the keys carry: the keys stay', async () => {
    const w = await world()
    await expect(w.applyDrop()).rejects.toThrow('no tailnet record exists')
    expect(w.rows()[`${ADDON}.authKey`]?.['value']).toBe(KEY)
    expect(w.rows()[`${ADDON}.hostname@hub`]?.['value']).toBe('camstack-hub')
  })

  it('refuses when a row changed between the read and the apply', async () => {
    const w = await world()
    await w.run(AUTHKEY_TO_INSTANCE_ID)
    const result = await w.run(DROP_MOVED_KEYS_ID)
    if (result.kind !== 'plan') throw new Error('not a plan')
    w.put(`${ADDON}.hostname`, bareRow('hostname', 'edited-meanwhile'))
    const edit = result.plan.edits[0]
    if (edit?.op !== 'deleteKeys') throw new Error('expected deleteKeys')
    const seen = Object.fromEntries(edit.keys.map((k) => [k, w.rows()[k] ?? null]))
    expect(edit.precondition).not.toBe(preconditionOf(seen))
  })
})
