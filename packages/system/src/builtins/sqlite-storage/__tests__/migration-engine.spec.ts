/**
 * The boot-time migration engine (D987) on REAL SQLite: the engine runs from the
 * owned file's `afterOpen`, the pre-migration snapshot is written by the real
 * `SqliteSnapshotter` (a real worker thread, loaded through tsx), and every
 * assertion reads the database itself — not a mock of it.
 */
import { copyFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MigrationMeta } from '@camstack/types'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MigrationEngine } from '../migrations/migration-engine.js'
import type { HubMigration, MigrationDatabase } from '../migrations/migration-types.js'
import { InlineOwnedFile, openOwnedSqliteFile } from '../owned-sqlite-file.js'
import { PRE_MIGRATION_DIR_SUFFIX, SqliteSnapshotter } from '../sqlite-snapshotter.js'
import { makeHarness, recordingLogger, type Harness } from './support/owned-files-harness.js'

const SNAPSHOT_WORKER = fileURLToPath(new URL('../sqlite-snapshot-worker.ts', import.meta.url))
const EXEC_ARGV = ['--import', 'tsx']
const A = 'hub/2026-10-31-a'
const B = 'hub/2026-10-31-b'
const C = 'hub/2026-10-31-c'

function meta(id: string, seq: number): MigrationMeta {
  return {
    id,
    owner: 'hub',
    level: 'hub-store',
    seq,
    dependsOn: [],
    store: 'settings',
    scope: 'cluster',
    onFailure: 'block-owner',
    bodyKind: 'sql',
    description: `test migration ${id}`,
    fixtureMark: 'mark',
  }
}

function migration(id: string, seq: number, run: (db: MigrationDatabase) => void): HubMigration {
  return {
    meta: meta(id, seq),
    run: (db) => {
      run(db)
      return undefined
    },
  }
}

const createTable =
  (table: string) =>
  (db: MigrationDatabase): void => {
    db.exec(`CREATE TABLE ${table} (v TEXT)`)
    db.prepare(`INSERT INTO ${table} (v) VALUES (?)`).run(table)
  }

let h: Harness
beforeEach(() => {
  h = makeHarness()
  const seed = new Database(h.pathOf('settings'))
  seed.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT); INSERT INTO kv VALUES ('seed','1')")
  seed.close()
})
afterEach(() => {
  h.cleanup()
})

interface Booted {
  readonly engine: MigrationEngine
  readonly file: InlineOwnedFile
  readonly order: string[]
}

async function boot(
  catalogue: readonly HubMigration[],
  options: {
    statfsBavail?: number
    codeVersion?: string
    bootId?: string
    restores?: string[]
  } = {},
): Promise<Booted> {
  const order: string[] = []
  const engine = new MigrationEngine({
    logger: recordingLogger(h.lines, 'Migrations'),
    catalogue,
    codeVersion: options.codeVersion ?? '1.0.0',
    ...(options.bootId === undefined ? {} : { bootId: options.bootId }),
    ...(options.restores === undefined
      ? {}
      : {
          scheduleRestore: async (request) => {
            options.restores?.push(request.snapshotPath)
          },
        }),
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
      order.push('afterOpen-done')
    },
  })
  order.push('open-returned')
  if (!(file instanceof InlineOwnedFile)) throw new Error('settings is served inline')
  return { engine, file, order }
}

function rawStatuses(): Record<string, string> {
  const db = new Database(h.pathOf('settings'), { readonly: true })
  try {
    const rows = db.prepare('SELECT id, status FROM _migrations').all()
    return Object.fromEntries(
      rows.flatMap((row) =>
        typeof row === 'object' &&
        row !== null &&
        'id' in row &&
        'status' in row &&
        typeof row.id === 'string' &&
        typeof row.status === 'string'
          ? [[row.id, row.status]]
          : [],
      ),
    )
  } finally {
    db.close()
  }
}

function hasTable(name: string): boolean {
  const db = new Database(h.pathOf('settings'), { readonly: true })
  try {
    return db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name) !== undefined
  } finally {
    db.close()
  }
}

function count(table: string): number {
  const db = new Database(h.pathOf('settings'), { readonly: true })
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()
    return typeof row === 'object' && row !== null && 'n' in row && typeof row.n === 'number'
      ? row.n
      : -1
  } finally {
    db.close()
  }
}

const snapshotDir = (): string => h.pathOf('settings') + PRE_MIGRATION_DIR_SUFFIX
const snapshots = (): string[] =>
  existsSync(snapshotDir()) ? readdirSync(snapshotDir()).filter((f) => f.endsWith('.db')) : []

describe('migration engine over real SQLite', () => {
  it('rolls the failing migration back, records it failed, blocks its dependent, keeps the first', async () => {
    const { engine, file } = await boot([
      migration(A, 1, createTable('a_done')),
      migration(B, 2, (db) => {
        db.prepare("INSERT INTO kv VALUES ('half','written')").run()
        throw new Error('boom in b')
      }),
      migration(C, 3, createTable('c_never')),
    ])
    expect(rawStatuses()).toEqual({ [A]: 'applied', [B]: 'failed', [C]: 'blocked' })
    expect(hasTable('a_done')).toBe(true)
    expect(count('kv')).toBe(1)
    expect(hasTable('c_never')).toBe(false)
    const ledger = await engine.listLedger()
    expect(ledger.find((e) => e.id === B)?.error).toMatch(/boom in b/)
    expect(ledger.find((e) => e.id === B)?.meta?.description).toBe(`test migration ${B}`)
    expect(ledger.find((e) => e.id === B)?.meta?.dependsOn).toEqual(expect.any(Array))
    expect(ledger.find((e) => e.id === C)?.reason).toMatch(/dependency-failed/)
    const failed = h.lines.find((l) => l.message === 'migration failed')
    expect(failed?.level).toBe('error')
    expect(failed?.extras?.tags).toMatchObject({ migrationId: B, owner: 'hub' })
    await file.stop()
  }, 60_000)

  it('applies nothing when the pre-migration snapshot is refused', async () => {
    const { engine, file } = await boot([migration(A, 1, createTable('a_done'))], {
      statfsBavail: 0,
    })
    expect(hasTable('a_done')).toBe(false)
    const entry = (await engine.listLedger()).find((e) => e.id === A)
    expect(entry?.status).toBe('blocked')
    expect(entry?.reason).toBe('snapshot-refused')
    await file.stop()
  }, 60_000)

  it('does not return from open before the migrations finish', async () => {
    const { file, order } = await boot([migration(A, 1, createTable('a_done'))])
    expect(order).toEqual(['afterOpen-done', 'open-returned'])
    expect(hasTable('a_done')).toBe(true)
    await file.stop()
  }, 60_000)

  it('re-runs against a restored older snapshot and converges to one row', async () => {
    const catalogue = [migration(A, 1, createTable('a_done'))]
    const first = await boot(catalogue)
    await first.file.stop()
    const [snapshot] = snapshots()
    expect(snapshot).toBeDefined()
    const live = h.pathOf('settings')
    for (const suffix of ['-wal', '-shm', '-journal']) rmSync(live + suffix, { force: true })
    copyFileSync(join(snapshotDir(), snapshot ?? ''), live)
    expect(hasTable('a_done')).toBe(false)
    const second = await boot(catalogue)
    expect(rawStatuses()[A]).toBe('applied')
    expect(count('a_done')).toBe(1)
    await second.file.stop()
  }, 60_000)

  it('writes nothing for an id this code does not know, and says so', async () => {
    const first = await boot([
      migration(A, 1, createTable('a_done')),
      migration(B, 2, createTable('b_done')),
    ])
    await first.file.stop()
    const second = await boot([migration(A, 1, createTable('a_done'))])
    expect(rawStatuses()).toEqual({ [A]: 'applied', [B]: 'applied' })
    const ledger = await second.engine.listLedger()
    expect(ledger.find((e) => e.id === B)?.status).toBe('skipped-newer')
    expect(h.lines.some((l) => l.level === 'warn' && l.message.includes('skipped-newer'))).toBe(
      true,
    )
    await second.file.stop()
  }, 60_000)

  it('holds what a restore undid until Retry, then runs it', async () => {
    const catalogue = [migration(A, 1, createTable('a_done'))]
    const restores: string[] = []
    const first = await boot(catalogue, { restores })
    const [snapshot] = snapshots()
    const snapshotId = (snapshot ?? '').replace(/\.db$/, '')
    const { held } = await first.engine.restorePreMigration('settings', snapshotId)
    expect(restores).toHaveLength(1)
    expect(held).toContain(A)
    await first.file.stop()
    // What the launcher does at the next start: the snapshot replaces the file.
    const live = h.pathOf('settings')
    for (const suffix of ['-wal', '-shm', '-journal']) rmSync(live + suffix, { force: true })
    copyFileSync(join(snapshotDir(), snapshot ?? ''), live)

    const after = await boot(catalogue)
    expect(hasTable('a_done')).toBe(false)
    expect((await after.engine.listLedger()).find((e) => e.id === A)?.status).toBe('held')
    await after.engine.retry(A)
    expect(hasTable('a_done')).toBe(true)
    expect(rawStatuses()[A]).toBe('applied')
    await after.file.stop()
  }, 90_000)

  it('keeps the last three pre-migration snapshots and the backup sweep leaves them', async () => {
    const all = [A, B, C, 'hub/2026-10-31-d'].map((id, index) =>
      migration(id, index + 1, createTable(`t${index}`)),
    )
    for (let upTo = 1; upTo <= all.length; upTo++) {
      const booted = await boot(all.slice(0, upTo))
      await booted.file.stop()
    }
    expect(snapshots()).toHaveLength(3)
    const sweeper = new SqliteSnapshotter({
      livePath: h.pathOf('settings'),
      logger: recordingLogger(h.lines, 'Snapshot'),
    })
    await sweeper.sweep()
    expect(snapshots()).toHaveLength(3)
  }, 120_000)

  it('dryRun reports the change and leaves the data alone', async () => {
    const booted = await boot([migration(A, 1, createTable('a_done'))], { statfsBavail: 0 })
    const result = await booted.engine.dryRun(A)
    expect(result.ok).toBe(true)
    expect(result.rowsChanged).toBeGreaterThan(0)
    expect(hasTable('a_done')).toBe(false)
    expect(rawStatuses()[A]).toBe('blocked')
    await booted.file.stop()
  }, 60_000)
})
