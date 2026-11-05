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
import {
  clearLegacyIntegrationRows,
  deleteLegacyIntegrationRowKeys,
  legacyIntegrationAddonId,
  patchLegacyIntegrationRows,
  readLegacyIntegrationRows,
} from './legacy-integration-rows-door.js'
import type { MigrationDatabase } from './migration-types.js'

/**
 * The settings connection and the runner lookup the legacy-row methods need.
 * Absent in specs that never call them.
 */
export interface LegacyIntegrationRowsDoor {
  readonly database: () => MigrationDatabase | null
  readonly runnerIdOf: (owner: string) => string
}

/**
 * The addon the transport stamped on the call (`callerAddonId`, never in an input
 * schema, stripped from an HTTP/WS request); `null` for an unstamped call.
 */
function callerOf(input: object): string | null {
  const raw: unknown = Reflect.get(input, 'callerAddonId')
  return typeof raw === 'string' && raw.length > 0 ? raw : null
}

export class MigrationsProvider implements IMigrationsProvider {
  constructor(
    private readonly engine: MigrationEngine,
    private readonly legacyRows: LegacyIntegrationRowsDoor | null = null,
  ) {}

  private settingsDatabase(): MigrationDatabase {
    const db = this.legacyRows?.database() ?? null
    if (db === null) {
      throw new Error('legacy integration rows: the settings database is not open')
    }
    return db
  }

  /**
   * The integration's own addon, or the runner that hosts it. An integration
   * that is already gone has nothing to refuse.
   */
  private assertLegacyCaller(integrationId: string, caller: string | null): MigrationDatabase {
    const db = this.settingsDatabase()
    const owner = legacyIntegrationAddonId(db, integrationId)
    if (owner === null) return db
    const runner = this.legacyRows?.runnerIdOf(owner) ?? owner
    if (caller === null || (caller !== owner && caller !== runner)) {
      throw new Error(
        `legacy integration rows of "${integrationId}" are migration-only — caller "${caller ?? ''}" is not "${owner}"`,
      )
    }
    return db
  }

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
      .declareOwner(input.owner, input.metas, callerOf(input))
      .then((out) => ({ ...out, steps: [...out.steps] }))
  }

  startMigration(input: { id: string }): Promise<{
    proceed: boolean
    state: MigrationStatus | 'pending'
    reason: string | null
  }> {
    return this.engine.startMigration(input.id, callerOf(input))
  }

  finishMigration(input: { id: string; result: MigrationOwnerResult }): Promise<{
    status: MigrationStatus
    error: string | null
    rowsChanged: number
  }> {
    return this.engine.finishMigration(input.id, input.result, callerOf(input))
  }

  async restorePreMigration(input: {
    database: DataStoreDatabase
    snapshotId: string
  }): Promise<{ scheduled: boolean; held: string[]; restartRequired: boolean }> {
    const { held } = await this.engine.restorePreMigration(input.database, input.snapshotId)
    return { scheduled: true, held: [...held], restartRequired: true }
  }

  readLegacyIntegrationRows(input: { integrationId: string }): Promise<Record<string, unknown>> {
    const db = this.assertLegacyCaller(input.integrationId, callerOf(input))
    return Promise.resolve({ ...readLegacyIntegrationRows(db, input.integrationId) })
  }

  clearLegacyIntegrationRows(input: {
    integrationId: string
  }): Promise<{ rows: number; secrets: number }> {
    const db = this.assertLegacyCaller(input.integrationId, callerOf(input))
    return Promise.resolve(clearLegacyIntegrationRows(db, input.integrationId))
  }

  patchLegacyIntegrationRows(input: {
    integrationId: string
    patch: Record<string, unknown>
  }): Promise<{ written: boolean }> {
    const db = this.assertLegacyCaller(input.integrationId, callerOf(input))
    return Promise.resolve(patchLegacyIntegrationRows(db, input.integrationId, input.patch))
  }

  deleteLegacyIntegrationRowKeys(input: {
    integrationId: string
    keys: string[]
  }): Promise<{ present: boolean; removed: Record<string, unknown> }> {
    const db = this.assertLegacyCaller(input.integrationId, callerOf(input))
    const deleted = deleteLegacyIntegrationRowKeys(db, input.integrationId, input.keys)
    return Promise.resolve({ present: deleted.present, removed: { ...deleted.removed } })
  }
}
