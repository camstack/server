/**
 * Test harness for the records engine over REAL SQLite (D881): an in-memory
 * file, a silent logger, and a statement spy that records the SQL and bound
 * parameters the engine REALLY prepared - so a plan is proved on the statement
 * production runs, never on a hand-spelled copy (D447).
 */
import Database from 'better-sqlite3'
import type { IScopedLogger, RecordKindDeclaration } from '@camstack/types'
import { RecordsEngine } from '../../records/records-engine.js'

export function silentLogger(lines: string[] = []): IScopedLogger {
  const note =
    (level: string) =>
    (message: string): void => {
      lines.push(`${level}: ${message}`)
    }
  const logger: IScopedLogger = {
    debug: note('debug'),
    info: note('info'),
    warn: note('warn'),
    error: note('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

export interface SpiedStatement {
  readonly sql: string
  readonly params: readonly unknown[]
}

export interface Harness {
  readonly db: Database.Database
  readonly engine: RecordsEngine
  readonly statements: SpiedStatement[]
  readonly clock: { now: number }
  readonly logLines: string[]
}

export function makeHarness(databaseId: 'settings' | 'events' = 'settings'): Harness {
  const db = new Database(':memory:')
  const statements: SpiedStatement[] = []
  const realPrepare = db.prepare.bind(db)
  const spy = (sql: string) => {
    const stmt = realPrepare(sql)
    const record = (params: readonly unknown[]): void => {
      statements.push({ sql, params })
    }
    for (const method of ['all', 'get', 'run'] as const) {
      const real = stmt[method].bind(stmt)
      Object.defineProperty(stmt, method, {
        value: (...params: unknown[]) => {
          record(params)
          return real(...params)
        },
      })
    }
    return stmt
  }
  Object.defineProperty(db, 'prepare', { value: spy })
  const clock = { now: 1_000_000 }
  const logLines: string[] = []
  const engine = new RecordsEngine(db, {
    databaseId,
    logger: silentLogger(logLines),
    now: () => clock.now,
  })
  return { db, engine, statements, clock, logLines }
}

/** A minimal valid declaration; override what the case is about. */
export function declaration(over: Partial<RecordKindDeclaration> = {}): RecordKindDeclaration {
  return {
    database: 'settings',
    class: 'ledger',
    writeTrigger: 'a spec writes it',
    device: 'required',
    at: 'required',
    indexes: [],
    retention: { none: 'spec' },
    deviceRemoval: 'none',
    maxDataBytes: 65_536,
    secretPaths: [],
    secretArrayKeys: {},
    ...over,
  }
}

export { planOf, tableColumnReads } from '../../records/records-explain.js'

/** The last statement the spy saw whose SQL contains `needle`. */
export function lastStatement(h: Harness, needle: string): SpiedStatement {
  const found = h.statements.toReversed().find((s) => s.sql.includes(needle))
  if (found === undefined) throw new Error(`no prepared statement contains "${needle}"`)
  return found
}
