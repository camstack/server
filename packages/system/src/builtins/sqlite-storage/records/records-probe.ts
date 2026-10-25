/**
 * The index-served proof of a record kind (D881, D447), run on the statements
 * the engine REALLY prepares.
 *
 * A kind is declared with its indexes; this builds an in-memory engine, declares
 * the kind, runs every operation the kind's declaration promises (by device and
 * time, by id, by each declared index at each prefix length, the counts, the
 * histogram, the aggregates over indexed fields, the bounded deletes) with a
 * spy on `prepare`, and then EXPLAINs each captured statement:
 *
 *  - no plan may be a table SCAN, and none may sort (`TEMP B-TREE FOR ORDER BY`);
 *  - every statement names `kind_id` as a literal (the partial indexes need it);
 *  - a count and an aggregate must not read the table row - checked on the
 *    opcodes, because `EXPLAIN QUERY PLAN` says `USING INDEX` either way.
 *
 * It is what `scripts/check-records-index-served.ts` runs over every declared
 * kind, and what its spec runs over a deliberately broken one.
 */
import Database from 'better-sqlite3'
import type { DefinedRecordKind, IScopedLogger, RecordKindDeclaration } from '@camstack/types'
import { planOf, tableColumnReads } from './records-explain.js'
import { RecordsEngine } from './records-engine.js'

export interface ProbeProblem {
  readonly kind: string
  readonly op: string
  readonly problem: string
}

export interface Captured {
  readonly sql: string
  readonly params: readonly unknown[]
}

const OWNER = 'probe'

function silent(): IScopedLogger {
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

function spyOnPrepare(db: Database.Database): Captured[] {
  const captured: Captured[] = []
  const real = db.prepare.bind(db)
  Object.defineProperty(db, 'prepare', {
    value: (sql: string) => {
      const stmt = real(sql)
      for (const method of ['all', 'get', 'run'] as const) {
        const original = stmt[method].bind(stmt)
        Object.defineProperty(stmt, method, {
          value: (...params: unknown[]) => {
            captured.push({ sql, params })
            return original(...params)
          },
        })
      }
      return stmt
    },
  })
  return captured
}

interface ProbeOp {
  readonly label: string
  readonly run: (engine: RecordsEngine, kind: string) => Promise<unknown>
}

function operationsOf(decl: RecordKindDeclaration): readonly ProbeOp[] {
  const ops: ProbeOp[] = []
  const hasDevice = decl.device !== 'none'
  const hasAt = decl.at === 'required'
  const base = (kind: string) => ({ owner: OWNER, kind })

  ops.push({ label: 'query by id', run: (e, k) => e.query({ ...base(k), order: 'id', limit: 2 }) })
  ops.push({ label: 'get', run: (e, k) => e.get({ ...base(k), id: 'x' }) })
  if (hasAt) {
    ops.push({ label: 'query by time', run: (e, k) => e.query({ ...base(k), limit: 2 }) })
    ops.push({
      label: 'query by time desc',
      run: (e, k) => e.query({ ...base(k), desc: true, limit: 2 }),
    })
    ops.push({
      label: 'count in window',
      run: (e, k) => e.count({ ...base(k), atFrom: 0, atTo: 10 }),
    })
    ops.push({
      label: 'histogram',
      run: (e, k) => e.histogram({ ...base(k), from: 0, to: 100, bucketMs: 10 }),
    })
    ops.push({
      label: 'deleteWhere atBefore',
      run: (e, k) => e.deleteWhere({ ...base(k), atBefore: 5 }),
    })
  }
  if (hasDevice) {
    ops.push({ label: 'count by device', run: (e, k) => e.count({ ...base(k), deviceId: 1 }) })
    ops.push({
      label: 'deleteWhere device',
      run: (e, k) => e.deleteWhere({ ...base(k), deviceId: 1 }),
    })
  }
  if (hasDevice && hasAt) {
    ops.push({
      label: 'query device+time',
      run: (e, k) => e.query({ ...base(k), deviceId: 1, limit: 2 }),
    })
    ops.push({
      label: 'count device+window',
      run: (e, k) => e.count({ ...base(k), deviceId: 1, atFrom: 0, atTo: 10 }),
    })
    ops.push({
      label: 'histogram device',
      run: (e, k) => e.histogram({ ...base(k), deviceId: 1, from: 0, to: 100, bucketMs: 10 }),
    })
  }
  for (const index of decl.indexes) {
    const fields = index.fields
    for (let k = 1; k <= fields.length; k += 1) {
      const where = Object.fromEntries(fields.slice(0, k).map((f) => [f, 'x']))
      const tag = `index ${index.name} prefix ${k}`
      ops.push({ label: `query ${tag}`, run: (e, kn) => e.query({ ...base(kn), where, limit: 2 }) })
      ops.push({ label: `count ${tag}`, run: (e, kn) => e.count({ ...base(kn), where }) })
      ops.push({
        label: `deleteWhere ${tag}`,
        run: (e, kn) => e.deleteWhere({ ...base(kn), where }),
      })
    }
    const first = fields[0]
    const last = fields.at(-1)
    if (first !== undefined) {
      ops.push({
        label: `aggregate count by ${index.name}`,
        run: (e, kn) => e.aggregate({ ...base(kn), op: 'count', groupBy: first }),
      })
    }
    if (first !== undefined && last !== undefined && fields.length >= 2) {
      ops.push({
        label: `aggregate sum by ${index.name}`,
        run: (e, kn) => e.aggregate({ ...base(kn), op: 'sum', field: last, groupBy: first }),
      })
      ops.push({
        label: `aggregate max under ${index.name}`,
        run: (e, kn) =>
          e.aggregate({ ...base(kn), op: 'max', field: last, where: { [first]: 'x' } }),
      })
    }
  }
  return ops
}

/** Judge one prepared statement. Exported so a spec can plant a bad one and watch it fail. */
export function judgeStatement(
  db: Database.Database,
  kind: string,
  op: string,
  statement: Captured,
): readonly ProbeProblem[] {
  const problems: ProbeProblem[] = []
  const flag = (problem: string): void => {
    problems.push({ kind, op, problem: `${problem} :: ${statement.sql.slice(0, 160)}` })
  }
  if (!/\bkind_id = \d+/.test(statement.sql)) flag('kind_id is not a literal')
  const plan = planOf(db, statement)
  if (plan.some((line) => /^SCAN records(?! USING)/.test(line)))
    flag(`scans the table (${plan.join(' | ')})`)
  if (plan.some((line) => line.includes('TEMP B-TREE FOR ORDER BY'))) flag('sorts in a temp b-tree')
  const histogram = /AS b, COUNT\(\*\) AS c/.test(statement.sql)
  if (!histogram && plan.some((line) => line.includes('TEMP B-TREE FOR GROUP BY'))) {
    flag('groups in a temp b-tree')
  }
  const readsOnly = statement.sql.startsWith('SELECT COUNT(*) AS n') || /AS g, /.test(statement.sql)
  if (readsOnly && tableColumnReads(db, statement) > 0)
    flag('reads the table row (not served from the index alone)')
  return problems
}

/** Probe one kind. An empty answer means every promised operation is served from an index. */
export async function probeKind(def: DefinedRecordKind): Promise<readonly ProbeProblem[]> {
  const db = new Database(':memory:')
  try {
    const captured = spyOnPrepare(db)
    const engine = new RecordsEngine(db, { databaseId: def.declaration.database, logger: silent() })
    await engine.declareKinds({ owner: OWNER, kinds: { [def.name]: def.declaration } })
    const problems: ProbeProblem[] = []
    for (const op of operationsOf(def.declaration)) {
      const from = captured.length
      try {
        await op.run(engine, def.name)
      } catch (err: unknown) {
        problems.push({
          kind: def.name,
          op: op.label,
          problem: `the engine refused or failed: ${err instanceof Error ? err.message : String(err)}`,
        })
        continue
      }
      for (const statement of captured.slice(from)) {
        if (!/\bFROM records\b/.test(statement.sql)) continue
        if (statement.sql.includes('sqlite_master')) continue
        problems.push(...judgeStatement(db, def.name, op.label, statement))
      }
    }
    return problems
  } finally {
    db.close()
  }
}
