/**
 * The vocabulary of the boot-time migration engine (D987). Pure types: the
 * worker bundle imports this file, so it carries no driver and no kernel.
 */
import type {
  DataStoreDatabase,
  MigrationDryRunResult,
  MigrationLedgerEntry,
  MigrationMeta,
  MigrationPlan,
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

/** The owner of every migration that ships with the hub itself. */
export const HUB_OWNER = 'hub'

/** A hub-store `sql` migration: its identity plus the synchronous body that runs in its transaction. */
export interface HubSqlMigration {
  readonly meta: MigrationMeta
  /** May answer a note (what it dropped or copied by name): kept in the ledger and logged at info. */
  run(db: MigrationDatabase): MigrationNote | undefined
}

/** A `sql` body's account of what it did beyond a row count. */
export type MigrationNote = Readonly<Record<string, unknown>>

/**
 * A hub-store `plan` migration: the body READS through the connection and returns the
 * edits the engine applies, in the same transaction as the `applied` row. It must not
 * write — everything it changes is an edit the engine can count, check and roll back.
 */
export interface HubPlanMigration {
  readonly meta: MigrationMeta
  plan(db: MigrationDatabase): MigrationPlan
}

export type HubMigration = HubSqlMigration | HubPlanMigration

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
  /** The `sql` body's own note, when it left one. */
  readonly note?: MigrationNote
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
  /**
   * An ADDON-owned `plan` (M3): the owner computed `plan`; the file applies its edits and
   * writes the `applied` row in ONE transaction. A throwing edit rolls everything back
   * and is recorded `failed` by a separate statement.
   */
  readonly applyPlan: {
    readonly input: {
      readonly meta: MigrationMeta
      readonly plan: MigrationPlan
      readonly bootId: string
      readonly codeVersion: string
    }
    readonly output: {
      readonly status: 'applied' | 'failed'
      readonly rowsChanged: number
      readonly error: string | null
    }
  }
  /** Write the ledger row of an addon-owned migration whose body ran elsewhere (a `procedure`, a gate). */
  readonly record: {
    readonly input: {
      readonly meta: MigrationMeta
      readonly status: 'applied' | 'failed' | 'blocked' | 'held'
      readonly reason: string | null
      readonly error: string | null
      readonly summary: Readonly<Record<string, unknown>> | null
      readonly bootId: string
      readonly codeVersion: string
    }
    readonly output: MigrationLedgerEntry
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
  'applyPlan',
  'record',
]

export function isMigrateOp(op: string): op is MigrateOp {
  return MIGRATE_OPS.some((known) => known === op)
}

/** The hub-store migrations a file serves, by the store each names. */
export function databaseOfStore(store: MigrationMeta['store']): DataStoreDatabase | null {
  return store === 'settings' || store === 'events' || store === 'history' ? store : null
}
