/**
 * Data → Migrations: one row per migration the hub knows — the ledger (what
 * ran) joined with the pending list (what is catalogued and has not). The ledger
 * is the authority for a status; a catalogued id with no ledger row is `pending`.
 */
import type {
  MigrationLedgerEntry,
  MigrationMeta,
  MigrationPendingEntry,
  MigrationStatus,
} from '@camstack/types'

export type MigrationRowStatus = MigrationStatus | 'pending'

export interface MigrationRow {
  readonly id: string
  readonly owner: string
  readonly status: MigrationRowStatus
  /** Null when no catalogue lists the id (a newer database). */
  readonly meta: MigrationMeta | null
  readonly ledger: MigrationLedgerEntry | null
  readonly pending: MigrationPendingEntry | null
  readonly database: string
  readonly seq: number
  readonly appliedAt: number | null
  readonly reason: string | null
  readonly error: string | null
}

/** Display order of the status facet and the sort rank: trouble first. */
export const MIGRATION_STATUS_ORDER: readonly MigrationRowStatus[] = [
  'failed',
  'blocked',
  'held',
  'running',
  'pending',
  'applied',
  'skipped-newer',
]

export function statusRank(status: MigrationRowStatus): number {
  return MIGRATION_STATUS_ORDER.indexOf(status)
}

export function joinMigrationRows(
  ledger: readonly MigrationLedgerEntry[],
  pending: readonly MigrationPendingEntry[],
): readonly MigrationRow[] {
  const pendingById = new Map(pending.map((p) => [p.meta.id, p]))
  const rows = new Map<string, MigrationRow>()
  for (const entry of ledger) {
    const p = pendingById.get(entry.id) ?? null
    rows.set(entry.id, {
      id: entry.id,
      owner: entry.owner,
      status: entry.status,
      meta: entry.meta ?? p?.meta ?? null,
      ledger: entry,
      pending: p,
      database: entry.database,
      seq: entry.seq,
      appliedAt: entry.appliedAt,
      reason: entry.reason ?? p?.reason ?? null,
      error: entry.error,
    })
  }
  for (const p of pending) {
    if (rows.has(p.meta.id)) continue
    rows.set(p.meta.id, {
      id: p.meta.id,
      owner: p.meta.owner,
      status: p.state === 'pending' ? 'pending' : p.state,
      meta: p.meta,
      ledger: null,
      pending: p,
      database: p.database,
      seq: p.meta.seq,
      appliedAt: null,
      reason: p.reason,
      error: null,
    })
  }
  return [...rows.values()]
}

/** A hub migration over a database file may be dry-run; an addon's body runs in its owner. */
export function canDryRun(row: MigrationRow): boolean {
  return row.owner === 'hub' && row.meta !== null && row.meta.bodyKind !== 'procedure'
}
