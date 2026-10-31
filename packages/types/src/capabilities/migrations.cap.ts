import { z } from 'zod'
import {
  MigrationDryRunResultSchema,
  MigrationLedgerEntrySchema,
  MigrationPendingEntrySchema,
} from '../migrations/migration.js'
import { DataStoreDatabaseSchema } from './settings-store.cap.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'

/**
 * migrations — the ledger and the controls of the boot-time migration engine
 * (D986). Hub-only and internal: `sqlite-settings` is the registrant, because the
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
  },
} as const satisfies CapabilityDefinition

export type IMigrationsProvider = InferProvider<typeof migrationsCapability>
