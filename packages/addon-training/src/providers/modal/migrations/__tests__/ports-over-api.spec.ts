/**
 * The Modal account migrations bound through `MigrationApiV1` only (`runMigrations(catalogue,
 * (api) => ports)`): the legacy `entries` come from the addon store over the API with their
 * secrets resolved through the keychain handle, every account keeps its id, the old secret is
 * released only after its record holds one, and a second run changes nothing. Real SQLite for the
 * settings (the hand-written seed), in-memory records.
 */
import { makeInMemoryRecords, REDACTED_SECRET } from '@camstack/types'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { trainingAccountEntryKind } from '../../training-account-record-kinds.js'
import { SEED_ADDON_ID, seedModalLegacy } from '../__fixtures__/seed.js'
import { moveEntriesToRecords, planDropMovedSettings } from '../entries-to-records.js'
import { type ModalPortsApi, modalPortsOver } from '../ports.js'

async function world() {
  const db = new Database(':memory:')
  const marks = seedModalLegacy(db)
  const records = makeInMemoryRecords(SEED_ADDON_ID)
  await records.records.declare({ 'training-account': trainingAccountEntryKind })
  const keychain = new Map(Object.values(marks.accounts).map((a) => [a.ref, a.secret]))
  const store = (): Record<string, unknown> => {
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
  const write = (key: string, value: unknown): void => {
    db.prepare('INSERT OR REPLACE INTO "addon-settings" (id, data) VALUES (?, ?)').run(
      `${SEED_ADDON_ID}.${key}`,
      JSON.stringify({ addonId: SEED_ADDON_ID, key, value }),
    )
  }
  const api: ModalPortsApi = {
    settings: {
      read: async () => ({ store: store() }),
      write: async ({ patch }) => {
        for (const [key, value] of Object.entries(patch)) write(key, value)
        return {}
      },
      deleteKeys: async ({ keys }) => {
        for (const key of keys) {
          db.prepare('DELETE FROM "addon-settings" WHERE id = ?').run(`${SEED_ADDON_ID}.${key}`)
        }
        return { removed: keys }
      },
    },
    secrets: {
      resolve: async ({ refs }) => ({
        values: Object.fromEntries(refs.map((ref) => [ref, keychain.get(ref) ?? null])),
      }),
      put: async () => ({}),
      delete: async ({ refs }) => {
        let deleted = 0
        for (const ref of refs) if (keychain.delete(ref)) deleted += 1
        return { deleted }
      },
    },
    log: { info: async () => ({}), warn: async () => ({}) },
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
  return { db, marks, store, keychain, handle: records.records.kind(trainingAccountEntryKind), api }
}

describe('Modal account migrations over the migration API', () => {
  it('moves both accounts under their ids, the secrets into the records, nothing foreign touched', async () => {
    const { marks, store, keychain, handle, api, db } = await world()
    const ports = modalPortsOver(api)
    expect(await moveEntriesToRecords(ports)).toMatchObject({
      outcome: 'done',
      summary: { moved: 2 },
    })

    for (const [id, account] of Object.entries(marks.accounts)) {
      const row = await handle.getResolved(id)
      expect(row?.data.tokenSecret).toBe(account.secret)
      expect(row?.data.name).toBe(id === 'acc-home' ? 'Home mark' : 'Lab mark')
      expect((await handle.get(id))?.data.tokenSecret).toBe(REDACTED_SECRET)
      // the legacy keychain slot is released only because the record holds a secret
      expect(keychain.has(account.ref)).toBe(false)
    }
    const entries = store()['entries']
    expect(Array.isArray(entries) && entries.map((e) => Reflect.get(e, 'tokenSecret'))).toEqual([
      undefined,
      undefined,
    ])
    expect(store()[marks.unrelated.key]).toBe(marks.unrelated.value)
    const neighbour = db
      .prepare<[string], { data: string }>('SELECT data FROM "addon-settings" WHERE id = ?')
      .get('other-addon.entries')
    expect(neighbour && JSON.parse(neighbour.data).value).toBe(marks.neighbour)

    // the drop plan names the moved keys only
    const plan = await planDropMovedSettings(ports)
    const edit = plan.edits[0]
    expect(edit?.op === 'deleteKeys' && edit.keys).toEqual([`${SEED_ADDON_ID}.entries`])
  })

  it('a second run moves nothing', async () => {
    const { api, handle } = await world()
    const ports = modalPortsOver(api)
    await moveEntriesToRecords(ports)
    const before = JSON.stringify([await handle.get('acc-home'), await handle.get('acc-lab')])
    expect(await moveEntriesToRecords(ports)).toMatchObject({ outcome: 'already-done' })
    expect(JSON.stringify([await handle.get('acc-home'), await handle.get('acc-lab')])).toBe(before)
  })

  it('writes nothing when a secret cannot be resolved', async () => {
    const { api, keychain, handle } = await world()
    keychain.delete('ref-lab')
    await expect(moveEntriesToRecords(modalPortsOver(api))).rejects.toThrow(/could not be resolved/)
    expect(await handle.get('acc-home')).toBeNull()
  })
})
