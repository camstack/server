/**
 * The MQTT broker migrations on REAL SQLite, through the real migration engine: the addon's
 * settings live in the canonical `addon-settings` table (one row per key, id `mqtt-broker.<key>`,
 * data `{ addonId, key, value }`). The legacy `brokers` key must go from where it is stored; an
 * unrelated key and another addon's `brokers` row must stay.
 *
 * The engine is the hub's own (`sqlite-storage`), mounted on purpose from the sibling package.
 */
import { fileURLToPath } from 'node:url'
import {
  type AddonMigrationHost,
  defineAddonMigrations,
  makeInMemoryRecords,
  type MigrationOwnerResult,
  runAddonMigrations,
} from '@camstack/types'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MigrationEngine } from '../../../../system/src/builtins/sqlite-storage/migrations/migration-engine.js'
import { MigrationsProvider } from '../../../../system/src/builtins/sqlite-storage/migrations/migrations-provider.js'
import { openOwnedSqliteFile } from '../../../../system/src/builtins/sqlite-storage/owned-sqlite-file.js'
import { SqliteSnapshotter } from '../../../../system/src/builtins/sqlite-storage/sqlite-snapshotter.js'
import {
  makeHarness,
  recordingLogger,
  type Harness,
} from '../../../../system/src/builtins/sqlite-storage/__tests__/support/owned-files-harness.js'
import { mqttBrokersEntryKind } from '../../broker-record-kinds.js'
import { LEGACY_EMBEDDED_KEYS } from '../embedded-to-onboard.js'
import {
  ADDON_MIGRATIONS,
  BROKERS_TO_RECORDS_ID,
  DROP_BROKERS_KEY_ID,
  DROP_EMBEDDED_KEYS_ID,
  EMBEDDED_TO_ONBOARD_ID,
  type EmbeddedMigrationPorts,
} from '../index.js'

const SNAPSHOT_WORKER = fileURLToPath(
  new URL(
    '../../../../system/src/builtins/sqlite-storage/sqlite-snapshot-worker.ts',
    import.meta.url,
  ),
)
const ADDON = 'mqtt-broker'
const wrapper = (addonId: string, key: string, value: unknown): string =>
  JSON.stringify({ addonId, key, value })

const MARKER = { $secret: 'keychain-ref-hive' }
const LEGACY_BROKERS = [
  { id: 'b-1', name: 'Hive', url: 'mqtt://hive.local:1883', username: 'u', password: MARKER },
  { id: 'b-2', name: 'Plain', url: 'mqtt://plain.local:1883' },
]

let h: Harness
function seed(values: Record<string, unknown>): void {
  const db = new Database(h.pathOf('settings'))
  db.exec('CREATE TABLE "addon-settings" (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL)')
  const insert = db.prepare('INSERT INTO "addon-settings" (id, data) VALUES (?, ?)')
  for (const [key, value] of Object.entries(values)) {
    insert.run(`${ADDON}.${key}`, wrapper(ADDON, key, value))
  }
  insert.run('other-addon.brokers', wrapper('other-addon', 'brokers', ['keep-me']))
  db.close()
}
beforeEach(() => {
  h = makeHarness()
})
afterEach(() => {
  h.cleanup()
})

function rows(): Record<string, string> {
  const db = new Database(h.pathOf('settings'), { readonly: true })
  try {
    const all = db.prepare('SELECT id, data FROM "addon-settings"').all()
    return Object.fromEntries(
      all.flatMap((r) =>
        typeof r === 'object' && r !== null && 'id' in r && 'data' in r
          ? [[String(r.id), String(r.data)]]
          : [],
      ),
    )
  } finally {
    db.close()
  }
}

function ledger(): Record<string, string> {
  const db = new Database(h.pathOf('settings'), { readonly: true })
  try {
    const all = db.prepare('SELECT id, status, error FROM _migrations').all()
    return Object.fromEntries(
      all.flatMap((r) =>
        typeof r === 'object' && r !== null && 'id' in r && 'status' in r
          ? [[String(r.id), 'error' in r && r.error ? `${r.status}: ${r.error}` : String(r.status)]]
          : [],
      ),
    )
  } finally {
    db.close()
  }
}

/** The raw value of the legacy key, as the settings backend answers it. */
function storedBrokers(): unknown {
  const data = rows()[`${ADDON}.brokers`]
  return data === undefined ? undefined : JSON.parse(data).value
}

interface Options {
  /** The ids that exist as records. Default: every legacy id. */
  readonly recordIds?: readonly string[]
  /** Ids whose record holds no password. */
  readonly noPassword?: readonly string[]
}

async function boot(options: Options = {}) {
  const warnings: string[] = []
  const engine = new MigrationEngine({
    logger: recordingLogger(h.lines, 'Migrations'),
    catalogue: [],
    codeVersion: '1.0.0',
    snapshotterFor: (livePath) =>
      new SqliteSnapshotter({
        livePath,
        logger: recordingLogger(h.lines, 'Snapshot'),
        workerPath: SNAPSHOT_WORKER,
        workerExecArgv: ['--import', 'tsx'],
      }),
  })
  await openOwnedSqliteFile(h.specOf('settings'), {
    ...h.deps,
    migrationCatalogue: [],
    afterOpen: async (opened) => {
      await engine.runFile({
        databaseId: opened.databaseId,
        livePath: opened.livePath,
        call: (op, input) => opened.migrate(op, input),
      })
    },
  })
  const provider = new MigrationsProvider(engine)
  const stamp = <T extends object>(input: T): T =>
    Object.assign({}, input, { callerAddonId: ADDON })
  const host: AddonMigrationHost = {
    declareOwner: (input) => provider.declareOwner(stamp(input)),
    startMigration: (input) => provider.startMigration(stamp(input)),
    finishMigration: (input) => provider.finishMigration(stamp(input)),
  }
  const memory = makeInMemoryRecords(ADDON)
  await memory.records.declare({ brokers: mqttBrokersEntryKind })
  const handle = memory.records.kind(mqttBrokersEntryKind)
  for (const id of options.recordIds ?? LEGACY_BROKERS.map((b) => b.id)) {
    const legacy = LEGACY_BROKERS.find((b) => b.id === id)
    await handle.put(
      {
        id,
        data: {
          name: legacy?.name ?? id,
          url: 'mqtt://record.local:1883',
          ...(options.noPassword?.includes(id) === true ? {} : { password: 'pw' }),
        },
      },
      { ifRev: 0 },
    )
  }
  const ports: EmbeddedMigrationPorts = {
    readRawBrokers: async () => storedBrokers(),
    readRecords: async () => {
      const page = await handle.query({ limit: 100 })
      return new Map(
        page.records.map((r): [string, { hasPassword: boolean }] => [
          r.id,
          { hasPassword: (r.data.password ?? '').length > 0 },
        ]),
      )
    },
    readLegacyEmbedded: async () => {
      const raw = (key: string): unknown => {
        const data = rows()[`${ADDON}.${key}`]
        return data === undefined ? undefined : JSON.parse(data).value
      }
      if (raw('embeddedEnabled') !== true) return null
      const port = raw('embeddedPort')
      const username = raw('embeddedUsername')
      const password = raw('embeddedPassword')
      return {
        id: typeof raw('embeddedId') === 'string' ? String(raw('embeddedId')) : 'embedded',
        port: typeof port === 'number' ? port : 1883,
        allowAnonymous: raw('embeddedAllowAnonymous') === true,
        ...(typeof username === 'string' ? { username } : {}),
        ...(typeof password === 'string' ? { password } : {}),
      }
    },
    readRawEmbeddedKeys: async () =>
      Object.fromEntries(
        LEGACY_EMBEDDED_KEYS.flatMap((key) => {
          const data = rows()[`${ADDON}.${key}`]
          return data === undefined ? [] : [[key, JSON.parse(data).value]]
        }),
      ),
    putOnboardRecord: async (id, body) => {
      await handle.put({ id, data: mqttBrokersEntryKind.schema.parse(body) }, { ifRev: 0 })
    },
    warn: (message) => {
      warnings.push(message)
    },
  }
  const bound = defineAddonMigrations(ADDON_MIGRATIONS, ports)
  const runCatalogue = () => runAddonMigrations(host, bound, recordingLogger(h.lines, 'Addon'))
  const execute = async (id: string): Promise<MigrationOwnerResult> => {
    const entry = bound.find((b) => b.meta.id === id)
    if (entry === undefined) throw new Error(`no ${id}`)
    return entry.execute()
  }
  return { handle, warnings, runCatalogue, execute }
}

describe('mqtt-broker migrations on real SQLite', () => {
  it('drops the legacy key once every broker is a record; records, other keys and other addons stay', async () => {
    seed({
      brokers: LEGACY_BROKERS,
      embeddedClients: [{ username: 'kept' }],
      unrelatedMark: 'keep-me',
    })
    const w = await boot()
    const report = await w.runCatalogue()
    expect(report.failed ?? []).toEqual([])
    expect(ledger()).toEqual({
      [BROKERS_TO_RECORDS_ID]: 'applied',
      [DROP_BROKERS_KEY_ID]: 'applied',
      [EMBEDDED_TO_ONBOARD_ID]: 'applied',
      [DROP_EMBEDDED_KEYS_ID]: 'applied',
    })
    const after = rows()
    expect(Object.keys(after).sort()).toEqual(
      ['other-addon.brokers', `${ADDON}.embeddedClients`, `${ADDON}.unrelatedMark`].sort(),
    )
    expect(after[`${ADDON}.unrelatedMark`]).toBe(wrapper(ADDON, 'unrelatedMark', 'keep-me'))
    expect(after['other-addon.brokers']).toBe(wrapper('other-addon', 'brokers', ['keep-me']))
    expect((await w.handle.query({ limit: 10 })).records.map((r) => r.id).sort()).toEqual([
      'b-1',
      'b-2',
    ])
  })

  it('the legacy embedded broker becomes an onboard record under its id and its flat keys go', async () => {
    seed({
      embeddedEnabled: true,
      embeddedId: 'emb-77',
      embeddedPort: 18_841,
      embeddedAllowAnonymous: true,
      embeddedUsername: 'mark-user',
      embeddedPassword: 'mark-pw',
      embeddedClients: [{ username: 'kept' }],
    })
    const w = await boot({ recordIds: [] })
    const report = await w.runCatalogue()
    expect(report.failed ?? []).toEqual([])
    const row = await w.handle.get('emb-77')
    expect(row?.data).toMatchObject({
      url: 'mqtt://127.0.0.1:18841',
      username: 'mark-user',
      onboard: { port: 18_841, allowAnonymous: true },
    })
    expect(Object.keys(rows()).sort()).toEqual(
      ['other-addon.brokers', `${ADDON}.embeddedClients`].sort(),
    )
  })

  it('throws, naming the id, when a legacy broker has no record, and deletes nothing', async () => {
    seed({ brokers: LEGACY_BROKERS })
    const before = rows()
    const w = await boot({ recordIds: ['b-1'] })
    expect(await w.execute(BROKERS_TO_RECORDS_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('b-2') as string,
    })
    expect(rows()).toEqual(before)
    expect(await w.execute(DROP_BROKERS_KEY_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining("broker 'b-2' has no record") as string,
    })
    expect(rows()).toEqual(before)
  })

  it('the drop refuses while a legacy password is still an enc:v1 ciphertext', async () => {
    seed({ brokers: [{ id: 'b-1', name: 'Old', url: 'mqtt://x', password: 'enc:v1:aa:bb:cc' }] })
    const w = await boot({ recordIds: ['b-1'] })
    expect(await w.execute(DROP_BROKERS_KEY_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('enc:v1') as string,
    })
    expect(Object.keys(rows())).toContain(`${ADDON}.brokers`)
  })

  it('the drop refuses while the record of a broker with a password holds none', async () => {
    seed({ brokers: LEGACY_BROKERS })
    const w = await boot({ noPassword: ['b-1'] })
    expect(await w.execute(DROP_BROKERS_KEY_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining("record of broker 'b-1' holds no password") as string,
    })
    expect(storedBrokers()).toEqual(LEGACY_BROKERS)
  })

  it('a second run is already-done and writes nothing', async () => {
    seed({ brokers: LEGACY_BROKERS })
    const w = await boot()
    await w.runCatalogue()
    const before = rows()
    expect(await w.execute(BROKERS_TO_RECORDS_ID)).toMatchObject({
      result: { outcome: 'already-done' },
    })
    expect(await w.execute(DROP_BROKERS_KEY_ID)).toMatchObject({
      kind: 'plan',
      plan: { edits: [] },
    })
    expect(rows()).toEqual(before)
  })
})
