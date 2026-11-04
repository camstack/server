/**
 * The exposure migration on REAL SQLite, through the hub's own migration engine: `exposed` and
 * `exposedActions` (rows `export-google.<key>` of the canonical `addon-settings` table) must reach
 * the `google-exports` record unchanged, the old keys may go only after the record holds them, and
 * an unrelated key and another addon's rows must stay.
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
import { GOOGLE_INSTANCE_ID, googleExportsKind } from '../../export-records.js'
import {
  ADDON_MIGRATIONS,
  type GoogleCataloguePorts,
  DROP_MOVED_EXPOSURE_ID,
  EXPOSURE_TO_RECORD_ID,
} from '../index.js'

const SNAPSHOT_WORKER = fileURLToPath(
  new URL(
    '../../../../system/src/builtins/sqlite-storage/sqlite-snapshot-worker.ts',
    import.meta.url,
  ),
)
const ADDON = 'export-google'
const wrapper = (addonId: string, key: string, value: unknown): string =>
  JSON.stringify({ addonId, key, value })

const DEVICES = [
  { deviceId: 7, exposedAt: 1700000000000 },
  { deviceId: 12, exposedAt: 1700000009999 },
]
const ACTIONS = [{ actionId: 'act-1', displayName: 'Night mode', addedAt: 1700000005555 }]
const LEGACY: Record<string, unknown> = {
  exposed: DEVICES,
  exposedActions: ACTIONS,
  linkedAccounts: [{ userId: 'u1', username: 'mark-user', linkedAt: 1700000001111 }],
}

let h: Harness
function seed(values: Record<string, unknown>): void {
  const db = new Database(h.pathOf('settings'))
  db.exec('CREATE TABLE "addon-settings" (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL)')
  const insert = db.prepare('INSERT INTO "addon-settings" (id, data) VALUES (?, ?)')
  for (const [key, value] of Object.entries(values)) {
    insert.run(`${ADDON}.${key}`, wrapper(ADDON, key, value))
  }
  insert.run('other-addon.exposed', wrapper('other-addon', 'exposed', ['keep-me-too']))
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

function storedValues(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [id, data] of Object.entries(rows())) {
    if (!id.startsWith(`${ADDON}.`)) continue
    out[id.slice(`${ADDON}.`.length)] = JSON.parse(data).value
  }
  return out
}

interface Options {
  readonly readFails?: boolean
  /** The record read-back answers with this device list instead of what was written. */
  readonly readBackDevices?: typeof DEVICES
  /** A record is already there, holding these devices. */
  readonly existingDevices?: typeof DEVICES
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
  await memory.records.declare({ 'google-exports': googleExportsKind })
  const exposure = memory.records.kind(googleExportsKind)
  if (options.existingDevices !== undefined) {
    await exposure.put(
      {
        id: GOOGLE_INSTANCE_ID,
        data: { name: 'Mine', devices: options.existingDevices, actions: [] },
      },
      { ifRev: 0 },
    )
  }
  const ports: Pick<GoogleCataloguePorts, 'warn' | 'readStored' | 'putExports' | 'readExports'> = {
    readStored: async () => {
      if (options.readFails === true) throw new Error('settings unreadable')
      return storedValues()
    },
    warn: (message) => {
      warnings.push(message)
    },
    putExports: async (body) => {
      if ((await exposure.get(GOOGLE_INSTANCE_ID)) !== null) return 'exists'
      await exposure.put({ id: GOOGLE_INSTANCE_ID, data: body }, { ifRev: 0 })
      return 'created'
    },
    readExports: async () => {
      const row = await exposure.get(GOOGLE_INSTANCE_ID)
      if (row === null) return null
      return options.readBackDevices === undefined
        ? row.data
        : { ...row.data, devices: options.readBackDevices }
    },
  }
  const bound = defineAddonMigrations(
    ADDON_MIGRATIONS.filter((m) =>
      [EXPOSURE_TO_RECORD_ID, DROP_MOVED_EXPOSURE_ID].includes(m.meta.id),
    ),
    ports,
  )
  const runCatalogue = () => runAddonMigrations(host, bound, recordingLogger(h.lines, 'Addon'))
  const execute = async (id: string): Promise<MigrationOwnerResult> => {
    const entry = bound.find((b) => b.meta.id === id)
    if (entry === undefined) throw new Error(`no ${id}`)
    return entry.execute()
  }
  return { exposure, warnings, runCatalogue, execute }
}

describe('export-google exposure migration on real SQLite', () => {
  it('moves the lists into the record unchanged, deletes the old keys, keeps the rest', async () => {
    seed(LEGACY)
    const w = await boot()
    const report = await w.runCatalogue()
    expect(report.failed ?? []).toEqual([])
    expect(report.blockOwner ?? []).toEqual([])
    const row = await w.exposure.get(GOOGLE_INSTANCE_ID)
    expect(row?.data.devices).toEqual(DEVICES)
    expect(row?.data.actions).toEqual(ACTIONS)
    expect(Object.keys(rows()).sort()).toEqual(
      [`${ADDON}.linkedAccounts`, 'other-addon.exposed'].sort(),
    )
    expect(storedValues()['linkedAccounts']).toEqual(LEGACY['linkedAccounts'])
  })

  it('a second run changes nothing', async () => {
    seed(LEGACY)
    const w = await boot()
    await w.runCatalogue()
    const before = rows()
    const record = await w.exposure.get(GOOGLE_INSTANCE_ID)
    expect(await w.execute(EXPOSURE_TO_RECORD_ID)).toMatchObject({
      result: { outcome: 'already-done' },
    })
    expect(await w.execute(DROP_MOVED_EXPOSURE_ID)).toMatchObject({
      kind: 'plan',
      plan: { edits: [] },
    })
    expect(rows()).toEqual(before)
    expect(await w.exposure.get(GOOGLE_INSTANCE_ID)).toEqual(record)
  })

  it('a failed read of the settings writes nothing and the old keys stay', async () => {
    seed(LEGACY)
    const before = rows()
    const w = await boot({ readFails: true })
    expect(await w.execute(EXPOSURE_TO_RECORD_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('settings unreadable') as string,
    })
    expect(await w.exposure.get(GOOGLE_INSTANCE_ID)).toBeNull()
    expect(rows()).toEqual(before)
  })

  it('a record that does not read back identical fails the move and keeps the old keys', async () => {
    seed(LEGACY)
    const w = await boot({ readBackDevices: DEVICES.slice(1) })
    expect(await w.execute(EXPOSURE_TO_RECORD_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('does not match') as string,
    })
    expect(storedValues()['exposed']).toEqual(DEVICES)
  })

  it('the drop refuses while no record exists', async () => {
    seed(LEGACY)
    const w = await boot()
    expect(await w.execute(DROP_MOVED_EXPOSURE_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('no exposure record') as string,
    })
    expect(storedValues()['exposed']).toEqual(DEVICES)
  })

  it('never overwrites an existing record, and the drop refuses when it lacks a legacy device', async () => {
    seed(LEGACY)
    const w = await boot({ existingDevices: DEVICES.slice(0, 1) })
    expect(await w.execute(EXPOSURE_TO_RECORD_ID)).toMatchObject({
      result: { outcome: 'already-done' },
    })
    expect((await w.exposure.get(GOOGLE_INSTANCE_ID))?.data.name).toBe('Mine')
    expect(await w.execute(DROP_MOVED_EXPOSURE_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('lacks the device 12') as string,
    })
    expect(storedValues()['exposed']).toEqual(DEVICES)
  })
})
