/**
 * The Home Assistant flatten migration on REAL SQLite, through the real migration engine and the
 * real records engine behind the real provider (D881): rows are first written NESTED under a
 * legacy kind declaration, so the keychain holds the nested refs exactly as an old hub does, then
 * the flat kind is declared and the migration runs. The keychain is the spec keychain (no hub).
 */
import { fileURLToPath } from 'node:url'
import {
  type AddonMigrationHost,
  createRecordsAccess,
  createSecretsAccess,
  defineAddonMigrations,
  defineEntryKind,
  entryBody,
  type FlattenRowPorts,
  flattenPortsOver,
  type MigrationOwnerResult,
  recordSecretRef,
  runAddonMigrations,
} from '@camstack/types'
import Database from 'better-sqlite3'
import { z } from 'zod'
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
import {
  makeFakeKeychain,
  makeRecordsWorld,
} from '../../../../system/src/builtins/sqlite-storage/__tests__/support/records-world.js'
import { HA_BROKERS_KIND, HA_BROKERS_OWNER, haBrokersEntryKind } from '../../broker-record-kinds.js'
import { ADDON_MIGRATIONS, FLATTEN_BROKER_RECORDS_ID } from '../index.js'

const SNAPSHOT_WORKER = fileURLToPath(
  new URL(
    '../../../../system/src/builtins/sqlite-storage/sqlite-snapshot-worker.ts',
    import.meta.url,
  ),
)

/** The kind as the hub declared it before the flat body: the connection nested under `auth`. */
const legacyKind = defineEntryKind(HA_BROKERS_KIND, {
  title: 'Home Assistant brokers',
  schema: entryBody({
    auth: z.object({
      kind: z.string(),
      baseUrl: z.string().optional(),
      accessToken: z.string().optional().meta({ secret: true }),
      supervisorToken: z.string().optional().meta({ secret: true }),
    }),
    integrationId: z.string().optional(),
  }),
})

const ADDON = HA_BROKERS_OWNER
const nestedRef = (id: string, key: string): string =>
  recordSecretRef(HA_BROKERS_OWNER, HA_BROKERS_KIND, id, `auth.${key}`)

let h: Harness
beforeEach(() => {
  h = makeHarness()
})
afterEach(() => {
  h.cleanup()
})

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

async function boot() {
  const keychain = makeFakeKeychain()
  const world = makeRecordsWorld()
  await world.provider.init()
  const transport = world.transportFor(HA_BROKERS_OWNER)
  const access = () =>
    createRecordsAccess({
      owner: HA_BROKERS_OWNER,
      transport,
      secrets: createSecretsAccess({
        owner: HA_BROKERS_OWNER,
        transport: keychain,
      }),
    })

  // An old hub: nested rows, nested refs in the keychain.
  const old = access()
  await old.declare({ [HA_BROKERS_KIND]: legacyKind })
  const oldHandle = old.kind(legacyKind)
  await oldHandle.put(
    {
      id: 'ha_001',
      data: {
        name: 'Broker one',
        integrationId: 'int-marked-1',
        auth: {
          kind: 'long-lived',
          baseUrl: 'http://ha.local:8123',
          accessToken: 'tok-1',
        },
      },
    },
    { ifRev: 0 },
  )
  await oldHandle.put(
    {
      id: 'ha_002',
      data: {
        name: 'Broker two',
        auth: { kind: 'supervisor', supervisorToken: 'sup-2' },
      },
    },
    { ifRev: 0 },
  )

  // This boot: the flat kind.
  const next = access()
  await next.declare({ [HA_BROKERS_KIND]: haBrokersEntryKind })
  const handle = next.kind(haBrokersEntryKind)
  const ports: FlattenRowPorts = flattenPortsOver(handle)

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
  const flatOnly = ADDON_MIGRATIONS.filter((m) => m.meta.id === FLATTEN_BROKER_RECORDS_ID)
  const bind = (over: FlattenRowPorts) =>
    defineAddonMigrations(flatOnly, {
      ...over,
      listInstances: async () => [],
      patchInstanceSettings: async () => false,
      readStored: async () => ({ kind: 'absent' }),
    })
  return { keychain, handle, ports, host, bind }
}

type World = Awaited<ReturnType<typeof boot>>

async function execute(w: World, ports: FlattenRowPorts = w.ports): Promise<MigrationOwnerResult> {
  const entry = w.bind(ports).find((b) => b.meta.id === FLATTEN_BROKER_RECORDS_ID)
  if (entry === undefined) throw new Error('flatten migration is not in the catalogue')
  return entry.execute()
}

async function rowsOf(w: World) {
  return (await w.handle.query({ limit: 10 })).records
}

describe('HA flatten-broker-records on real SQLite', () => {
  it('moves the nested rows flat through the engine: same ids, marked field kept, secrets resolve, old refs gone', async () => {
    const w = await boot()
    expect(w.keychain.values.has(nestedRef('ha_001', 'accessToken'))).toBe(true)
    const report = await runAddonMigrations(
      w.host,
      w.bind(w.ports),
      recordingLogger(h.lines, 'Addon'),
    )
    expect(report.failed ?? []).toEqual([])
    expect(ledger()).toEqual({ [FLATTEN_BROKER_RECORDS_ID]: 'applied' })

    const rows = await rowsOf(w)
    expect(rows.map((r) => r.id).sort()).toEqual(['ha_001', 'ha_002'])
    for (const row of rows) expect(row.data).not.toHaveProperty('auth')
    const one = await w.handle.getResolved('ha_001')
    expect(one?.data).toMatchObject({
      integrationId: 'int-marked-1',
      authKind: 'long-lived',
      baseUrl: 'http://ha.local:8123',
      accessToken: 'tok-1',
    })
    const two = await w.handle.getResolved('ha_002')
    expect(two?.data).toMatchObject({
      authKind: 'supervisor',
      supervisorToken: 'sup-2',
    })
    // The only secrets left in the keychain are the flat ones.
    const refs = [...w.keychain.values.keys()]
    expect(refs.filter((ref) => ref.includes('auth.'))).toEqual([])
    expect(refs).toHaveLength(2)
  })

  it('a second run is already-done and writes nothing', async () => {
    const w = await boot()
    await runAddonMigrations(w.host, w.bind(w.ports), recordingLogger(h.lines, 'Addon'))
    const before = JSON.stringify(await rowsOf(w))
    const refsBefore = [...w.keychain.values.entries()]
    expect(await execute(w)).toMatchObject({
      result: { outcome: 'already-done' },
    })
    expect(JSON.stringify(await rowsOf(w))).toBe(before)
    expect([...w.keychain.values.entries()]).toEqual(refsBefore)
  })

  it('an unreadable secret fails the migration and leaves every row nested and every ref in place', async () => {
    const w = await boot()
    w.keychain.values.delete(nestedRef('ha_002', 'supervisorToken'))
    const before = JSON.stringify(await rowsOf(w))
    const report = await runAddonMigrations(
      w.host,
      w.bind(w.ports),
      recordingLogger(h.lines, 'Addon'),
    )
    expect((report.failed ?? []).length).toBeGreaterThan(0)
    expect(ledger()[FLATTEN_BROKER_RECORDS_ID]).toMatch(/^failed/)
    expect(JSON.stringify(await rowsOf(w))).toBe(before)
    expect(w.keychain.values.has(nestedRef('ha_001', 'accessToken'))).toBe(true)
  })

  it('a crash before the nested object is patched out leaves nothing stranded; the rerun finishes the row', async () => {
    const w = await boot()
    let calls = 0
    const crashing: FlattenRowPorts = {
      ...w.ports,
      patch: async (id, patch) => {
        calls += 1
        // 1 = flat fields of ha_001, 2 = its nested object going out: crash there.
        if (calls === 2) throw new Error('crash before the nested object left')
        await w.ports.patch(id, patch)
      },
    }
    expect(await execute(w, crashing)).toMatchObject({ kind: 'failed' })
    const half = await rowsOf(w)
    expect(half.find((r) => r.id === 'ha_001')?.data).toHaveProperty('auth')
    // The nested refs are still there: the pointer and the refs leave together.
    expect(w.keychain.values.has(nestedRef('ha_001', 'accessToken'))).toBe(true)

    expect(await execute(w)).toMatchObject({ result: { outcome: 'done' } })
    for (const row of await rowsOf(w)) expect(row.data).not.toHaveProperty('auth')
    expect((await w.handle.getResolved('ha_001'))?.data).toMatchObject({
      accessToken: 'tok-1',
    })
    expect([...w.keychain.values.keys()].filter((ref) => ref.includes('auth.'))).toEqual([])
  })
})
