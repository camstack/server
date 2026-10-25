/**
 * The owner's snapshot is consistent while the database is being written
 * (D693) — the property a tar of the live files never had (6/6 archives torn,
 * D679).
 *
 * Real everything: a WAL database, the REAL snapshot worker thread (loaded
 * through tsx), the REAL checkpoint worker folding the WAL underneath it, and
 * a writer committing transfers the whole time — once on another connection
 * in this process (the shape of production: the settings connection writes
 * while its own worker copies), once from another PROCESS.
 *
 * Every transfer keeps two invariants: the sum of the balances never changes,
 * and `ledger` and `audit` move together. A snapshot that mixed two instants
 * breaks at least one of them, or fails `integrity_check`. The spec also
 * proves the writes really overlapped the copy (commits counted between start
 * and finish), so a green run is not a quiet database.
 *
 * Disarmed by dropping the pinned read transaction in the worker, the copy
 * restarts on every interleaved write and its row counts no longer equal the
 * counts read before it — the snapshot is refused (`row-count`) and both
 * cases go red.
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import {
  DATABASE_SNAPSHOT_PARTIAL_SUFFIX,
  DATABASE_SNAPSHOT_SUFFIX,
  type IScopedLogger,
  type LogExtras,
} from '@camstack/types'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteSnapshotter, snapshotSpaceNeeded } from '../sqlite-snapshotter.js'
import { WalCheckpointer } from '../wal-checkpointer.js'

const SNAPSHOT_WORKER = fileURLToPath(new URL('../sqlite-snapshot-worker.ts', import.meta.url))
const CHECKPOINT_WORKER = fileURLToPath(new URL('../wal-checkpoint-worker.ts', import.meta.url))
const WRITER = fileURLToPath(new URL('./support/transfer-writer.mjs', import.meta.url))
const STALLED_WORKER = fileURLToPath(
  new URL('./support/stalled-snapshot-worker.mjs', import.meta.url),
)
/** Threads load the TypeScript sources through tsx; production loads the built entries. */
const EXEC_ARGV = ['--import', 'tsx']

const ACCOUNTS = 200
const OPENING_BALANCE = 1000
const SEEDED_LEDGER = 25_000

interface LoggedLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly extras?: LogExtras
}

interface RecordingLogger {
  readonly logger: IScopedLogger
  readonly lines: LoggedLine[]
}

interface SeededDatabase {
  readonly dir: string
  readonly live: string
}

/** A writer that runs until stopped; `stop` resolves with the commits it made. */
interface Writer {
  readonly stop: () => Promise<number>
}

interface InProcessWriter extends Writer {
  readonly commits: () => number
}

function makeLogger(): RecordingLogger {
  const lines: LoggedLine[] = []
  const push =
    (level: LoggedLine['level']) =>
    (message: string, extras?: LogExtras): void => {
      lines.push(extras === undefined ? { level, message } : { level, message, extras })
    }
  const logger: IScopedLogger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, lines }
}

const tmpDirs: string[] = []
const openDbs: Database.Database[] = []
const checkpointers: WalCheckpointer[] = []
const children: ChildProcessWithoutNullStreams[] = []
afterEach(async () => {
  for (const c of checkpointers.splice(0)) await c.stop()
  for (const child of children.splice(0)) child.kill('SIGKILL')
  for (const db of openDbs.splice(0)) {
    try {
      db.close()
    } catch {
      /* closed */
    }
  }
  for (const dir of tmpDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

async function seededDatabase(): Promise<SeededDatabase> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-snapshot-writes-'))
  tmpDirs.push(dir)
  const live = path.join(dir, 'camstack.db')
  const db = new Database(live)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE account (id INTEGER PRIMARY KEY, balance INTEGER NOT NULL);
    CREATE TABLE ledger (id INTEGER PRIMARY KEY, from_id INTEGER NOT NULL, to_id INTEGER NOT NULL,
                         amount INTEGER NOT NULL, memo TEXT NOT NULL);
    CREATE INDEX ledger_from ON ledger (from_id);
    CREATE TABLE audit (id INTEGER PRIMARY KEY, ledger_id INTEGER NOT NULL);
    CREATE INDEX audit_ledger ON audit (ledger_id);
  `)
  const acct = db.prepare('INSERT INTO account (id, balance) VALUES (?, ?)')
  const led = db.prepare('INSERT INTO ledger (from_id, to_id, amount, memo) VALUES (?, ?, 0, ?)')
  const aud = db.prepare('INSERT INTO audit (ledger_id) VALUES (?)')
  db.transaction(() => {
    for (let i = 1; i <= ACCOUNTS; i++) acct.run(i, OPENING_BALANCE)
    for (let i = 0; i < SEEDED_LEDGER; i++) {
      const { lastInsertRowid } = led.run(1 + (i % ACCOUNTS), 1, `seed${i}`.padEnd(160, '.'))
      aud.run(lastInsertRowid)
    }
  })()
  db.close()
  return { dir, live }
}

/** A writer on another connection IN THIS PROCESS — the settings connection's shape. */
function startInProcessWriter(live: string): InProcessWriter {
  const db = new Database(live)
  openDbs.push(db)
  db.pragma('busy_timeout = 5000')
  db.pragma('wal_autocheckpoint = 10000')
  const move = db.prepare('UPDATE account SET balance = balance + ? WHERE id = ?')
  const addLedger = db.prepare(
    'INSERT INTO ledger (from_id, to_id, amount, memo) VALUES (?, ?, ?, ?)',
  )
  const addAudit = db.prepare('INSERT INTO audit (ledger_id) VALUES (?)')
  const oldest = db.prepare('SELECT min(id) AS id FROM ledger')
  const dropLedger = db.prepare('DELETE FROM ledger WHERE id = ?')
  const dropAudit = db.prepare('DELETE FROM audit WHERE ledger_id = ?')
  let seq = 0
  const transfer = db.transaction(() => {
    seq++
    const from = 1 + (seq % ACCOUNTS)
    const to = 1 + ((seq * 7) % ACCOUNTS)
    const amount = 1 + (seq % 13)
    move.run(-amount, from)
    move.run(amount, to)
    const { lastInsertRowid } = addLedger.run(from, to, amount, `m${seq}`.padEnd(160, '.'))
    addAudit.run(lastInsertRowid)
    if (seq % 3 === 0) {
      const row: unknown = oldest.get()
      if (typeof row === 'object' && row !== null && 'id' in row && typeof row.id === 'number') {
        dropAudit.run(row.id)
        dropLedger.run(row.id)
      }
    }
  })
  let stopping = false
  let commits = 0
  let resolveStopped: (n: number) => void = () => {}
  const stopped = new Promise<number>((resolve) => {
    resolveStopped = resolve
  })
  const loop = (): void => {
    if (stopping) {
      resolveStopped(commits)
      return
    }
    for (let i = 0; i < 5; i++) {
      transfer()
      commits++
    }
    setImmediate(loop)
  }
  setImmediate(loop)
  return {
    stop: async () => {
      stopping = true
      return stopped
    },
    commits: () => commits,
  }
}

/** A writer in ANOTHER PROCESS. Resolves once it is writing. */
async function startChildWriter(live: string): Promise<Writer> {
  const child = spawn(process.execPath, [WRITER, live], { stdio: ['pipe', 'pipe', 'pipe'] })
  children.push(child)
  const lines = createInterface({ input: child.stdout })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  let commitsLine: (n: number) => void = () => {}
  const commits = new Promise<number>((resolve, reject) => {
    commitsLine = resolve
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(`writer exited ${code}: ${stderr}`))
    })
  })
  await new Promise<void>((resolve, reject) => {
    lines.on('line', (line) => {
      if (line === 'READY') resolve()
      const m = /^COMMITS (\d+)$/.exec(line)
      if (m?.[1] !== undefined) commitsLine(Number(m[1]))
    })
    child.on('error', reject)
  })
  return {
    stop: async () => {
      child.stdin.write('STOP\n')
      return commits
    },
  }
}

function scalar(db: Database.Database, sql: string): number {
  const row: unknown = db.prepare(sql).get()
  if (typeof row === 'object' && row !== null && 'v' in row && typeof row.v === 'number') {
    return row.v
  }
  throw new Error(`no number from ${sql}`)
}

async function snapshotWhileWriting(
  live: string,
  writer: Writer,
  commitsSoFar: () => Promise<number>,
): Promise<void> {
  const { logger } = makeLogger()
  const checkpointer = new WalCheckpointer({
    dbPath: live,
    logger,
    pollMs: 20,
    maxDelayMs: 100,
    workerPath: CHECKPOINT_WORKER,
    workerExecArgv: EXEC_ARGV,
  })
  checkpointers.push(checkpointer)
  checkpointer.start()

  const snapshotter = new SqliteSnapshotter({
    livePath: live,
    logger,
    // Tiny steps stretch the copy over many yields, so the writes interleave.
    pagesPerStep: 8,
    workerPath: SNAPSHOT_WORKER,
    workerExecArgv: EXEC_ARGV,
  })
  const before = await commitsSoFar()
  const result = await snapshotter.write()
  const during = (await commitsSoFar()) - before
  await writer.stop()
  await checkpointer.stop()

  // The writes really overlapped the copy.
  expect(during).toBeGreaterThan(0)

  expect(result.livePath).toBe(path.resolve(live))
  expect(result.snapshotPath).toBe(path.resolve(live) + DATABASE_SNAPSHOT_SUFFIX)
  // No work directory survives a finished snapshot.
  await expect(fs.stat(path.resolve(live) + DATABASE_SNAPSHOT_PARTIAL_SUFFIX)).rejects.toThrow()

  const snap = new Database(result.snapshotPath, { readonly: true })
  openDbs.push(snap)
  expect(snap.pragma('integrity_check', { simple: true })).toBe('ok')
  expect(snap.pragma('journal_mode', { simple: true })).toBe('delete')
  expect(scalar(snap, 'SELECT sum(balance) AS v FROM account')).toBe(ACCOUNTS * OPENING_BALANCE)
  expect(scalar(snap, 'SELECT count(*) AS v FROM ledger')).toBe(
    scalar(snap, 'SELECT count(*) AS v FROM audit'),
  )
  // The reported tables are the snapshot's content, not an estimate.
  for (const table of result.tables) {
    expect(scalar(snap, `SELECT count(*) AS v FROM "${table.name}"`)).toBe(table.rows)
  }
  expect(result.tables.map((t) => t.name)).toEqual(['account', 'audit', 'ledger'])
  const stat = await fs.stat(result.snapshotPath)
  expect(result.sizeBytes).toBe(stat.size)
}

describe('SqliteSnapshotter — a consistent snapshot under concurrent writes', () => {
  it('another connection in the owning process writes the whole time', async () => {
    const { live } = await seededDatabase()
    const writer = startInProcessWriter(live)
    await snapshotWhileWriting(live, writer, async () => writer.commits())
  }, 60_000)

  it('a writer in another process writes the whole time', async () => {
    const { live } = await seededDatabase()
    const writer = await startChildWriter(live)
    // Let it get going before the snapshot starts.
    await new Promise((r) => setTimeout(r, 100))
    const live0 = new Database(live, { readonly: true })
    openDbs.push(live0)
    const commitsSoFar = async (): Promise<number> =>
      scalar(live0, 'SELECT max(id) AS v FROM ledger')
    await snapshotWhileWriting(live, writer, commitsSoFar)
  }, 60_000)

  it('refuses — and leaves no snapshot file — when the copy fails its checks', async () => {
    const { dir } = await seededDatabase()
    const missing = path.join(dir, 'not-there.db')
    const { logger, lines } = makeLogger()
    const snapshotter = new SqliteSnapshotter({
      livePath: missing,
      logger,
      workerPath: SNAPSHOT_WORKER,
      workerExecArgv: EXEC_ARGV,
    })
    await expect(snapshotter.write()).rejects.toThrow(/database snapshot refused \(failed\)/)
    await expect(fs.stat(missing + DATABASE_SNAPSHOT_SUFFIX)).rejects.toThrow()
    await expect(fs.stat(missing + DATABASE_SNAPSHOT_PARTIAL_SUFFIX)).rejects.toThrow()
    expect(lines.some((l) => l.level === 'warn' && l.message.includes('refused'))).toBe(true)
  }, 60_000)

  it('refuses `no-space` — before any copy — when the disk cannot take it and keep its reserve', async () => {
    const { live } = await seededDatabase()
    const { size } = await fs.stat(live)
    const { logger, lines } = makeLogger()
    const snapshotter = new SqliteSnapshotter({
      livePath: live,
      logger,
      workerPath: SNAPSHOT_WORKER,
      workerExecArgv: EXEC_ARGV,
      // One byte short of what the copy and the reserve need.
      statfs: async () => ({ bavail: snapshotSpaceNeeded(size, 0) - 1, bsize: 1 }),
    })
    await expect(snapshotter.write()).rejects.toThrow(/database snapshot refused \(no-space\)/)
    await expect(fs.stat(live + DATABASE_SNAPSHOT_PARTIAL_SUFFIX)).rejects.toThrow()
    await expect(fs.stat(live + DATABASE_SNAPSHOT_SUFFIX)).rejects.toThrow()
    expect(lines.some((l) => l.level === 'warn' && l.message.includes('refused'))).toBe(true)
  }, 60_000)

  it('refuses `no-space` when the free space cannot be measured — unknown is not zero, and not plenty', async () => {
    const { live } = await seededDatabase()
    const { logger } = makeLogger()
    const snapshotter = new SqliteSnapshotter({
      livePath: live,
      logger,
      workerPath: SNAPSHOT_WORKER,
      workerExecArgv: EXEC_ARGV,
      statfs: async () => {
        throw new Error('EIO: statfs failed')
      },
    })
    await expect(snapshotter.write()).rejects.toThrow(/no-space.*unknown.*EIO/)
  }, 60_000)

  it('refuses a stalled snapshot thread at its deadline and TERMINATES it — its heartbeat stops', async () => {
    const { dir, live } = await seededDatabase()
    const { logger, lines } = makeLogger()
    const snapshotter = new SqliteSnapshotter({
      livePath: live,
      logger,
      workerPath: STALLED_WORKER,
      deadlineMs: 300,
    })
    await expect(snapshotter.write()).rejects.toThrow(/failed.*timed out after 300 ms/)
    expect(lines.some((l) => l.level === 'warn' && l.message.includes('missed its deadline'))).toBe(
      true,
    )
    const heartbeat = path.join(dir, 'heartbeat')
    expect((await fs.stat(heartbeat)).size).toBeGreaterThan(0)
    // Terminated, not abandoned: the beat stops.
    await expect
      .poll(
        async () => {
          const before = (await fs.stat(heartbeat)).size
          await new Promise((r) => setTimeout(r, 150))
          return (await fs.stat(heartbeat)).size - before
        },
        { timeout: 3_000 },
      )
      .toBe(0)
    // And its work directory is gone once it is.
    await expect
      .poll(async () =>
        fs.stat(live + DATABASE_SNAPSHOT_PARTIAL_SUFFIX).then(
          () => true,
          () => false,
        ),
      )
      .toBe(false)
    // A fresh run, not the stalled one joined.
    await expect(snapshotter.write()).rejects.toThrow(/timed out after 300 ms/)
  }, 10_000)

  it('answers the deadline without waiting for a terminate that never settles — and refuses the next snapshot at once', async () => {
    const { live } = await seededDatabase()
    const { logger } = makeLogger()
    let terminated = 0
    const snapshotter = new SqliteSnapshotter({
      livePath: live,
      logger,
      deadlineMs: 100,
      // A thread stuck in a native call: terminate() never comes back.
      spawnWorker: () => ({
        onMessage: () => undefined,
        onError: () => undefined,
        onExit: () => undefined,
        terminate: () => {
          terminated++
          return new Promise<never>(() => undefined)
        },
      }),
    })
    await expect(snapshotter.write()).rejects.toThrow(/timed out after 100 ms/)
    expect(terminated).toBe(1)
    const started = Date.now()
    await expect(snapshotter.write()).rejects.toThrow(
      /previous snapshot thread is still terminating/,
    )
    expect(Date.now() - started).toBeLessThan(100)
    expect(terminated).toBe(1)
  }, 10_000)

  it('a failed directory fsync is a WARN — the verified snapshot still stands', async () => {
    const { live } = await seededDatabase()
    const { logger, lines } = makeLogger()
    const snapshotter = new SqliteSnapshotter({
      livePath: live,
      logger,
      workerPath: SNAPSHOT_WORKER,
      workerExecArgv: EXEC_ARGV,
      syncDirectory: async () => {
        throw new Error('EINVAL: fsync on a directory')
      },
    })
    const result = await snapshotter.write()
    expect((await fs.stat(result.snapshotPath)).size).toBe(result.sizeBytes)
    expect(lines.some((l) => l.level === 'warn' && l.message.includes('fsync failed'))).toBe(true)
  }, 60_000)

  it('removes a snapshot nobody collected — at boot, and before the next snapshot', async () => {
    const { live } = await seededDatabase()
    const { logger, lines } = makeLogger()
    const orphan = live + DATABASE_SNAPSHOT_SUFFIX
    await fs.writeFile(orphan, 'a copy whose caller timed out')
    const snapshotter = new SqliteSnapshotter({
      livePath: live,
      logger,
      workerPath: STALLED_WORKER,
      deadlineMs: 200,
    })
    await snapshotter.sweep()
    await expect(fs.stat(orphan)).rejects.toThrow()
    expect(lines.some((l) => l.message.includes('nobody collected it'))).toBe(true)

    await fs.writeFile(orphan, 'another one')
    await expect(snapshotter.write()).rejects.toThrow(/timed out/)
    await expect(fs.stat(orphan)).rejects.toThrow()
  }, 10_000)
})
