/**
 * The sources migration bound through `MigrationApiV1` only (`runMigrations(catalogue, (api) =>
 * ports)`): the settings come from the addon store over the API, the credential reaches the
 * keychain through the records door, ids and marks survive, a second run is a no-op.
 * Real SQLite for the legacy settings (the hand-written seed), in-memory records.
 */
import { makeInMemoryRecords, REDACTED_SECRET } from '@camstack/types'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { wasteSourceEntryKind } from '../../waste-source-record-kinds.js'
import { WasteSourceStore } from '../../waste-source-store.js'
import { SEED_ADDON_ID, seedWasteLegacy } from '../__fixtures__/seed.js'
import { type WastePortsApi, wasteSourcePortsOver } from '../ports.js'
import { copySourcesToRecords } from '../sources-from-settings.js'

async function world() {
  const db = new Database(':memory:')
  const marks = seedWasteLegacy(db)
  const records = makeInMemoryRecords(SEED_ADDON_ID)
  await records.records.declare({ 'waste-source': wasteSourceEntryKind })
  const warnings: string[] = []
  const settingsRead = async (): Promise<Record<string, unknown>> => {
    const out: Record<string, unknown> = {}
    const rows = db
      .prepare<[string], { data: string }>('SELECT data FROM "addon-settings" WHERE id LIKE ?')
      .all(`${SEED_ADDON_ID}.%`)
    for (const row of rows) {
      const parsed: { key: string; value: unknown } = JSON.parse(row.data)
      out[parsed.key] = parsed.value
    }
    return out
  }
  const handle = records.records.kind(wasteSourceEntryKind)
  const api: WastePortsApi = {
    settings: {
      read: async () => ({ store: await settingsRead() }),
      write: async () => ({}),
      deleteKeys: async () => ({ removed: [] }),
    },
    secrets: {
      resolve: async ({ refs }) => ({ values: Object.fromEntries(refs.map((r) => [r, null])) }),
      put: async () => ({}),
      delete: async () => ({ deleted: 0 }),
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
  return { db, marks, store: WasteSourceStore.of(records.records), raw: handle, api, warnings }
}

describe('waste sources migration over the migration API', () => {
  it('copies the legacy sources keeping ids and marks, credential in the keychain, settings untouched', async () => {
    const { db, marks, store, raw, api } = await world()
    const result = await copySourcesToRecords(wasteSourcePortsOver(api, wasteSourceEntryKind))
    expect(result).toMatchObject({ outcome: 'done', summary: { created: 2, kept: 0 } })

    const rows = await store.listResolved()
    expect(rows.map((r) => r.id).toSorted()).toEqual(['cabin', 'home'])
    for (const row of rows) expect(row.label).toBe(marks.labels[row.id])
    expect(rows.find((r) => r.id === 'home')?.args).toMatchObject({
      password: marks.rawPassword,
      city: 'Torino',
    })
    expect(rows.find((r) => r.id === 'cabin')?.enabled).toBe(false)
    const stored = await raw.get('home')
    expect(stored?.data.args.password).toBe(REDACTED_SECRET)

    // nothing deleted from the old store, the neighbour untouched
    const left = db.prepare('SELECT id FROM "addon-settings" ORDER BY id').all()
    expect(left).toEqual([{ id: 'other-addon.sources' }, { id: `${SEED_ADDON_ID}.sources` }])
  })

  it('a second run changes nothing', async () => {
    const { store, api } = await world()
    const ports = wasteSourcePortsOver(api, wasteSourceEntryKind)
    await copySourcesToRecords(ports)
    const before = JSON.stringify(await store.listResolved())
    expect(await copySourcesToRecords(ports)).toMatchObject({ outcome: 'already-done' })
    expect(JSON.stringify(await store.listResolved())).toBe(before)
  })

  it('refuses a credential the keychain did not serve and writes nothing', async () => {
    const { db, store, api } = await world()
    db.prepare('UPDATE "addon-settings" SET data = ? WHERE id = ?').run(
      JSON.stringify({
        addonId: SEED_ADDON_ID,
        key: 'sources',
        value: [{ id: 'locked', module: 'x', args: { password: { $secret: 'ref-1', v: 1 } } }],
      }),
      `${SEED_ADDON_ID}.sources`,
    )
    await expect(
      copySourcesToRecords(wasteSourcePortsOver(api, wasteSourceEntryKind)),
    ).rejects.toThrow(/credential is unavailable/)
    expect(await store.listIds()).toEqual([])
  })

  it('lets an I/O error from the credential read through instead of reporting it as an unserved credential', async () => {
    const { api } = await world()
    const failing: WastePortsApi = {
      ...api,
      records: {
        kind: (definition) => ({
          ...api.records.kind(definition),
          getResolved: async () => {
            throw new Error('SQLITE_IOERR: disk I/O error')
          },
        }),
      },
    }
    await expect(
      copySourcesToRecords(wasteSourcePortsOver(failing, wasteSourceEntryKind)),
    ).rejects.toThrow(/SQLITE_IOERR/)
  })
})
