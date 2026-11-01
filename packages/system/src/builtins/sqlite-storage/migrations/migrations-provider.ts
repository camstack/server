/**
 * The `migrations` provider (D987): a thin face over the {@link MigrationEngine}.
 * The engine is the authority; this only shapes its answers to the cap.
 */
import type {
  IMigrationsProvider,
  MigrationDryRunResult,
  MigrationLedgerEntry,
  MigrationMeta,
  MigrationOwnerResult,
  MigrationOwnerStep,
  MigrationPendingEntry,
  MigrationStatus,
  DataStoreDatabase,
} from '@camstack/types'
import type { MigrationEngine } from './migration-engine.js'

export class MigrationsProvider implements IMigrationsProvider {
  constructor(private readonly engine: MigrationEngine) {}

  async listLedger(): Promise<{ entries: MigrationLedgerEntry[] }> {
    return { entries: [...(await this.engine.listLedger())] }
  }

  async listPending(input: { owner?: string }): Promise<{ pending: MigrationPendingEntry[] }> {
    return { pending: [...(await this.engine.listPending(input.owner))] }
  }

  dryRun(input: { id: string }): Promise<MigrationDryRunResult> {
    return this.engine.dryRun(input.id)
  }

  markFailed(input: { id: string; error: string }): Promise<MigrationLedgerEntry> {
    return this.engine.markFailed(input.id, input.error)
  }

  async retry(input: { id: string }): Promise<{ entries: MigrationLedgerEntry[] }> {
    return { entries: [...(await this.engine.retry(input.id))] }
  }

  declareOwner(input: { owner: string; metas: MigrationMeta[] }): Promise<{
    bootId: string
    snapshot: 'none' | 'written' | 'refused'
    steps: MigrationOwnerStep[]
  }> {
    return this.engine
      .declareOwner(input.owner, input.metas)
      .then((out) => ({ ...out, steps: [...out.steps] }))
  }

  startMigration(input: { id: string }): Promise<{
    proceed: boolean
    state: MigrationStatus | 'pending'
    reason: string | null
  }> {
    return this.engine.startMigration(input.id)
  }

  finishMigration(input: { id: string; result: MigrationOwnerResult }): Promise<{
    status: MigrationStatus
    error: string | null
    rowsChanged: number
  }> {
    return this.engine.finishMigration(input.id, input.result)
  }

  async restorePreMigration(input: {
    database: DataStoreDatabase
    snapshotId: string
  }): Promise<{ scheduled: boolean; held: string[]; restartRequired: boolean }> {
    const { held } = await this.engine.restorePreMigration(input.database, input.snapshotId)
    return { scheduled: true, held: [...held], restartRequired: true }
  }
}
