/**
 * The settings door these specs hand device-history: the REAL
 * `SqliteSettingsBackend` over a `history.db` in a temp dir, wrapped in the
 * tRPC-shaped namespace an addon reaches for (`x.query(input)` / `x.mutate(input)`).
 *
 * The engine owns the column semantics the store depends on (`INTEGER PRIMARY
 * KEY` as a rowid alias, WITHOUT ROWID composite keys, `ON CONFLICT` upserts),
 * so a hand-rolled fake would pass by accident. This repo has twice shipped a
 * green suite whose fake supplied the value production forgot to fetch.
 *
 * `database: 'history'` on a declaration is the PLACEMENT router's concern
 * (D851); here the whole file IS the history file, so the backend ignores it.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteSettingsBackend } from '@camstack/system'
import type { IScopedLogger } from '@camstack/types'
import type { HistoryDoor } from '../../store/history-door.js'

export interface RealDoor {
  readonly door: HistoryDoor
  readonly backend: SqliteSettingsBackend
  readonly dir: string
  readonly dbPath: string
  /** Every statement the engine prepared since {@link RealDoor.startSpying}. */
  readonly prepared: string[]
  startSpying(): void
  stopSpying(): void
  close(): Promise<void>
}

/** The documented test-only type boundary: the narrowed namespace the store reaches for. */
function toDoor(backend: SqliteSettingsBackend): HistoryDoor {
  const namespace = {
    declareCollection: { mutate: (i: never) => backend.declareCollection(i) },
    query: { query: (i: never) => backend.query(i) },
    insert: { mutate: (i: never) => backend.insert(i) },
    upsertMany: { mutate: (i: never) => backend.upsertMany(i) },
    transact: { mutate: (i: never) => backend.transact(i) },
    deleteWhere: { mutate: (i: never) => backend.deleteWhere(i) },
    update: { mutate: (i: never) => backend.update(i) },
    count: { query: (i: never) => backend.count(i) },
    delete: { mutate: (i: never) => backend.delete(i) },
  }
  return namespace as unknown as HistoryDoor
}

export async function openRealDoor(fileName = 'history.db'): Promise<RealDoor> {
  const dir = mkdtempSync(join(tmpdir(), 'camstack-device-history-'))
  const dbPath = join(dir, fileName)
  const backend = new SqliteSettingsBackend(dbPath)
  await backend.initialize()
  const prepared: string[] = []
  let restore: (() => void) | null = null
  return {
    door: toDoor(backend),
    backend,
    dir,
    dbPath,
    prepared,
    startSpying() {
      const db = backend.getDatabase()
      if (db === null) throw new Error('database not open')
      const real = db.prepare.bind(db)
      const original = db.prepare
      db.prepare = ((sql: string) => {
        prepared.push(sql)
        return real(sql)
      }) as typeof db.prepare
      restore = () => {
        db.prepare = original
      }
    },
    stopSpying() {
      restore?.()
      restore = null
    },
    async close() {
      restore?.()
      await backend.shutdown()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

export function silentLogger(): IScopedLogger {
  const noop = (): void => {}
  const logger: IScopedLogger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

export interface CapturedLog {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly meta: Record<string, unknown>
  readonly tags: Record<string, unknown>
}

/** A logger that keeps every line, for the specs that assert a drop is SAID (D391). */
export function recordingLogger(sink: CapturedLog[]): IScopedLogger {
  const at =
    (level: CapturedLog['level']) =>
    (message: string, ctx?: { meta?: Record<string, unknown>; tags?: Record<string, unknown> }) => {
      sink.push({ level, message, meta: ctx?.meta ?? {}, tags: ctx?.tags ?? {} })
    }
  const logger: IScopedLogger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}
