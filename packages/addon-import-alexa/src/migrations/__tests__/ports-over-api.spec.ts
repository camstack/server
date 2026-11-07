/**
 * The whole import-alexa catalogue bound through `MigrationApiV1` only (`runMigrations(catalogue,
 * (api) => ports)`), replayed from the legacy seed of a node that last ran a pre-record release:
 * the Echo rows come from the addon store over the API, the accounts go flat and keep their ids and
 * secrets, the integration link follows the legacy row, and the Echo target becomes a record with
 * its switch carried. A second replay changes nothing. Real SQLite for the settings (the hand-written
 * seed), in-memory records and keychain.
 */
import {
  type AddonMigrationHost,
  defineAddonMigrations,
  type IScopedLogger,
  runAddonMigrations,
} from '@camstack/types'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { alexaBrokersEntryKind, alexaConnectionsEntryKind } from '../../broker-record-kinds.js'
import { ADDON_MIGRATIONS } from '../index.js'
import { type AlexaPortsApi, alexaPortsOver } from '../ports.js'
import {
  nestedRef,
  SEED_ADDON_ID,
  seedAlexaRecords,
  seedAlexaSettings,
} from '../__fixtures__/seed.js'
import { alexaNotifyRecordKinds } from '../../speak/echo-store.js'

const silentLogger: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
  withTags: () => silentLogger,
}

const LEGACY_ROW_REF = 'legacy-row-ref'

const host = (): AddonMigrationHost => ({
  declareOwner: async (input) => ({
    bootId: 'boot',
    snapshot: 'none' as const,
    steps: input.metas.map((m) => ({
      id: m.id,
      action: 'run' as const,
      state: 'pending' as const,
    })),
  }),
  startMigration: async () => ({
    proceed: true,
    state: 'pending' as const,
    reason: null,
  }),
  finishMigration: async () => ({
    status: 'applied' as const,
    error: null,
    rowsChanged: 0,
  }),
})

async function world() {
  const db = new Database(':memory:')
  const marks = seedAlexaSettings(db)
  const memory = await seedAlexaRecords(marks)
  const warnings: string[] = []
  // the legacy row also holds a credential as a keychain marker: it must resolve and be released
  await memory.secrets.put(LEGACY_ROW_REF, 'row-secret')
  let legacyRow: Record<string, unknown> = {
    brokerId: 'alexa_001',
    apiKey: { $secret: LEGACY_ROW_REF, v: 1 },
  }
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
  const api: AlexaPortsApi = {
    settings: {
      read: async () => ({ store: store() }),
      write: async ({ patch }) => {
        for (const [key, value] of Object.entries(patch)) {
          db.prepare('INSERT OR REPLACE INTO "addon-settings" (id, data) VALUES (?, ?)').run(
            `${SEED_ADDON_ID}.${key}`,
            JSON.stringify({ addonId: SEED_ADDON_ID, key, value }),
          )
        }
        return {}
      },
      deleteKeys: async ({ keys }) => ({ removed: keys }),
    },
    secrets: {
      resolve: async ({ refs }) => {
        const answers = await memory.secrets.resolve(refs)
        return {
          values: Object.fromEntries(
            refs.map((ref) => {
              const answer = answers[ref]
              return [ref, answer?.kind === 'value' ? answer.value : null]
            }),
          ),
        }
      },
      put: async () => ({}),
      delete: async ({ refs }) => ({
        deleted: await memory.secrets.delete(refs),
      }),
    },
    log: {
      info: async () => ({}),
      warn: async ({ message }) => {
        warnings.push(message)
        return {}
      },
    },
    integrations: {
      list: async () => ({
        integrations: [
          {
            id: marks.rowIntegration,
            addonId: SEED_ADDON_ID,
            name: 'Alexa',
            info: {},
          },
        ],
      }),
      get: async () => null,
    },
    legacyRows: {
      read: async () => ({ ...legacyRow }),
      clear: async () => {
        legacyRow = {}
        return { rows: 1, secrets: 0 }
      },
      patch: async () => ({ written: false }),
      deleteKeys: async () => ({ present: false, removed: {} }),
    },
    records: {
      kind: (definition) => {
        const h = memory.records.kind(definition)
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
  const replay = () =>
    runAddonMigrations(
      host(),
      defineAddonMigrations(ADDON_MIGRATIONS, alexaPortsOver(api)),
      silentLogger,
    )
  const brokers = memory.records.kind(alexaBrokersEntryKind)
  const connections = memory.records.kind(alexaConnectionsEntryKind)
  const [echoKind] = Object.values(alexaNotifyRecordKinds)
  if (echoKind === undefined) throw new Error('no echo kind')
  const echo = memory.records.kind(echoKind)
  return {
    db,
    marks,
    memory,
    store,
    replay,
    brokers,
    connections,
    echo,
    warnings,
    legacyRow: () => legacyRow,
  }
}

describe('import-alexa catalogue over the migration API', () => {
  it('replays the legacy seed: accounts flat with secrets, links on connections, Echo as a record, nothing foreign touched', async () => {
    const w = await world()
    expect((await w.replay()).failed).toEqual([])

    for (const [id, account] of Object.entries(w.marks.accounts)) {
      const row = await w.brokers.getResolved(id)
      expect(row?.data).not.toHaveProperty('connection')
      expect(row?.data).toMatchObject({
        name: account.name,
        cookie: account.cookie,
        amazonDomain: 'amazon.it',
      })
      expect(row?.data.integrationId).toBeUndefined()
      expect((await w.connections.get(account.integrationId))?.data).toMatchObject({
        brokerId: id,
        name: account.name,
      })
      const old = await w.memory.secrets.resolve([nestedRef(id, 'cookie')])
      expect(old[nestedRef(id, 'cookie')]?.kind).toBe('missing')
    }
    expect(w.legacyRow()).toEqual({})
    expect((await w.memory.secrets.resolve([LEGACY_ROW_REF]))[LEGACY_ROW_REF]?.kind).toBe('missing')

    // the Echo target moved under its id, still off, and left the setting
    expect((await w.echo.getResolved(w.marks.echo.id))?.data).toMatchObject({
      name: w.marks.echo.name,
      enabled: false,
      echoId: 'echo-k',
    })
    expect(w.store()['echoTargets']).toEqual([])
    expect(w.store()[w.marks.unrelated.key]).toBe(w.marks.unrelated.value)
    const neighbour = w.db
      .prepare<[string], { data: string }>('SELECT data FROM "addon-settings" WHERE id = ?')
      .get('other-addon.echoTargets')
    expect(neighbour && JSON.parse(neighbour.data).value).toBe(w.marks.neighbour)
  })

  it('strips the retired volume and mode from a row that stays in the setting', async () => {
    const w = await world()
    // a row that does not parse stays in the setting (nothing is destroyed on a guess)
    const half = { id: 'half', name: 'Half row', volume: 10, mode: 'quiet' }
    const rows = w.store()['echoTargets']
    w.db.prepare('UPDATE "addon-settings" SET data = ? WHERE id = ?').run(
      JSON.stringify({
        addonId: SEED_ADDON_ID,
        key: 'echoTargets',
        value: [...(Array.isArray(rows) ? rows : []), half],
      }),
      `${SEED_ADDON_ID}.echoTargets`,
    )
    await w.replay()
    const left = w.store()['echoTargets']
    expect(Array.isArray(left) && left.length).toBe(2)
    expect(Array.isArray(left) && left.every((r) => !('volume' in r) && !('mode' in r))).toBe(true)
  })

  it('a second replay moves nothing', async () => {
    const w = await world()
    await w.replay()
    const snapshot = JSON.stringify(
      [...w.memory.tables.entries()].map(([k, t]) => [k, [...t.entries()]]),
    )
    const settings = JSON.stringify(w.store())
    expect((await w.replay()).failed).toEqual([])
    expect(
      JSON.stringify([...w.memory.tables.entries()].map(([k, t]) => [k, [...t.entries()]])),
    ).toBe(snapshot)
    expect(JSON.stringify(w.store())).toBe(settings)
  })
})
