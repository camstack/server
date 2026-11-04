/**
 * The export-links migration on REAL SQLite, through the hub's own migration engine: the
 * `membership` setting and the `exportTo:` / `mediaRole:` keys (rows `homeassistant-export.<key>`
 * of the canonical `addon-settings` table), plus the flags the instance's integration carries,
 * must reach one `ha-export-links` record per broker unchanged. The old keys may go only after
 * every record holds what they carried; an unrelated key and another addon's rows must stay.
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
import { MigrationEngine } from '../../../../../system/src/builtins/sqlite-storage/migrations/migration-engine.js'
import { MigrationsProvider } from '../../../../../system/src/builtins/sqlite-storage/migrations/migrations-provider.js'
import { openOwnedSqliteFile } from '../../../../../system/src/builtins/sqlite-storage/owned-sqlite-file.js'
import { SqliteSnapshotter } from '../../../../../system/src/builtins/sqlite-storage/sqlite-snapshotter.js'
import {
  makeHarness,
  recordingLogger,
  type Harness,
} from '../../../../../system/src/builtins/sqlite-storage/__tests__/support/owned-files-harness.js'
import type { HaInstanceRow } from '../../../ha-instance-settings.js'
import { defaultLinks, type HaExportLinksBody, haExportLinksKind } from '../../link-records.js'
import { DROP_MOVED_LINKS_ID, LINKS_TO_RECORD_ID } from '../index.js'
import { ADDON_MIGRATIONS, type HaExportMigrationPorts } from '../index.js'

const SNAPSHOT_WORKER = fileURLToPath(
  new URL(
    '../../../../../system/src/builtins/sqlite-storage/sqlite-snapshot-worker.ts',
    import.meta.url,
  ),
)
const ADDON = 'homeassistant-export'
const wrapper = (addonId: string, key: string, value: unknown): string =>
  JSON.stringify({ addonId, key, value })

const LEGACY: Record<string, unknown> = {
  membership: { ha_001: ['101', '104'], ha_002: ['20'] },
  'exportTo:ha_001': true,
  'mediaRole:ha_001': 'publicEndpoint',
  'exportTo:ha_002': false,
  reconcileIntervalSec: 217,
}
/** The integration of ha_002 already carries the switch: it wins over the (older) key. */
const INSTANCES: readonly HaInstanceRow[] = [
  { integrationId: 'int_2', brokerId: 'ha_002', settings: { brokerId: 'ha_002', exportTo: true } },
]

let h: Harness
function seed(values: Record<string, unknown>): void {
  const db = new Database(h.pathOf('settings'))
  db.exec('CREATE TABLE "addon-settings" (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL)')
  const insert = db.prepare('INSERT INTO "addon-settings" (id, data) VALUES (?, ?)')
  for (const [key, value] of Object.entries(values)) {
    insert.run(`${ADDON}.${key}`, wrapper(ADDON, key, value))
  }
  insert.run('other-addon.membership', wrapper('other-addon', 'membership', { keep: ['me'] }))
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
  readonly integrationsFail?: boolean
  /** The read-back of `ha_001` answers with these devices instead of what was written. */
  readBackDevices?: readonly string[]
  /** Records already there. */
  readonly existing?: Readonly<Record<string, HaExportLinksBody>>
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
  await memory.records.declare({ 'ha-export-links': haExportLinksKind })
  const links = memory.records.kind(haExportLinksKind)
  for (const [id, data] of Object.entries(options.existing ?? {})) {
    await links.put({ id, data }, { ifRev: 0 })
  }
  const ports: Pick<
    HaExportMigrationPorts,
    'readStored' | 'listInstances' | 'warn' | 'putLinks' | 'readLinks'
  > = {
    readStored: async () => {
      if (options.readFails === true) throw new Error('settings unreadable')
      return storedValues()
    },
    listInstances: async () => {
      if (options.integrationsFail === true) throw new Error('integrations unreadable')
      return INSTANCES
    },
    warn: (message) => {
      warnings.push(message)
    },
    putLinks: async (brokerId, body) => {
      if ((await links.get(brokerId)) !== null) return 'exists'
      await links.put({ id: brokerId, data: body }, { ifRev: 0 })
      return 'created'
    },
    readLinks: async () => {
      const page = await links.query({ limit: 100 })
      return new Map(
        page.records.map((row) => [
          row.id,
          row.id === 'ha_001' && options.readBackDevices !== undefined
            ? { ...row.data, devices: options.readBackDevices }
            : row.data,
        ]),
      )
    },
  }
  const bound = defineAddonMigrations(
    ADDON_MIGRATIONS.filter((m) => [LINKS_TO_RECORD_ID, DROP_MOVED_LINKS_ID].includes(m.meta.id)),
    // The two bodies read only these ports; the other catalogue entries are filtered out above.
    { ...ports, patchInstanceSettings: async () => false },
  )
  const runCatalogue = () => runAddonMigrations(host, bound, recordingLogger(h.lines, 'Addon'))
  const execute = async (id: string): Promise<MigrationOwnerResult> => {
    const entry = bound.find((b) => b.meta.id === id)
    if (entry === undefined) throw new Error(`no ${id}`)
    return entry.execute()
  }
  const record = async (id: string) => (await links.get(id))?.data ?? null
  return { links, record, warnings, runCatalogue, execute }
}

const HOME: HaExportLinksBody = {
  name: 'ha_001',
  exportTo: true,
  mediaRole: 'publicEndpoint',
  devices: ['101', '104'],
}
const CABIN: HaExportLinksBody = {
  name: 'ha_002',
  exportTo: true,
  mediaRole: 'internal',
  devices: ['20'],
}

describe('homeassistant-export links migration on real SQLite', () => {
  it('moves membership and both flags into one record per broker, deletes the old keys, keeps the rest', async () => {
    seed(LEGACY)
    const w = await boot()
    const report = await w.runCatalogue()
    expect(report.failed ?? []).toEqual([])
    expect(report.blockOwner ?? []).toEqual([])
    expect(await w.record('ha_001')).toEqual(HOME)
    expect(await w.record('ha_002')).toEqual(CABIN)
    expect(Object.keys(rows()).sort()).toEqual(
      [`${ADDON}.reconcileIntervalSec`, 'other-addon.membership'].sort(),
    )
    expect(storedValues()['reconcileIntervalSec']).toBe(217)
  })

  it('a second run changes nothing', async () => {
    seed(LEGACY)
    const w = await boot()
    await w.runCatalogue()
    const before = rows()
    const home = await w.record('ha_001')
    expect(await w.execute(LINKS_TO_RECORD_ID)).toMatchObject({
      result: { outcome: 'already-done' },
    })
    expect(await w.execute(DROP_MOVED_LINKS_ID)).toMatchObject({
      kind: 'plan',
      plan: { edits: [] },
    })
    expect(rows()).toEqual(before)
    expect(await w.record('ha_001')).toEqual(home)
  })

  it('a failed read of the settings writes nothing and the old keys stay', async () => {
    seed(LEGACY)
    const before = rows()
    const w = await boot({ readFails: true })
    expect(await w.execute(LINKS_TO_RECORD_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('settings unreadable') as string,
    })
    expect(await w.record('ha_001')).toBeNull()
    expect(rows()).toEqual(before)
  })

  it('a failed read of the integrations writes nothing and the old keys stay', async () => {
    seed(LEGACY)
    const before = rows()
    const w = await boot({ integrationsFail: true })
    expect(await w.execute(LINKS_TO_RECORD_ID)).toMatchObject({ kind: 'failed' })
    expect(await w.record('ha_001')).toBeNull()
    expect(rows()).toEqual(before)
  })

  it('a record that does not read back identical fails the move and keeps the old keys', async () => {
    seed(LEGACY)
    const w = await boot({ readBackDevices: ['101'] })
    expect(await w.execute(LINKS_TO_RECORD_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('does not match') as string,
    })
    expect(storedValues()['membership']).toEqual(LEGACY['membership'])
  })

  it('the drop refuses while no record exists', async () => {
    seed(LEGACY)
    const w = await boot()
    expect(await w.execute(DROP_MOVED_LINKS_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('no export-links record') as string,
    })
    expect(storedValues()['membership']).toEqual(LEGACY['membership'])
  })

  it('never overwrites an existing record, and the drop refuses when it lacks a legacy device', async () => {
    seed(LEGACY)
    const w = await boot({
      existing: {
        ha_001: { ...defaultLinks('Mine'), exportTo: true, mediaRole: 'publicEndpoint' },
      },
    })
    expect(await w.execute(LINKS_TO_RECORD_ID)).toMatchObject({ result: { outcome: 'done' } })
    expect((await w.record('ha_001'))?.name).toBe('Mine')
    expect(await w.record('ha_002')).toEqual(CABIN)
    expect(await w.execute(DROP_MOVED_LINKS_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('lacks the device 101') as string,
    })
    expect(storedValues()['membership']).toEqual(LEGACY['membership'])
  })

  it('the drop refuses when a record disagrees on the switch', async () => {
    seed(LEGACY)
    const w = await boot({ existing: { ha_001: { ...HOME, exportTo: false } } })
    await w.execute(LINKS_TO_RECORD_ID)
    expect(await w.execute(DROP_MOVED_LINKS_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('disagrees') as string,
    })
    expect(storedValues()['exportTo:ha_001']).toBe(true)
  })
})
