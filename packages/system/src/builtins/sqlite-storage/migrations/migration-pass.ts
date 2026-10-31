/**
 * One file's share of a boot-time migration pass (D987), synchronous over the
 * connection that owns the file. The same functions run on the engine's main
 * thread (`camstack.db`) and inside the file-host worker (`events.db`,
 * `history.db`): the catalogue is imported statically on both sides, so no
 * code ever crosses `postMessage` — only ids and results do.
 *
 * ## What is atomic
 *
 * A migration's body and its `applied` ledger row commit in ONE
 * `db.transaction`. A body that throws rolls its data back; the failure is then
 * recorded by a SEPARATE statement, because the transaction that would have held
 * it is gone. Nothing here opens a transaction around the whole pass: the first
 * migration stays applied when the second fails.
 *
 * ## What is never written
 *
 * A ledger id this code does not know (a newer database under older code) is
 * reported `skipped-newer` by the READ and never touched by a write. A pass that
 * cannot read the ledger throws; it never treats an unreadable ledger as empty
 * (D49).
 */
import type Database from 'better-sqlite3'
import {
  type DataStoreDatabase,
  type MigrationDryRunResult,
  type MigrationLedgerEntry,
  MigrationLedgerEntrySchema,
  type MigrationMeta,
  type MigrationStatus,
  orderMigrations,
  errMsg,
} from '@camstack/types'
import {
  type AppliedPass,
  type ApplyPassInput,
  databaseOfStore,
  type HubMigration,
  type MigrateInput,
  type MigrateOp,
  type MigrateOutput,
  type PassOutcome,
  type PassStatus,
  type PreparedPass,
} from './migration-types.js'

export const LEDGER_TABLE = '_migrations'

const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
  id TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL,
  level TEXT NOT NULL,
  seq INTEGER NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  applied_at INTEGER,
  code_version TEXT,
  plan_summary TEXT,
  progress TEXT,
  error TEXT,
  reason TEXT,
  node_id TEXT,
  boot_id TEXT
)`

export function ensureLedger(db: Database.Database): void {
  db.exec(LEDGER_DDL)
}

interface LedgerRow {
  readonly id: string
  readonly owner: string
  readonly level: string
  readonly seq: number
  readonly status: string
  readonly attempts: number
  readonly applied_at: number | null
  readonly code_version: string | null
  readonly plan_summary: string | null
  readonly progress: string | null
  readonly error: string | null
  readonly reason: string | null
  readonly node_id: string | null
  readonly boot_id: string | null
}

function readRows(db: Database.Database): Map<string, LedgerRow> {
  const rows = db.prepare<[], LedgerRow>(`SELECT * FROM ${LEDGER_TABLE} ORDER BY owner, seq`).all()
  return new Map(rows.map((row) => [row.id, row]))
}

function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed))
      : null
  } catch {
    return null
  }
}

function entryOf(
  row: LedgerRow,
  databaseId: DataStoreDatabase,
  knownIds: ReadonlySet<string>,
): MigrationLedgerEntry {
  // A row this code does not know is REPORTED as skipped-newer; the row itself is never written.
  const status = !knownIds.has(row.id) && row.status === 'applied' ? 'skipped-newer' : row.status
  return MigrationLedgerEntrySchema.parse({
    id: row.id,
    database: databaseId,
    owner: row.owner,
    level: row.level,
    seq: row.seq,
    status,
    attempts: row.attempts,
    appliedAt: row.applied_at,
    codeVersion: row.code_version,
    planSummary: parseJsonObject(row.plan_summary),
    progress: parseJsonObject(row.progress),
    error: row.error,
    reason: row.reason,
    nodeId: row.node_id,
    bootId: row.boot_id,
  })
}

interface RowWrite {
  readonly status: MigrationStatus
  readonly attempts: number
  readonly appliedAt: number | null
  readonly codeVersion: string
  readonly planSummary: Record<string, unknown> | null
  readonly error: string | null
  readonly reason: string | null
  readonly bootId: string
}

function writeRow(db: Database.Database, meta: MigrationMeta, write: RowWrite): void {
  db.prepare(
    `INSERT INTO ${LEDGER_TABLE}
       (id, owner, level, seq, status, attempts, applied_at, code_version, plan_summary, error, reason, boot_id)
     VALUES (@id, @owner, @level, @seq, @status, @attempts, @appliedAt, @codeVersion, @planSummary, @error, @reason, @bootId)
     ON CONFLICT(id) DO UPDATE SET
       owner = excluded.owner, level = excluded.level, seq = excluded.seq,
       status = excluded.status, attempts = excluded.attempts, applied_at = excluded.applied_at,
       code_version = excluded.code_version, plan_summary = excluded.plan_summary,
       error = excluded.error, reason = excluded.reason, boot_id = excluded.boot_id`,
  ).run({
    id: meta.id,
    owner: meta.owner,
    level: meta.level,
    seq: meta.seq,
    status: write.status,
    attempts: write.attempts,
    appliedAt: write.appliedAt,
    codeVersion: write.codeVersion,
    planSummary: write.planSummary === null ? null : JSON.stringify(write.planSummary),
    error: write.error,
    reason: write.reason,
    bootId: write.bootId,
  })
}

function totalChanges(db: Database.Database): number {
  const row: unknown = db.prepare('SELECT total_changes() AS n').get()
  if (typeof row === 'object' && row !== null && 'n' in row && typeof row.n === 'number') {
    return row.n
  }
  throw new Error('total_changes() answered no number')
}

/** The catalogue entries this file serves. */
function ownEntries(
  catalogue: readonly HubMigration[],
  databaseId: DataStoreDatabase,
): readonly HubMigration[] {
  return catalogue.filter(
    (m) => m.meta.level === 'hub-store' && databaseOfStore(m.meta.store) === databaseId,
  )
}

/** Each migration's predecessors: its `dependsOn` and the previous `seq` of its owner. */
function predecessorsOf(
  catalogue: readonly HubMigration[],
): ReadonlyMap<string, readonly string[]> {
  const byOwner = new Map<string, HubMigration[]>()
  for (const m of catalogue) {
    const list = byOwner.get(m.meta.owner) ?? []
    list.push(m)
    byOwner.set(m.meta.owner, list)
  }
  const out = new Map<string, readonly string[]>()
  for (const list of byOwner.values()) {
    list.sort((a, b) => a.meta.seq - b.meta.seq)
    list.forEach((m, index) => {
      const previous = index > 0 ? list[index - 1] : undefined
      out.set(m.meta.id, [
        ...m.meta.dependsOn,
        ...(previous === undefined ? [] : [previous.meta.id]),
      ])
    })
  }
  return out
}

function orderedCatalogue(catalogue: readonly HubMigration[]): readonly HubMigration[] {
  const byId = new Map(catalogue.map((m) => [m.meta.id, m]))
  return orderMigrations(catalogue.map((m) => m.meta)).flatMap((meta) => {
    const m = byId.get(meta.id)
    return m === undefined ? [] : [m]
  })
}

export function prepareFile(
  db: Database.Database,
  databaseId: DataStoreDatabase,
  catalogue: readonly HubMigration[],
  input: MigrateInput<'prepare'>,
): PreparedPass {
  ensureLedger(db)
  const rows = readRows(db)
  const knownIds = new Set(catalogue.map((m) => m.meta.id))
  const own = orderedCatalogue(ownEntries(catalogue, databaseId))
  const statuses: Record<string, PassStatus> = {}
  const runnable: string[] = []
  for (const m of own) {
    const row = rows.get(m.meta.id)
    const held = input.held.includes(m.meta.id)
    const status: PassStatus = row === undefined ? 'pending' : statusAsPass(row.status)
    statuses[m.meta.id] = status
    if (status !== 'applied' && !held) runnable.push(m.meta.id)
  }
  const newer = [...rows.values()]
    .filter((row) => !knownIds.has(row.id) && row.status === 'applied')
    .map((row) => row.id)
  return { statuses, runnable, newer }
}

function statusAsPass(status: string): PassStatus {
  switch (status) {
    case 'applied':
    case 'failed':
    case 'blocked':
    case 'running':
    case 'held':
    case 'skipped-newer':
      return status
    default:
      return 'pending'
  }
}

export function applyFile(
  db: Database.Database,
  databaseId: DataStoreDatabase,
  catalogue: readonly HubMigration[],
  input: ApplyPassInput,
): AppliedPass {
  ensureLedger(db)
  const rows = readRows(db)
  const predecessors = predecessorsOf(catalogue)
  const known = new Map<string, PassStatus>(Object.entries(input.external))
  const own = orderedCatalogue(ownEntries(catalogue, databaseId))
  const outcomes: PassOutcome[] = []
  const now = Date.now()
  const common = { codeVersion: input.codeVersion, bootId: input.bootId, planSummary: null }
  for (const m of own) {
    const { meta } = m
    const row = rows.get(meta.id)
    const previousAttempts = row?.attempts ?? 0
    if (row?.status === 'applied') {
      known.set(meta.id, 'applied')
      continue
    }
    const outcomeOf = (
      outcome: PassOutcome['outcome'],
      status: MigrationStatus,
      reason: string | null,
      error: string | null,
      rowsChanged = 0,
    ): void => {
      known.set(meta.id, status)
      outcomes.push({ id: meta.id, owner: meta.owner, outcome, rowsChanged, error, reason })
    }
    if (input.held.includes(meta.id)) {
      writeRow(db, meta, {
        ...common,
        status: 'held',
        attempts: previousAttempts,
        appliedAt: null,
        error: null,
        reason: 'restored-pre-migration',
      })
      outcomeOf('held', 'held', 'restored-pre-migration', null)
      continue
    }
    const unmet = (predecessors.get(meta.id) ?? [])
      .map((id): [string, PassStatus] => [id, known.get(id) ?? 'pending'])
      .find(([, status]) => status !== 'applied')
    if (unmet !== undefined) {
      const reason = `dependency-${unmet[1] === 'pending' ? 'pending' : unmet[1]}:${unmet[0]}`
      writeRow(db, meta, {
        ...common,
        status: 'blocked',
        attempts: previousAttempts,
        appliedAt: null,
        error: null,
        reason,
      })
      outcomeOf('blocked', 'blocked', reason, null)
      continue
    }
    if (input.refusal !== null) {
      writeRow(db, meta, {
        ...common,
        status: 'blocked',
        attempts: previousAttempts,
        appliedAt: null,
        error: input.refusalDetail,
        reason: input.refusal,
      })
      outcomeOf('blocked', 'blocked', input.refusal, input.refusalDetail)
      continue
    }
    try {
      const rowsChanged = db.transaction((): number => {
        const before = totalChanges(db)
        m.run(db)
        const changed = totalChanges(db) - before
        writeRow(db, meta, {
          ...common,
          status: 'applied',
          attempts: previousAttempts + 1,
          appliedAt: now,
          planSummary: { rowsChanged: changed },
          error: null,
          reason: null,
        })
        return changed
      })()
      outcomeOf('applied', 'applied', null, null, rowsChanged)
    } catch (err) {
      const error = errMsg(err)
      try {
        writeRow(db, meta, {
          ...common,
          status: 'failed',
          attempts: previousAttempts + 1,
          appliedAt: null,
          error,
          reason: null,
        })
      } catch (recordErr) {
        outcomeOf(
          'failed',
          'failed',
          null,
          `${error} (and the failure could not be recorded: ${errMsg(recordErr)})`,
        )
        continue
      }
      outcomeOf('failed', 'failed', null, error)
    }
  }
  const statuses: Record<string, PassStatus> = {}
  for (const m of own) statuses[m.meta.id] = known.get(m.meta.id) ?? 'pending'
  return { statuses, outcomes }
}

export function ledgerOf(
  db: Database.Database,
  databaseId: DataStoreDatabase,
  catalogue: readonly HubMigration[],
): readonly MigrationLedgerEntry[] {
  ensureLedger(db)
  const knownIds = new Set(catalogue.map((m) => m.meta.id))
  return [...readRows(db).values()].map((row) => entryOf(row, databaseId, knownIds))
}

/** Thrown to roll a dry run back; carries what it measured. */
class DryRunRollback extends Error {
  constructor(readonly result: MigrationDryRunResult) {
    super('dry run rolled back')
  }
}

function tableCounts(db: Database.Database): Map<string, number> {
  const names = db
    .prepare<[], { name: string; sql: string | null }>(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_migrations' ORDER BY name",
    )
    .all()
  const counts = new Map<string, number>()
  for (const { name, sql } of names) {
    if (sql !== null && sql.toUpperCase().startsWith('CREATE VIRTUAL')) continue
    const row: unknown = db
      .prepare(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`)
      .get()
    if (typeof row === 'object' && row !== null && 'n' in row && typeof row.n === 'number') {
      counts.set(name, row.n)
    }
  }
  return counts
}

export function dryRunOf(
  db: Database.Database,
  databaseId: DataStoreDatabase,
  catalogue: readonly HubMigration[],
  id: string,
): MigrationDryRunResult {
  const m = ownEntries(catalogue, databaseId).find((candidate) => candidate.meta.id === id)
  if (m === undefined) throw new Error(`migration ${id} is not a ${databaseId} migration`)
  const empty: MigrationDryRunResult = { id, ok: true, error: null, rowsChanged: 0, tables: [] }
  try {
    db.transaction(() => {
      const before = tableCounts(db)
      const changesBefore = totalChanges(db)
      m.run(db)
      const rowsChanged = totalChanges(db) - changesBefore
      const after = tableCounts(db)
      const tables = [...new Set([...before.keys(), ...after.keys()])]
        .sort()
        .map((table) => ({ table, before: before.get(table) ?? 0, after: after.get(table) ?? 0 }))
        .filter((t) => t.before !== t.after)
      throw new DryRunRollback({ ...empty, rowsChanged, tables })
    })()
  } catch (err) {
    if (err instanceof DryRunRollback) return err.result
    return { ...empty, ok: false, error: errMsg(err) }
  }
  return empty
}

/** Delete the rows of `ids` that are `failed`, `blocked` or `held`; an applied row is never reset. */
export function resetRows(db: Database.Database, ids: readonly string[]): readonly string[] {
  ensureLedger(db)
  const reset: string[] = []
  const select = db.prepare<[string], { id: string }>(
    `SELECT id FROM ${LEDGER_TABLE} WHERE id = ? AND status IN ('failed', 'blocked', 'held')`,
  )
  const remove = db.prepare(`DELETE FROM ${LEDGER_TABLE} WHERE id = ?`)
  db.transaction(() => {
    for (const id of ids) {
      if (select.get(id) === undefined) continue
      remove.run(id)
      reset.push(id)
    }
  })()
  return reset
}

export function markFailedRow(
  db: Database.Database,
  databaseId: DataStoreDatabase,
  catalogue: readonly HubMigration[],
  input: MigrateInput<'markFailed'>,
): MigrationLedgerEntry | null {
  const m = ownEntries(catalogue, databaseId).find((candidate) => candidate.meta.id === input.id)
  if (m === undefined) return null
  ensureLedger(db)
  const previous = readRows(db).get(input.id)
  writeRow(db, m.meta, {
    status: 'failed',
    attempts: (previous?.attempts ?? 0) + 1,
    appliedAt: null,
    codeVersion: previous?.code_version ?? '',
    planSummary: null,
    error: input.error,
    reason: null,
    bootId: input.bootId,
  })
  const row = readRows(db).get(input.id)
  return row === undefined
    ? null
    : entryOf(row, databaseId, new Set(catalogue.map((c) => c.meta.id)))
}

/** What one file answers: every op, bound to its connection and catalogue. */
export type MigrateTarget = {
  readonly [K in MigrateOp]: (input: MigrateInput<K>) => MigrateOutput<K>
}

export function migrateTargetOf(
  db: Database.Database,
  databaseId: DataStoreDatabase,
  catalogue: readonly HubMigration[],
): MigrateTarget {
  return {
    prepare: (input) => prepareFile(db, databaseId, catalogue, input),
    apply: (input) => applyFile(db, databaseId, catalogue, input),
    ledger: () => ledgerOf(db, databaseId, catalogue),
    dryRun: (input) => dryRunOf(db, databaseId, catalogue, input.id),
    reset: (input) => resetRows(db, input.ids),
    markFailed: (input) => markFailedRow(db, databaseId, catalogue, input),
  }
}

/** The one dispatch both the main thread and the worker use. */
export function callMigrate<K extends MigrateOp>(
  target: MigrateTarget,
  op: K,
  input: MigrateInput<K>,
): MigrateOutput<K> {
  return target[op](input)
}
