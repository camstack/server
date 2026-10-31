/**
 * The vocabulary of the boot-time migration engine (D987). Pure types: the
 * worker bundle imports this file, so it carries no driver and no kernel.
 */
import type {
  DataStoreDatabase,
  MigrationDryRunResult,
  MigrationLedgerEntry,
  MigrationMeta,
  MigrationStatus,
} from '@camstack/types'

/** The one prepared-statement surface a migration body may use. */
export interface MigrationStatement {
  run(...params: unknown[]): { readonly changes: number | bigint }
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
}

/**
 * What a `sql` body receives: the owner's connection, minus the right to open
 * a transaction (the framework holds the one that makes the body and its ledger
 * row atomic) or to close it.
 */
export interface MigrationDatabase {
  exec(sql: string): unknown
  prepare(sql: string): MigrationStatement
}

/** A hub-store migration: its identity plus the synchronous body that runs in its transaction. */
export interface HubMigration {
  readonly meta: MigrationMeta
  run(db: MigrationDatabase): void
}

/** Where a catalogued migration stands. `pending` has no ledger row yet. */
export type PassStatus = MigrationStatus | 'pending'

export type PassStatuses = Readonly<Record<string, PassStatus>>

/** The outcome of ONE migration in a pass, for the engine to log and surface. */
export interface PassOutcome {
  readonly id: string
  readonly owner: string
  readonly outcome: 'applied' | 'failed' | 'blocked' | 'held'
  readonly rowsChanged: number
  readonly error: string | null
  readonly reason: string | null
}

export interface PreparedPass {
  /** Every catalogued migration of this file, as the ledger has it now. */
  readonly statuses: PassStatuses
  /** The ids that would run, in order: not applied, not held. */
  readonly runnable: readonly string[]
  /** Applied ids the catalogue does not know (a newer database under older code). */
  readonly newer: readonly string[]
}

/** Why a file's migrations are refused before any runs. */
export type PassRefusal = 'snapshot-refused'

export interface ApplyPassInput {
  readonly bootId: string
  readonly codeVersion: string
  /** The statuses of other files' migrations, from the passes that ran before. */
  readonly external: PassStatuses
  /** Ids a restore of a pre-migration snapshot holds for this code version. */
  readonly held: readonly string[]
  readonly refusal: PassRefusal | null
  readonly refusalDetail: string | null
}

export interface AppliedPass {
  readonly statuses: PassStatuses
  readonly outcomes: readonly PassOutcome[]
}

/** The questions the engine puts to a file, answered where the connection lives. */
export interface MigrateOps {
  readonly prepare: {
    readonly input: { readonly external: PassStatuses; readonly held: readonly string[] }
    readonly output: PreparedPass
  }
  readonly apply: { readonly input: ApplyPassInput; readonly output: AppliedPass }
  readonly ledger: {
    readonly input: Record<string, never>
    readonly output: readonly MigrationLedgerEntry[]
  }
  readonly dryRun: {
    readonly input: { readonly id: string }
    readonly output: MigrationDryRunResult
  }
  readonly reset: {
    readonly input: { readonly ids: readonly string[] }
    readonly output: readonly string[]
  }
  readonly markFailed: {
    readonly input: { readonly id: string; readonly error: string; readonly bootId: string }
    readonly output: MigrationLedgerEntry | null
  }
}
export type MigrateOp = keyof MigrateOps
export type MigrateInput<K extends MigrateOp> = MigrateOps[K]['input']
export type MigrateOutput<K extends MigrateOp> = MigrateOps[K]['output']

export const MIGRATE_OPS: readonly MigrateOp[] = [
  'prepare',
  'apply',
  'ledger',
  'dryRun',
  'reset',
  'markFailed',
]

export function isMigrateOp(op: string): op is MigrateOp {
  return MIGRATE_OPS.some((known) => known === op)
}

/** The hub-store migrations a file serves, by the store each names. */
export function databaseOfStore(store: MigrationMeta['store']): DataStoreDatabase | null {
  return store === 'settings' || store === 'events' || store === 'history' ? store : null
}
