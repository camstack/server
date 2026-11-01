/**
 * D987 M3 on REAL SQLite: the `plan` body (edits applied in the migration's own
 * transaction), addon-owned catalogues (the owner declares, the engine gates and
 * records) and the `procedure` body (idempotent, the ledger records the outcome).
 * Every assertion reads the database file itself.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  type AddonMigration,
  type AddonMigrationHost,
  type AddonMigrationRunReport,
  defineAddonMigrations,
  type MigrationMeta,
  type MigrationPlan,
  preconditionOf,
  runAddonMigrations,
} from '@camstack/types'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MigrationEngine } from '../migrations/migration-engine.js'
import type { HubMigration } from '../migrations/migration-types.js'
import { MigrationsProvider } from '../migrations/migrations-provider.js'
import { InlineOwnedFile, openOwnedSqliteFile } from '../owned-sqlite-file.js'
import { PRE_MIGRATION_DIR_SUFFIX, SqliteSnapshotter } from '../sqlite-snapshotter.js'
import { makeHarness, recordingLogger, type Harness } from './support/owned-files-harness.js'

const SNAPSHOT_WORKER = fileURLToPath(new URL('../sqlite-snapshot-worker.ts', import.meta.url))
const EXEC_ARGV = ['--import', 'tsx']
const SETTINGS = 'ecowitt:addon-settings'

function meta(
  owner: string,
  slug: string,
  seq: number,
  extra: Partial<MigrationMeta> = {},
): MigrationMeta {
  return {
    id: `${owner}/2026-11-01-${slug}`,
    owner,
    level: owner === 'hub' ? 'hub-store' : 'addon-state',
    seq,
    dependsOn: [],
    store: 'settings',
    scope: 'cluster',
    onFailure: 'block-owner',
    bodyKind: 'plan',
    description: `test ${slug}`,
    fixtureMark: 'mark',
    ...extra,
  }
}

let h: Harness
beforeEach(() => {
  h = makeHarness()
  const seed = new Database(h.pathOf('settings'))
  seed.exec(`
    CREATE TABLE "${SETTINGS}" (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL);
    INSERT INTO "${SETTINGS}" VALUES ('host', '"10.0.0.2"'), ('mark', '"survives"');
    CREATE TABLE sensors (id INTEGER PRIMARY KEY, name TEXT, integration_id TEXT, mark TEXT);
    INSERT INTO sensors VALUES (7, 'garden', NULL, 'keep-me'), (8, 'roof', NULL, 'keep-me-too');
  `)
  seed.close()
})
afterEach(() => {
  h.cleanup()
})

interface Booted {
  readonly engine: MigrationEngine
  readonly file: InlineOwnedFile
  readonly provider: MigrationsProvider
}

async function boot(
  catalogue: readonly HubMigration[] = [],
  options: { statfsBavail?: number } = {},
): Promise<Booted> {
  const engine = new MigrationEngine({
    logger: recordingLogger(h.lines, 'Migrations'),
    catalogue,
    codeVersion: '1.0.0',
    snapshotterFor: (livePath) =>
      new SqliteSnapshotter({
        livePath,
        logger: recordingLogger(h.lines, 'Snapshot'),
        workerPath: SNAPSHOT_WORKER,
        workerExecArgv: EXEC_ARGV,
        ...(options.statfsBavail === undefined
          ? {}
          : { statfs: async () => ({ bavail: options.statfsBavail ?? 0, bsize: 1 }) }),
      }),
  })
  const file = await openOwnedSqliteFile(h.specOf('settings'), {
    ...h.deps,
    migrationCatalogue: catalogue,
    afterOpen: async (opened) => {
      await engine.runFile({
        databaseId: opened.databaseId,
        livePath: opened.livePath,
        call: (op, input) => opened.migrate(op, input),
      })
    },
  })
  if (!(file instanceof InlineOwnedFile)) throw new Error('settings is served inline')
  return { engine, file, provider: new MigrationsProvider(engine) }
}

function query<T>(sql: string): T[] {
  const db = new Database(h.pathOf('settings'), { readonly: true })
  try {
    return db
      .prepare(sql)
      .all()
      .flatMap((row) => (isRow(row) ? [row as T] : []))
  } finally {
    db.close()
  }
}
function isRow(row: unknown): boolean {
  return typeof row === 'object' && row !== null
}
const statuses = (): Record<string, string> =>
  Object.fromEntries(
    query<{ id: string; status: string }>('SELECT id, status FROM _migrations').map((r) => [
      r.id,
      r.status,
    ]),
  )
const kv = (): Record<string, string> =>
  Object.fromEntries(
    query<{ id: string; data: string }>(`SELECT id, data FROM "${SETTINGS}"`).map((r) => [
      r.id,
      r.data,
    ]),
  )
const sensorMarks = (): Record<number, string> =>
  Object.fromEntries(
    query<{ id: number; mark: string }>('SELECT id, mark FROM sensors').map((r) => [r.id, r.mark]),
  )

const hostOf = (provider: MigrationsProvider): AddonMigrationHost => provider

/** A hub plan migration: reads the host, returns edits. */
function hubPlan(
  slug: string,
  seq: number,
  plan: (read: Record<string, string>) => MigrationPlan,
): HubMigration {
  return {
    meta: meta('hub', slug, seq),
    plan: (db) =>
      plan(
        Object.fromEntries(
          db
            .prepare(`SELECT id, data FROM "${SETTINGS}"`)
            .all()
            .flatMap((row) =>
              typeof row === 'object' &&
              row !== null &&
              'id' in row &&
              'data' in row &&
              typeof row.id === 'string' &&
              typeof row.data === 'string'
                ? [[row.id, row.data]]
                : [],
            ),
        ),
      ),
  }
}

describe('plan body (hub-owned)', () => {
  it('applies the edits with the applied row, and the marked fields survive', async () => {
    const { engine, file } = await boot([
      hubPlan('rename-host', 1, (read) => ({
        edits: [
          { op: 'setKeys', scope: SETTINGS, values: { address: JSON.parse(read.host ?? 'null') } },
          { op: 'deleteKeys', scope: SETTINGS, keys: ['host'] },
          { op: 'putRow', table: 'sensors', key: { id: 7 }, row: { integration_id: 'int-1' } },
        ],
      })),
    ])
    expect(statuses()).toEqual({ 'hub/2026-11-01-rename-host': 'applied' })
    expect(kv()).toEqual({ address: '"10.0.0.2"', mark: '"survives"' })
    expect(query('SELECT integration_id FROM sensors WHERE id = 7')).toEqual([
      { integration_id: 'int-1' },
    ])
    // The discriminating part: a field the plan never named is untouched, row by row.
    expect(sensorMarks()).toEqual({ 7: 'keep-me', 8: 'keep-me-too' })
    const entry = (await engine.listLedger())[0]
    expect(entry?.planSummary).toEqual({ rowsChanged: 3 })
    expect(entry?.attempts).toBe(1)
    await file.stop()
  }, 60_000)

  it('rolls EVERY edit back when a later edit fails, and records failed', async () => {
    const { engine, file } = await boot([
      hubPlan('half', 1, () => ({
        edits: [
          { op: 'setKeys', scope: SETTINGS, values: { half: 'written' } },
          { op: 'putRow', table: 'no_such_table', key: { id: 1 }, row: { x: 1 } },
        ],
      })),
    ])
    expect(statuses()).toEqual({ 'hub/2026-11-01-half': 'failed' })
    expect(kv()).not.toHaveProperty('half')
    const entry = (await engine.listLedger())[0]
    expect(entry?.error).toMatch(/no_such_table/)
    await file.stop()
  }, 60_000)

  it('refuses a plan whose precondition no longer matches what is stored', async () => {
    const { file } = await boot([
      hubPlan('stale', 1, () => ({
        edits: [
          {
            op: 'setKeys',
            scope: SETTINGS,
            values: { host: 'new' },
            precondition: preconditionOf({ host: 'something-else' }),
          },
        ],
      })),
    ])
    expect(statuses()).toEqual({ 'hub/2026-11-01-stale': 'failed' })
    expect(kv().host).toBe('"10.0.0.2"')
    await file.stop()
  }, 60_000)

  it('applies a plan whose precondition still matches', async () => {
    const { file } = await boot([
      hubPlan('fresh', 1, () => ({
        edits: [
          {
            op: 'setKeys',
            scope: SETTINGS,
            values: { host: 'new' },
            precondition: preconditionOf({ host: '10.0.0.2' }),
          },
        ],
      })),
    ])
    expect(statuses()).toEqual({ 'hub/2026-11-01-fresh': 'applied' })
    expect(kv().host).toBe('"new"')
    await file.stop()
  }, 60_000)

  it('refuses a record edit by name — records are written by the records engine', async () => {
    const { engine, file } = await boot([
      hubPlan('records', 1, () => ({
        edits: [{ op: 'upsertRecord', kind: 'k', recordKey: 'r', value: {} }],
      })),
    ])
    expect(statuses()).toEqual({ 'hub/2026-11-01-records': 'failed' })
    expect((await engine.listLedger())[0]?.error).toMatch(/records engine/)
    await file.stop()
  }, 60_000)
})

describe('addon-owned catalogue', () => {
  const OWNER = 'ecowitt'
  const planEntry = (
    slug: string,
    seq: number,
    plan: MigrationPlan,
    extra: Partial<MigrationMeta> = {},
  ): AddonMigration<Record<string, never>> => ({
    meta: meta(OWNER, slug, seq, extra),
    plan: async () => plan,
  })

  async function run(
    provider: MigrationsProvider,
    catalogue: readonly AddonMigration<Record<string, never>>[],
  ): Promise<AddonMigrationRunReport> {
    return runAddonMigrations(
      hostOf(provider),
      defineAddonMigrations(catalogue, {}),
      recordingLogger(h.lines, 'Addon'),
    )
  }

  it('runs a plan through the engine after a snapshot, and the marked fields survive', async () => {
    const { file, provider } = await boot()
    const report = await run(provider, [
      planEntry('restamp', 1, {
        edits: [
          { op: 'putRow', table: 'sensors', key: { id: 7 }, row: { integration_id: 'int-1' } },
          { op: 'putRow', table: 'sensors', key: { id: 8 }, row: { integration_id: 'int-1' } },
        ],
      }),
    ])
    expect(report).toMatchObject({
      declared: true,
      snapshot: 'written',
      applied: [`${OWNER}/2026-11-01-restamp`],
    })
    expect(statuses()).toEqual({ [`${OWNER}/2026-11-01-restamp`]: 'applied' })
    expect(query('SELECT id, integration_id FROM sensors ORDER BY id')).toEqual([
      { id: 7, integration_id: 'int-1' },
      { id: 8, integration_id: 'int-1' },
    ])
    expect(sensorMarks()).toEqual({ 7: 'keep-me', 8: 'keep-me-too' })
    expect(existsSync(h.pathOf('settings') + PRE_MIGRATION_DIR_SUFFIX)).toBe(true)
    await file.stop()
  }, 60_000)

  it('rolls an addon plan back whole when an edit fails (ledger failed, first edit gone)', async () => {
    const { file, provider } = await boot()
    const report = await run(provider, [
      planEntry('half', 1, {
        edits: [
          { op: 'setKeys', scope: SETTINGS, values: { half: 'written' } },
          { op: 'deleteRow', table: 'no_such_table', key: { id: 1 } },
        ],
      }),
    ])
    expect(report.failed).toEqual([`${OWNER}/2026-11-01-half`])
    expect(statuses()).toEqual({ [`${OWNER}/2026-11-01-half`]: 'failed' })
    expect(kv()).not.toHaveProperty('half')
    await file.stop()
  }, 60_000)

  it('records nothing and offers nothing for an empty catalogue; a hub with none leaves the ledger as it was', async () => {
    const first = await boot()
    const report = await run(first.provider, [])
    expect(report.declared).toBe(false)
    await first.file.stop()
    expect(query("SELECT name FROM sqlite_master WHERE name = '_migrations'")).toHaveLength(1)
    expect(query('SELECT id FROM _migrations')).toEqual([])
    expect(existsSync(h.pathOf('settings') + PRE_MIGRATION_DIR_SUFFIX)).toBe(false)
    // A row from an earlier boot is not touched by a boot whose catalogue is empty.
    const seed = new Database(h.pathOf('settings'))
    seed
      .prepare(
        "INSERT INTO _migrations (id, owner, level, seq, status, attempts, applied_at, code_version, boot_id) VALUES ('hub/2026-01-01-old','hub','hub-store',1,'applied',1,1,'0.9','b0')",
      )
      .run()
    seed.close()
    const before = query('SELECT * FROM _migrations')
    const second = await boot()
    await second.file.stop()
    expect(query('SELECT * FROM _migrations')).toEqual(before)
  }, 60_000)

  it('refuses a catalogue whole: foreign owner, hub-only body, a cycle — nothing is written', async () => {
    const { provider, file, engine } = await boot()
    await expect(engine.declareOwner(OWNER, [meta('someone-else', 'x', 1)])).rejects.toThrow(
      /owned by "someone-else"/,
    )
    await expect(
      engine.declareOwner(OWNER, [meta(OWNER, 'sql', 1, { bodyKind: 'sql' })]),
    ).rejects.toThrow(/hub-only body/)
    await expect(
      engine.declareOwner(OWNER, [
        meta(OWNER, 'a', 1, { dependsOn: [`${OWNER}/2026-11-01-b`] }),
        meta(OWNER, 'b', 2, { dependsOn: [`${OWNER}/2026-11-01-a`] }),
      ]),
    ).rejects.toThrow(/cycle/)
    await expect(engine.declareOwner('hub', [])).rejects.toThrow(/ships with the hub/)
    expect(statuses()).toEqual({})
    expect(await provider.listPending({})).toEqual({ pending: [] })
    await file.stop()
  }, 60_000)

  it('blocks every step when the pre-migration snapshot is refused, and changes no data', async () => {
    const { file, provider } = await boot([], { statfsBavail: 0 })
    const report = await run(provider, [
      planEntry('restamp', 1, {
        edits: [{ op: 'putRow', table: 'sensors', key: { id: 7 }, row: { integration_id: 'x' } }],
      }),
    ])
    expect(report.snapshot).toBe('refused')
    expect(report.blocked).toEqual([`${OWNER}/2026-11-01-restamp`])
    expect(statuses()).toEqual({ [`${OWNER}/2026-11-01-restamp`]: 'blocked' })
    expect(query('SELECT integration_id FROM sensors WHERE id = 7')).toEqual([
      { integration_id: null },
    ])
    await file.stop()
  }, 60_000)

  it('judges an id the owner no longer declares skipped-newer, and leaves an undeclared owner alone', async () => {
    const first = await boot()
    await run(first.provider, [
      planEntry('one', 1, { edits: [] }),
      planEntry('two', 2, { edits: [] }),
    ])
    await first.file.stop()
    const second = await boot()
    // The owner has not booted yet: its applied rows are not "newer".
    expect((await second.engine.listLedger()).map((e) => e.status)).toEqual(['applied', 'applied'])
    expect(h.lines.some((l) => l.message.includes('skipped-newer'))).toBe(false)
    await run(second.provider, [planEntry('one', 1, { edits: [] })])
    const ledger = await second.engine.listLedger()
    expect(ledger.find((e) => e.id.endsWith('-two'))?.status).toBe('skipped-newer')
    expect(statuses()).toEqual({
      [`${OWNER}/2026-11-01-one`]: 'applied',
      [`${OWNER}/2026-11-01-two`]: 'applied',
    })
    await second.file.stop()
  }, 90_000)
})

describe('procedure body', () => {
  const OWNER = 'ecowitt'
  /** The owner's own state: what the work changed outside the database. */
  interface World {
    integrations: string[]
    createCalls: number
  }
  type Ports = { readonly world: World; readonly fail?: boolean }

  const createIntegration = (
    slug: string,
    seq: number,
    extra: Partial<MigrationMeta> = {},
  ): AddonMigration<Ports> => ({
    meta: meta(OWNER, slug, seq, { bodyKind: 'procedure', ...extra }),
    procedure: async ({ world, fail }) => {
      if (fail) throw new Error('keychain locked')
      // Idempotent: a rerun observes the integration and does not make a second one.
      if (world.integrations.includes('origin-1')) {
        return { outcome: 'already-done', summary: { integrations: 1 } }
      }
      world.createCalls++
      world.integrations.push('origin-1')
      return { outcome: 'done', summary: { integrations: 1 } }
    },
  })

  async function run(
    provider: MigrationsProvider,
    catalogue: readonly AddonMigration<Ports>[],
    ports: Ports,
  ): Promise<AddonMigrationRunReport> {
    return runAddonMigrations(
      hostOf(provider),
      defineAddonMigrations(catalogue, ports),
      recordingLogger(h.lines, 'Addon'),
    )
  }

  const P1 = `${OWNER}/2026-11-01-integration`
  const P2 = `${OWNER}/2026-11-01-gateway`

  it('a failed procedure is recorded failed, its dependents are blocked, and the hub boot finished', async () => {
    const { file, provider, engine } = await boot()
    const other: AddonMigration<Ports> = {
      meta: meta('other-addon', 'after', 1, { bodyKind: 'procedure', dependsOn: [P1] }),
      procedure: async () => ({ outcome: 'done', summary: {} }),
    }
    const world: World = { integrations: [], createCalls: 0 }
    const report = await run(
      provider,
      [createIntegration('integration', 1), createIntegration('gateway', 2)],
      { world, fail: true },
    )
    expect(report.failed).toEqual([P1])
    expect(report.blocked).toEqual([P2])
    expect(report.blockOwner).toEqual([P1, P2])
    expect(statuses()).toEqual({ [P1]: 'failed', [P2]: 'blocked' })
    const ledger = await engine.listLedger()
    expect(ledger.find((e) => e.id === P1)?.error).toMatch(/keychain locked/)
    expect(ledger.find((e) => e.id === P2)?.reason).toBe(`dependency-failed:${P1}`)
    // Another owner whose migration dependsOn the failed one is blocked across owners.
    const crossReport = await runAddonMigrations(
      hostOf(provider),
      defineAddonMigrations([other], { world }),
      recordingLogger(h.lines, 'Addon'),
    )
    expect(crossReport.blocked).toEqual(['other-addon/2026-11-01-after'])
    expect(statuses()['other-addon/2026-11-01-after']).toBe('blocked')
    expect(world.createCalls).toBe(0)
    await file.stop()
  }, 60_000)

  it('onFailure tolerate never blocks the owner', async () => {
    const { file, provider } = await boot()
    const world: World = { integrations: [], createCalls: 0 }
    const report = await run(
      provider,
      [createIntegration('integration', 1, { onFailure: 'tolerate' })],
      {
        world,
        fail: true,
      },
    )
    expect(report.failed).toEqual([P1])
    expect(report.blockOwner).toEqual([])
    await file.stop()
  }, 60_000)

  it('a rerun is a no-op: applied rows are skipped and the procedure is not called again', async () => {
    const world: World = { integrations: [], createCalls: 0 }
    const first = await boot()
    await run(first.provider, [createIntegration('integration', 1)], { world })
    await first.file.stop()
    expect(world.createCalls).toBe(1)
    const before = query('SELECT * FROM _migrations')
    const second = await boot()
    const report = await run(second.provider, [createIntegration('integration', 1)], { world })
    expect(report.skipped).toEqual([P1])
    expect(report.applied).toEqual([])
    expect(world.createCalls).toBe(1)
    expect(query('SELECT * FROM _migrations')).toEqual(before)
    await second.file.stop()
  }, 90_000)

  it('after a crash between the work and the ledger row, the rerun observes the work and records applied', async () => {
    const world: World = { integrations: ['origin-1'], createCalls: 1 }
    const { file, provider, engine } = await boot()
    const report = await run(provider, [createIntegration('integration', 1)], { world })
    expect(report.applied).toEqual([P1])
    expect(world.createCalls).toBe(1)
    const entry = (await engine.listLedger()).find((e) => e.id === P1)
    expect(entry?.status).toBe('applied')
    expect(entry?.planSummary).toMatchObject({ outcome: 'already-done' })
    await file.stop()
  }, 60_000)

  it('Retry clears a failed procedure and its blocked dependents; the owner reruns them at its next boot', async () => {
    const world: World = { integrations: [], createCalls: 0 }
    const { file, provider, engine } = await boot()
    const catalogue = [createIntegration('integration', 1), createIntegration('gateway', 2)]
    await run(provider, catalogue, { world, fail: true })
    expect(statuses()).toEqual({ [P1]: 'failed', [P2]: 'blocked' })
    await engine.retry(P1)
    expect(statuses()).toEqual({})
    const report = await run(provider, catalogue, { world })
    expect(report.applied).toEqual([P1, P2])
    expect(statuses()).toEqual({ [P1]: 'applied', [P2]: 'applied' })
    expect(world.createCalls).toBe(1)
    await file.stop()
  }, 60_000)

  it('refuses a body that does not match its declared kind', () => {
    expect(() =>
      defineAddonMigrations(
        [
          {
            meta: meta(OWNER, 'wrong', 1, { bodyKind: 'procedure' }),
            plan: async () => ({ edits: [] }),
          },
        ],
        {},
      ),
    ).toThrow(/declares "procedure"/)
  })
})
