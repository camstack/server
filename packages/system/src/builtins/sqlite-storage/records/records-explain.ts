/**
 * Reading a SQLite plan for the D447 proof (D881).
 *
 * `EXPLAIN QUERY PLAN` prints `USING INDEX` whether or not the table row is
 * read behind that index entry, so it cannot prove an aggregate is served from
 * the index alone. The VDBE program can: a statement that never reads the
 * table has no `Column` opcode on the table's cursor. Both readers live here
 * because the specs and the `check-records-index-served` guard must agree.
 */
import type Database from 'better-sqlite3'

export interface ExplainedStatement {
  readonly sql: string
  readonly params: readonly unknown[]
}

interface PlanRow {
  readonly detail: string
}

interface OpRow {
  readonly opcode: string
  readonly p1: number
  readonly p2: number
}

/** The `EXPLAIN QUERY PLAN` detail lines of a statement. */
export function planOf(db: Database.Database, s: ExplainedStatement): readonly string[] {
  return db
    .prepare<unknown[], PlanRow>(`EXPLAIN QUERY PLAN ${s.sql}`)
    .all(...s.params)
    .map((r) => r.detail)
}

/** How many `Column` opcodes read the `records` TABLE (not an index) in this statement. */
export function tableColumnReads(db: Database.Database, s: ExplainedStatement): number {
  const root = db
    .prepare<[], { rootpage: number }>("SELECT rootpage FROM sqlite_master WHERE name = 'records'")
    .get()?.rootpage
  const program = db.prepare<unknown[], OpRow>(`EXPLAIN ${s.sql}`).all(...s.params)
  const tableCursors = new Set(
    program.filter((op) => op.opcode === 'OpenRead' && op.p2 === root).map((op) => op.p1),
  )
  return program.filter((op) => op.opcode === 'Column' && tableCursors.has(op.p1)).length
}
