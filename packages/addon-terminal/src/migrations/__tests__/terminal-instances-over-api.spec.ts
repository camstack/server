/**
 * The Terminal list moves from the addon settings (`terminalInstances`) into `terminals` records,
 * bound through the migration API only: the legacy list is read from a hand-seeded SQLite
 * `addon-settings` table over `api.settings`, the records live in the in-memory records engine. A
 * field the old row carried that a re-built row would lose (`profileSettings.mark`) is the
 * discriminator: it must be on the record, under the SAME id, so `terminal-camera-instance-<id>`
 * stays the camera's stable id.
 */
import { makeInMemoryRecords } from '@camstack/types'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { newTerminalCameraStableId, terminalInstancesKind } from '../../terminal-record-kinds.js'
import {
  ADDON_MIGRATIONS,
  LEGACY_TERMINAL_INSTANCES_KEY,
  type TerminalMigrationPorts,
  type TerminalPortsApi,
  terminalPortsOver,
} from '../index.js'
import { copyTerminalsToRecords } from '../terminal-instances-to-records.js'
import {
  TERMINAL_SEED_ADDON,
  TERMINAL_SEED_ROWS,
  seedTerminalLegacySettings,
} from '../__fixtures__/seed.js'

const LEGACY_ID = `${TERMINAL_SEED_ADDON}.${LEGACY_TERMINAL_INSTANCES_KEY}`

async function boot() {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE IF NOT EXISTS "addon-settings" (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
  const records = makeInMemoryRecords(TERMINAL_SEED_ADDON)
  await records.records.declare({ terminals: terminalInstancesKind })
  const handle = records.records.kind(terminalInstancesKind)
  const warnings: string[] = []
  const store = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    const rows = db
      .prepare<[string], { data: string }>('SELECT data FROM "addon-settings" WHERE id LIKE ?')
      .all(`${TERMINAL_SEED_ADDON}.%`)
    for (const row of rows) {
      const parsed: { key: string; value: unknown } = JSON.parse(row.data)
      out[parsed.key] = parsed.value
    }
    return out
  }
  const api: TerminalPortsApi = {
    settings: {
      read: async () => ({ store: store() }),
      write: async ({ patch }) => {
        for (const [key, value] of Object.entries(patch)) {
          db.prepare('INSERT OR REPLACE INTO "addon-settings" (id, data) VALUES (?, ?)').run(
            `${TERMINAL_SEED_ADDON}.${key}`,
            JSON.stringify({ addonId: TERMINAL_SEED_ADDON, key, value }),
          )
        }
        return {}
      },
      deleteKeys: async ({ keys }) => {
        for (const key of keys) {
          db.prepare('DELETE FROM "addon-settings" WHERE id = ?').run(
            `${TERMINAL_SEED_ADDON}.${key}`,
          )
        }
        return { removed: keys }
      },
    },
    log: {
      info: async () => ({}),
      warn: async ({ message }) => {
        warnings.push(message)
        return {}
      },
    },
    records: {
      kind: (definition) => {
        const h = records.records.kind(definition)
        return {
          get: ({ id }) => h.get(id),
          getResolved: ({ id }) => h.getResolved(id),
          put: ({ ifRev, ...row }) => h.put(row, ifRev === undefined ? undefined : { ifRev }),
          putMany: ({ records: rows }) => h.putMany(rows),
          patch: ({ id, partial, ifRev }) =>
            h.patch(id, partial, ifRev === undefined ? undefined : { ifRev }),
          delete: async ({ id }) => ({ deleted: await h.delete(id) }),
          query: ({ limit, resolveSecrets, ...rest }) =>
            h.query(
              { ...rest, limit: limit ?? 100 },
              resolveSecrets === undefined ? undefined : { resolveSecrets },
            ),
          deleteWhere: async () => ({ count: 0 }),
        }
      },
    },
  }
  const portsOver = (): TerminalMigrationPorts => terminalPortsOver(api)
  const run = (ports: TerminalMigrationPorts = portsOver()) => copyTerminalsToRecords(ports)
  const settingsRow = () =>
    db.prepare<[string], { id: string }>('SELECT id FROM "addon-settings" WHERE id = ?').get(LEGACY_ID)
  return { db, handle, run, portsOver, settingsRow, warnings }
}

describe('Terminal instances settings to records, over the migration API', () => {
  it('copies every row under its own id, keeps the marked field, then drops the old key', async () => {
    const w = await boot()
    seedTerminalLegacySettings(w.db)
    expect(await w.run()).toMatchObject({ outcome: 'done' })

    const page = await w.handle.query({ limit: 10 })
    expect(page.records.map((r) => r.id).sort()).toEqual(TERMINAL_SEED_ROWS.map((r) => r.id).sort())
    for (const seed of TERMINAL_SEED_ROWS) {
      const row = await w.handle.get(seed.id)
      expect(row?.data).toMatchObject({
        name: seed.name,
        nodeId: seed.nodeId,
        profileId: seed.profileId,
        profileLabel: seed.profileLabel,
        args: seed.args,
        cwd: seed.cwd,
        environment: seed.environment,
        profileSettings: seed.profileSettings,
      })
      expect(row?.data.enabled !== false).toBe(seed.enabled)
    }
    expect(w.settingsRow()).toBeUndefined()
  })

  it('the camera each record yields is the camera the old row named (device ids stay)', async () => {
    const w = await boot()
    seedTerminalLegacySettings(w.db)
    await w.run()
    for (const seed of TERMINAL_SEED_ROWS) {
      const row = await w.handle.get(seed.id)
      expect(row?.data.cameraStableId ?? newTerminalCameraStableId(seed.id)).toBe(
        seed.cameraStableId,
      )
    }
  })

  it('a second run is already-done and writes nothing', async () => {
    const w = await boot()
    seedTerminalLegacySettings(w.db)
    await w.run()
    const first = JSON.stringify((await w.handle.query({ limit: 10 })).records)
    const migration = ADDON_MIGRATIONS[0]
    if (migration === undefined || !('procedure' in migration)) {
      throw new Error('the catalogue holds no procedure')
    }
    const result = await migration.procedure(w.portsOver())
    expect(result).toMatchObject({ outcome: 'already-done' })
    expect(JSON.stringify((await w.handle.query({ limit: 10 })).records)).toBe(first)
  })

  it('never overwrites a record that already exists, and still drops the key once it is there', async () => {
    const w = await boot()
    seedTerminalLegacySettings(w.db)
    const seed = TERMINAL_SEED_ROWS[0]
    if (seed === undefined) throw new Error('seed is empty')
    await w.handle.put(
      {
        id: seed.id,
        data: {
          name: 'Renamed since',
          nodeId: 'hub',
          profileId: 'glances',
          profileLabel: 'Glances',
          executable: '',
          args: [],
          cwd: '',
          environment: [],
          profileSettings: {},
        },
      },
      { ifRev: 0 },
    )
    await w.run()
    expect((await w.handle.get(seed.id))?.data.name).toBe('Renamed since')
    expect(await w.handle.get(TERMINAL_SEED_ROWS[1]?.id ?? '')).not.toBeNull()
    expect(w.settingsRow()).toBeUndefined()
  })

  const replaceLegacy = (w: Awaited<ReturnType<typeof boot>>, value: unknown) =>
    w.db
      .prepare('UPDATE "addon-settings" SET data = ? WHERE id = ?')
      .run(
        JSON.stringify({ addonId: TERMINAL_SEED_ADDON, key: 'terminalInstances', value }),
        `${TERMINAL_SEED_ADDON}.terminalInstances`,
      )
  const legacyValue = (w: Awaited<ReturnType<typeof boot>>): unknown => {
    const row = w.db
      .prepare<[string], { data: string }>('SELECT data FROM "addon-settings" WHERE id = ?')
      .get(`${TERMINAL_SEED_ADDON}.terminalInstances`)
    if (row === undefined) return undefined
    return JSON.parse(row.data).value
  }

  it('bad rows never block the good ones: they are converted, the key keeps only the bad rows, and it lands done', async () => {
    const w = await boot()
    seedTerminalLegacySettings(w.db)
    const nameless = { id: 'not-a-uuid', name: '' }
    const malformed = {
      ...TERMINAL_SEED_ROWS[0],
      id: '9a8b7c6d-0000-4000-8000-00000000cccc',
      args: 'x',
    }
    replaceLegacy(w, [...TERMINAL_SEED_ROWS, nameless, malformed])
    expect(await w.run()).toMatchObject({ outcome: 'done' })
    expect((await w.handle.query({ limit: 10 })).records).toHaveLength(TERMINAL_SEED_ROWS.length)
    expect(legacyValue(w)).toEqual([nameless, malformed])
  })

  it('a rerun with only bad rows left is already-done, rewrites nothing', async () => {
    const w = await boot()
    seedTerminalLegacySettings(w.db)
    const nameless = { id: 'not-a-uuid', name: '' }
    replaceLegacy(w, [nameless])
    const migration = ADDON_MIGRATIONS[0]
    if (migration === undefined || !('procedure' in migration)) {
      throw new Error('the catalogue holds no procedure')
    }
    const result = await migration.procedure(w.portsOver())
    expect(result).toMatchObject({ outcome: 'already-done' })
    expect(legacyValue(w)).toEqual([nameless])
  })

  it('a duplicate id is skipped after the first, which stays', async () => {
    const w = await boot()
    seedTerminalLegacySettings(w.db)
    const first = TERMINAL_SEED_ROWS[0]
    const dup = { ...first, name: 'Second with the same id' }
    replaceLegacy(w, [first, dup])
    expect(await w.run()).toMatchObject({ outcome: 'done' })
    const records = (await w.handle.query({ limit: 10 })).records
    expect(records).toHaveLength(1)
    expect(records[0]?.data.name).toBe(first?.name)
    expect(legacyValue(w)).toEqual([dup])
  })

  it('a disabled row survives disabled and an adopted legacy camera id survives', async () => {
    const w = await boot()
    seedTerminalLegacySettings(w.db)
    await w.run()
    const adopted = TERMINAL_SEED_ROWS[1]
    const record = await w.handle.get(adopted?.id ?? '')
    expect(record?.data.enabled).toBe(false)
    expect(record?.data.cameraStableId).toBe(adopted?.cameraStableId)
  })

  it('keeps the old key when a written record does not read back equal', async () => {
    const w = await boot()
    seedTerminalLegacySettings(w.db)
    const real = w.portsOver()
    const lying: TerminalMigrationPorts = {
      ...real,
      readRecord: async (id) => {
        const body = await real.readRecord(id)
        return body === null ? null : { ...body, name: `${body.name} (drifted)` }
      },
    }
    await expect(w.run(lying)).rejects.toThrow(/did not read back as written/)
    expect(w.settingsRow()).toBeDefined()
  })

  it('an install with no legacy key is already-done', async () => {
    const w = await boot()
    expect(await w.run()).toMatchObject({ outcome: 'already-done' })
    expect((await w.handle.query({ limit: 10 })).records).toEqual([])
  })
})
