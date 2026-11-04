/**
 * The instance-and-links migrations on REAL SQLite, through the hub's own migration engine: the
 * `linkedAccounts` setting (row `export-google.linkedAccounts` of the canonical `addon-settings`
 * table) must reach the `google-links` record unchanged, the first instance must exist under the
 * id `export-google`, the key may go only after the record holds it, and an unrelated key and
 * another addon's rows must stay.
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
import {
  GOOGLE_INSTANCE_ID,
  type GoogleHomeBody,
  type GoogleLinksBody,
  googleHomesKind,
  googleLinksKind,
} from '../../export-records.js'
import {
  ADDON_MIGRATIONS,
  type GoogleCataloguePorts,
  DROP_MOVED_LINKS_ID,
  INSTANCE_AND_LINKS_ID,
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

const LINKS = [
  { userId: 'u1', username: 'mark-user', linkedAt: 1700000001111 },
  { userId: 'u2', username: 'second-user', linkedAt: 1700000002222 },
]
const LEGACY: Record<string, unknown> = {
  exposed: [{ deviceId: 7, exposedAt: 1700000000000 }],
  linkedAccounts: LINKS,
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
  /** The links read-back answers with this list instead of what was written. */
  readonly readBackLinks?: typeof LINKS
  /** A links row is already there, holding these accounts. */
  readonly existingLinks?: typeof LINKS
  /** The home row is already there under another name. */
  readonly existingHomeName?: string
}

async function boot(options: Options = {}) {
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
  await memory.records.declare({ 'google-homes': googleHomesKind, 'google-links': googleLinksKind })
  const homes = memory.records.kind(googleHomesKind)
  const links = memory.records.kind(googleLinksKind)
  if (options.existingHomeName !== undefined) {
    await homes.put(
      { id: GOOGLE_INSTANCE_ID, data: { name: options.existingHomeName } },
      { ifRev: 0 },
    )
  }
  if (options.existingLinks !== undefined) {
    await links.put(
      { id: GOOGLE_INSTANCE_ID, data: { name: 'Mine', linkedAccounts: options.existingLinks } },
      { ifRev: 0 },
    )
  }
  const putOnce = async <T>(
    handle: {
      get(id: string): Promise<unknown>
      put(i: { id: string; data: T }, o: { ifRev: number }): Promise<unknown>
    },
    data: T,
  ): Promise<'created' | 'exists'> => {
    if ((await handle.get(GOOGLE_INSTANCE_ID)) !== null) return 'exists'
    await handle.put({ id: GOOGLE_INSTANCE_ID, data }, { ifRev: 0 })
    return 'created'
  }
  const ports: Pick<
    GoogleCataloguePorts,
    'warn' | 'readStored' | 'putHome' | 'putLinks' | 'readHome' | 'readLinks'
  > = {
    readStored: async () => {
      if (options.readFails === true) throw new Error('settings unreadable')
      return storedValues()
    },
    warn: () => undefined,
    putHome: (body: GoogleHomeBody) => putOnce(homes, body),
    putLinks: (body: GoogleLinksBody) => putOnce(links, body),
    readHome: async () => (await homes.get(GOOGLE_INSTANCE_ID))?.data ?? null,
    readLinks: async () => {
      const row = await links.get(GOOGLE_INSTANCE_ID)
      if (row === null) return null
      return options.readBackLinks === undefined
        ? row.data
        : { ...row.data, linkedAccounts: options.readBackLinks }
    },
  }
  const bound = defineAddonMigrations(
    ADDON_MIGRATIONS.filter((m) =>
      [INSTANCE_AND_LINKS_ID, DROP_MOVED_LINKS_ID].includes(m.meta.id),
    ),
    // The catalogue's other bodies are not selected here.
    { ...unusedPorts, ...ports },
  )
  const runCatalogue = () => runAddonMigrations(host, bound, recordingLogger(h.lines, 'Addon'))
  const execute = async (id: string): Promise<MigrationOwnerResult> => {
    const entry = bound.find((b) => b.meta.id === id)
    if (entry === undefined) throw new Error(`no ${id}`)
    return entry.execute()
  }
  return { homes, links, runCatalogue, execute }
}

const unusedPorts: Pick<GoogleCataloguePorts, 'putExports' | 'readExports'> = {
  putExports: async () => 'exists',
  readExports: async () => null,
}

describe('export-google instance-and-links migration on real SQLite', () => {
  it('creates the first instance, moves the links unchanged, deletes the key, keeps the rest', async () => {
    seed(LEGACY)
    const w = await boot()
    const report = await w.runCatalogue()
    expect(report.failed ?? []).toEqual([])
    expect(report.blockOwner ?? []).toEqual([])
    expect((await w.homes.get(GOOGLE_INSTANCE_ID))?.data.name).toBe('Google Home')
    expect((await w.links.get(GOOGLE_INSTANCE_ID))?.data.linkedAccounts).toEqual(LINKS)
    expect(Object.keys(rows()).sort()).toEqual([`${ADDON}.exposed`, 'other-addon.exposed'].sort())
    expect(storedValues()['exposed']).toEqual(LEGACY['exposed'])
  })

  it('a hub that never linked still gets its instance', async () => {
    seed({ exposed: [] })
    const w = await boot()
    await w.runCatalogue()
    expect(await w.homes.get(GOOGLE_INSTANCE_ID)).not.toBeNull()
    expect(await w.links.get(GOOGLE_INSTANCE_ID)).toBeNull()
  })

  it('a second run changes nothing', async () => {
    seed(LEGACY)
    const w = await boot()
    await w.runCatalogue()
    const before = rows()
    const home = await w.homes.get(GOOGLE_INSTANCE_ID)
    const links = await w.links.get(GOOGLE_INSTANCE_ID)
    expect(await w.execute(INSTANCE_AND_LINKS_ID)).toMatchObject({
      result: { outcome: 'already-done' },
    })
    expect(await w.execute(DROP_MOVED_LINKS_ID)).toMatchObject({
      kind: 'plan',
      plan: { edits: [] },
    })
    expect(rows()).toEqual(before)
    expect(await w.homes.get(GOOGLE_INSTANCE_ID)).toEqual(home)
    expect(await w.links.get(GOOGLE_INSTANCE_ID)).toEqual(links)
  })

  it('a failed read of the settings writes nothing and the key stays', async () => {
    seed(LEGACY)
    const before = rows()
    const w = await boot({ readFails: true })
    expect(await w.execute(INSTANCE_AND_LINKS_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('settings unreadable') as string,
    })
    expect(await w.homes.get(GOOGLE_INSTANCE_ID)).toBeNull()
    expect(await w.links.get(GOOGLE_INSTANCE_ID)).toBeNull()
    expect(rows()).toEqual(before)
  })

  it('a links record that does not read back identical fails the move and keeps the key', async () => {
    seed(LEGACY)
    const w = await boot({ readBackLinks: LINKS.slice(1) })
    expect(await w.execute(INSTANCE_AND_LINKS_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('does not match') as string,
    })
    expect(storedValues()['linkedAccounts']).toEqual(LINKS)
  })

  it('the drop refuses while no links record exists', async () => {
    seed(LEGACY)
    const w = await boot()
    expect(await w.execute(DROP_MOVED_LINKS_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('no links record') as string,
    })
    expect(storedValues()['linkedAccounts']).toEqual(LINKS)
  })

  it('never overwrites existing rows, and the drop refuses when the record lacks a legacy user', async () => {
    seed(LEGACY)
    const w = await boot({ existingLinks: LINKS.slice(0, 1), existingHomeName: 'Kept' })
    expect(await w.execute(INSTANCE_AND_LINKS_ID)).toMatchObject({
      result: { outcome: 'already-done' },
    })
    expect((await w.homes.get(GOOGLE_INSTANCE_ID))?.data.name).toBe('Kept')
    expect((await w.links.get(GOOGLE_INSTANCE_ID))?.data.name).toBe('Mine')
    expect(await w.execute(DROP_MOVED_LINKS_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('lacks the user u2') as string,
    })
    expect(storedValues()['linkedAccounts']).toEqual(LINKS)
  })
})
