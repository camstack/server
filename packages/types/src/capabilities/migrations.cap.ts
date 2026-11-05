import { z } from 'zod'
import { MigrationApiInfoSchema } from '../migrations/api/migration-api.v1.schema.js'
import {
  MigrationDryRunResultSchema,
  MigrationLedgerEntrySchema,
  MigrationMetaSchema,
  MigrationOwnerResultSchema,
  MigrationOwnerStepSchema,
  MigrationPendingEntrySchema,
  MigrationStatusSchema,
} from '../migrations/migration.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'
import { DataStoreDatabaseSchema } from './settings-store.cap.js'

/**
 * migrations — the ledger and the controls of the boot-time migration engine
 * (D987). Hub-only and internal: `sqlite-settings` is the registrant, because the
 * ledger lives INSIDE the database files it serves (`camstack.db`, `events.db`,
 * `history.db`) and only its connection or worker may touch them (D679).
 *
 * The engine itself runs in the owner's `afterOpen`, before any provider is
 * returned; this cap is how the rest of the system READS what happened (the Alert
 * Center reconciler) and how an operator acts on it (retry, restore the
 * pre-migration snapshot). Every method is `admin`: `internal` does not gate the
 * mount.
 */
export const migrationsCapability = {
  name: 'migrations',
  scope: 'system',
  mode: 'singleton',
  internal: true,
  methods: {
    /** Every ledger row of every owned database. The authority for "did it run". */
    listLedger: method(z.object({}), z.object({ entries: z.array(MigrationLedgerEntrySchema) }), {
      auth: 'admin',
    }),
    /** The catalogued migrations that are not applied, with their state and reason. */
    listPending: method(
      z.object({ owner: z.string().optional() }),
      z.object({ pending: z.array(MigrationPendingEntrySchema) }),
      { auth: 'admin' },
    ),
    /**
     * Run ONE hub-store migration inside a transaction and roll it back: what it
     * would change, per table, and whether it throws. Writes nothing.
     */
    dryRun: method(z.object({ id: z.string().min(1) }), MigrationDryRunResultSchema, {
      auth: 'admin',
    }),
    /** Record a failure the engine could not see itself (a runner that gave up). */
    markFailed: method(
      z.object({ id: z.string().min(1), error: z.string().min(1) }),
      MigrationLedgerEntrySchema,
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Clear `failed`, `blocked` and `held` for this id and the ids it blocked, then
     * run the pending migrations again (a snapshot first). Returns the rows it touched.
     */
    retry: method(
      z.object({ id: z.string().min(1) }),
      z.object({ entries: z.array(MigrationLedgerEntrySchema) }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Schedule the restore of a pre-migration snapshot at the next restart and HOLD
     * the migrations it predates, so they do not simply run again.
     */
    restorePreMigration: method(
      z.object({ database: DataStoreDatabaseSchema, snapshotId: z.string().min(1) }),
      z.object({
        scheduled: z.boolean(),
        held: z.array(z.string()),
        restartRequired: z.boolean(),
      }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * An ADDON offers its catalogue at its own boot (D987 M3). The engine checks it
     * together with every other owner's, takes the pre-migration snapshot of each
     * file a pending migration touches, and answers the owner's steps in the order
     * the framework decides. A catalogue the engine refuses (a cycle, a foreign
     * owner, a body kind the owner cannot run) is refused whole and writes nothing.
     */
    declareOwner: method(
      z.object({ owner: z.string().min(1), metas: z.array(MigrationMetaSchema) }),
      z.object({
        bootId: z.string(),
        snapshot: z.enum(['none', 'written', 'refused']),
        steps: z.array(MigrationOwnerStepSchema),
        /** The migration API this engine serves (additive: a server that predates it omits it). */
        migrationApi: MigrationApiInfoSchema.optional(),
      }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * The gate before one owner migration runs: `proceed: false` when a
     * predecessor is not applied (the row is written `blocked`), the id is held, or
     * the snapshot was refused.
     */
    startMigration: method(
      z.object({ id: z.string().min(1) }),
      z.object({
        proceed: z.boolean(),
        state: z.union([z.literal('pending'), MigrationStatusSchema]),
        reason: z.string().nullable(),
      }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * The owner's result for one migration. A `plan` is applied by the engine in one
     * transaction with the `applied` row; a `procedure` outcome is recorded as it
     * is; a `failed` report is recorded and blocks the dependents.
     */
    finishMigration: method(
      z.object({ id: z.string().min(1), result: MigrationOwnerResultSchema }),
      z.object({
        status: MigrationStatusSchema,
        error: z.string().nullable(),
        rowsChanged: z.number().int().nonnegative(),
      }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Migration-only. The stored rows of one integration, markers included, on
     * the settings connection. Empty when the store is gone — a copy migration
     * on a node that already dropped it is a no-op. Deleted with the last copy
     * migration. Not a settings API.
     */
    readLegacyIntegrationRows: method(
      z.object({ integrationId: z.string().min(1) }),
      z.record(z.string(), z.unknown()),
      { auth: 'admin' },
    ),
    /**
     * Migration-only. Delete that integration's rows. The caller releases the
     * keychain values first. `secrets` is how many marker refs the rows held.
     * A missing store deletes nothing. Deleted with the last copy migration.
     */
    clearLegacyIntegrationRows: method(
      z.object({ integrationId: z.string().min(1) }),
      z.object({
        rows: z.number().int().nonnegative(),
        secrets: z.number().int().nonnegative(),
      }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Migration-only. Upsert the given keys and leave every other key as stored.
     * `written` is false when the store is gone. Deleted with the last copy migration.
     */
    patchLegacyIntegrationRows: method(
      z.object({
        integrationId: z.string().min(1),
        patch: z.record(z.string(), z.unknown()),
      }),
      z.object({ written: z.boolean() }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Migration-only. Remove the named keys. `present` is false when the store
     * is gone; `removed` is what those keys held (markers included). Deleted
     * with the last copy migration.
     */
    deleteLegacyIntegrationRowKeys: method(
      z.object({
        integrationId: z.string().min(1),
        keys: z.array(z.string().min(1)),
      }),
      z.object({
        present: z.boolean(),
        removed: z.record(z.string(), z.unknown()),
      }),
      { kind: 'mutation', auth: 'admin' },
    ),
  },
} as const satisfies CapabilityDefinition

export type IMigrationsProvider = InferProvider<typeof migrationsCapability>
