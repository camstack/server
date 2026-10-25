import { z } from 'zod'
import {
  StorageCleanupInputSchema,
  StorageCleanupJobSchema,
  StorageCleanupStatusInputSchema,
  StorageMigrationDrainInputSchema,
  StorageMigrationInputSchema,
  StorageMigrationJobSchema,
  StorageMigrationMoverSchema,
  StorageMigrationPlanSchema,
  StorageMigrationResidueSchema,
} from '../interfaces/relocate.js'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

/**
 * The single operator-facing storage migration surface. It coordinates the
 * pipeline, recorder and post-analysis participants; callers never mutate a
 * camera recording config or invoke an individual mover directly.
 */
export const storageMigrationCapability = {
  name: 'storage-migration',
  scope: 'system',
  mode: 'singleton',
  methods: {
    plan: method(StorageMigrationInputSchema, StorageMigrationPlanSchema, { auth: 'admin' }),
    start: method(StorageMigrationInputSchema, z.object({ jobId: z.string() }), {
      kind: 'mutation',
      auth: 'admin',
    }),
    status: method(
      z.object({ jobId: z.string().optional() }),
      StorageMigrationJobSchema.nullable(),
      {
        auth: 'admin',
      },
    ),
    cancel: method(z.object({ jobId: z.string() }), z.object({ cancelled: z.boolean() }), {
      kind: 'mutation',
      auth: 'admin',
    }),
    /**
     * Every mover running RIGHT NOW, in both lanes, with its counters.
     *
     * `status` covers a migration's own moves — the coordinator folds their
     * progress onto the durable job record it is already polling. This covers
     * the other case, and it is not hypothetical: a drain armed straight against
     * `recording.relocateFootage` (the only path that existed before
     * {@link drain}) has no job to fold into and would otherwise be invisible.
     */
    movers: method(z.object({}), z.array(StorageMigrationMoverSchema).readonly(), {
      auth: 'admin',
    }),
    /**
     * May a mover that touches these locations run NOW? One claim per physical
     * root is owned by the storage orchestrator: a single-location repoint holds
     * it while it carries its subtree, and a mover (`relocateMedia`,
     * `relocateFootage`, a migration move) asks here AFTER registering its job and
     * cancels itself on `clear: false`. The repoint, in turn, refuses while a
     * registered mover touches its root. Asked, never polled (D3).
     */
    moverClearance: method(
      z.object({ locationIds: z.array(z.string()).readonly() }),
      z.object({ clear: z.boolean(), repointLocationId: z.string().optional() }),
      { auth: 'admin' },
    ),
    /**
     * What each class's SOURCE still holds, from the archive — never from the
     * resident index (D295). Only classes with something left (or something
     * unknown) are listed, so an empty list means there is nothing to drain and
     * the UI has no honest button to offer.
     */
    residue: method(z.object({}), z.array(StorageMigrationResidueSchema).readonly(), {
      auth: 'admin',
    }),
    /**
     * Run the drain half alone, on a class whose default has ALREADY moved.
     *
     * It never repoints anything, which is what lets `start` keep refusing a
     * destination that is already the default: the two verbs cannot be confused
     * for one another, and no operator can re-repoint a migrated class through
     * this door.
     */
    drain: method(StorageMigrationDrainInputSchema, z.object({ jobId: z.string() }), {
      kind: 'mutation',
      auth: 'admin',
    }),
    /**
     * One operator cleanup of leftover analytics (DB + blobs) and ghost
     * ledger rows on frozen footage locations. Optional debug-media sweep.
     * Returns immediately; poll {@link cleanupStatus}.
     */
    cleanupStart: method(StorageCleanupInputSchema, z.object({ jobId: z.string() }), {
      kind: 'mutation',
      auth: 'admin',
    }),
    cleanupStatus: method(StorageCleanupStatusInputSchema, StorageCleanupJobSchema.nullable(), {
      auth: 'admin',
    }),
    cleanupCancel: method(z.object({ jobId: z.string() }), z.object({ cancelled: z.boolean() }), {
      kind: 'mutation',
      auth: 'admin',
    }),
    /** Recent finished migration jobs, newest first. The live job is `status`. */
    history: method(z.object({}), z.array(StorageMigrationJobSchema).readonly(), {
      auth: 'admin',
    }),
  },
} as const satisfies CapabilityDefinition

export type IStorageMigrationProvider = InferProvider<typeof storageMigrationCapability>
