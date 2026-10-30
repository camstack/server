import { z } from 'zod'
import {
  RecordKindDeclarationSchema,
  RecordKindNameSchema,
  RecordRetentionSchema,
} from '../records/record-kind.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'
import { RecordQueryInputSchema, RecordQueryResultSchema } from './records.cap.js'

/** One table of the settings database. */
export const StorageTableSchema = z.object({
  /** The table's full name, e.g. `recorder:addon-settings` or `addon-device-settings`. */
  name: z.string(),
  /** The owner prefix of a scoped name (`recorder` for `recorder:addon-settings`), else null. */
  owner: z.string().nullable(),
  rows: z.number().int().nonnegative(),
  /** Bytes the table's pages occupy (`dbstat`); null when the engine cannot measure. */
  bytes: z.number().int().nonnegative().nullable(),
  /** Declared by an addon since this engine process started (a running addon claims it). */
  declaredThisBoot: z.boolean(),
})
export type StorageTable = z.infer<typeof StorageTableSchema>

/** One declared record kind (D881) as System -> Data shows it. */
export const StorageKindSchema = z.object({
  owner: z.string(),
  kind: z.string(),
  database: z.enum(['settings', 'events']),
  class: z.string(),
  state: z.enum(['declared', 'orphaned', 'dropped']),
  /** An owner declared this kind since the engine started. */
  declaredThisBoot: z.boolean(),
  /** `null` when the caller asked for no counts (`counts: false`). */
  rows: z.number().int().nonnegative().nullable(),
  /** Rows x the average size of a sample; null for an empty kind. */
  bytesEstimate: z.number().int().nonnegative().nullable(),
  writeTrigger: z.string(),
  retention: RecordRetentionSchema,
  /** `true` when the kind is an entry kind (the generic entries UI lists it). */
  entry: z.boolean(),
  /** The whole declaration, secret paths and entry descriptor included (the entries service builds its handle from it). */
  declaration: RecordKindDeclarationSchema,
})
export type StorageKind = z.infer<typeof StorageKindSchema>

/** Why an addon's data is suspected of being left behind. */
export const StaleVerdictSchema = z.enum(['orphaned', 'stale', 'unknown'])
export type StaleVerdict = z.infer<typeof StaleVerdictSchema>

/** A record kind nobody declared since its owner started, or whose owner is gone. */
export const StaleKindFindingSchema = z.object({
  owner: z.string(),
  kind: z.string(),
  /** `unknown`: the owner could not be judged (not running, or its state unreadable) - never dropped. */
  verdict: z.enum(['orphaned', 'unknown']),
  reason: z.string(),
  rows: z.number().int().nonnegative().nullable(),
  /** local-auth's tables are never dropped by this audit. */
  protected: z.boolean(),
})
export type StaleKindFinding = z.infer<typeof StaleKindFindingSchema>

/** A stored global-settings key the running addon no longer declares. */
export const StaleSettingsKeyFindingSchema = z.object({
  addonId: z.string(),
  /** The stored key as written, a per-node `<key>@<nodeId>` suffix included. */
  key: z.string(),
  /**
   * Keychain refs whose ONLY marker sits under this key: in use by stale data,
   * not orphans yet. Removing the key releases them.
   */
  secretRefs: z.array(z.string()),
})
export type StaleSettingsKeyFinding = z.infer<typeof StaleSettingsKeyFindingSchema>

/** An addon the audit could not judge, with the reason. Never reported as stale. */
export const StaleUnknownSchema = z.object({ subject: z.string(), reason: z.string() })

export const StaleDataReportSchema = z.object({
  /** Epoch ms of the last finished scan; `null` before the first. */
  scannedAt: z.number().nullable(),
  scanning: z.boolean(),
  trigger: z.enum(['boot', 'interval', 'manual']).nullable(),
  kinds: z.array(StaleKindFindingSchema),
  settingsKeys: z.array(StaleSettingsKeyFindingSchema),
  unknown: z.array(StaleUnknownSchema),
})
export type StaleDataReport = z.infer<typeof StaleDataReportSchema>

/**
 * storage-admin - the operator's maintenance reach into the databases: list
 * their tables and record kinds, read a kind for diagnosis. Read-only: a table
 * the code no longer creates is dropped by hand, offline (D901).
 *
 * Hub-only, internal and `auth: 'admin'` explicitly (`internal` does not gate
 * the mount, see `data-store-provider`). `listTables` is LOGGED by the engine
 * with the counts.
 *
 * `listTables` is READ-ONLY: it never creates a table, which `count` and `get`
 * on an undeclared scoped name used to do.
 */
export const storageAdminCapability = {
  name: 'storage-admin',
  scope: 'system',
  mode: 'singleton',
  internal: true,
  methods: {
    /**
     * Every table of the settings database with its row count and size,
     * optionally only those owned by `ownerPrefix`. Reads only.
     */
    listTables: method(
      z.object({ ownerPrefix: z.string().min(1).optional() }),
      z.object({ tables: z.array(StorageTableSchema) }),
      { auth: 'admin' },
    ),
    /** Every record kind of both files with rows, a size estimate, class and retention (D881). */
    listKinds: method(
      z.object({
        owner: z.string().min(1).optional(),
        /** `false` skips the per-kind row count (a catalog read only). Default true. */
        counts: z.boolean().optional(),
      }),
      z.object({ kinds: z.array(StorageKindSchema) }),
      { auth: 'admin' },
    ),
    /**
     * Read-only diagnosis of ANY owner's kind: the same indexed query as the
     * owner's, secret fields redacted, audited in the engine log.
     */
    readRecords: method(
      RecordQueryInputSchema.extend({ owner: z.string().min(1), kind: RecordKindNameSchema }),
      RecordQueryResultSchema,
      { auth: 'admin' },
    ),
    /**
     * The last stale-data scan (read-only detection): record kinds left behind
     * and settings keys no running addon declares. Held in memory; a scan runs
     * at hub boot, every 24 h and on `scanStaleData`.
     */
    staleDataReport: method(z.object({}), StaleDataReportSchema, { auth: 'admin' }),
    /** Scan now. Detection only: it logs findings (owner and key, never values) and changes nothing. */
    scanStaleData: method(z.object({}), StaleDataReportSchema, { kind: 'mutation', auth: 'admin' }),
    /**
     * Drop an ORPHANED kind: its rows, their keychain values, then mark it
     * dropped. The verdict is re-checked at call time; anything not still
     * orphaned (or a protected owner) is refused.
     */
    dropOrphanedKind: method(
      z.object({ owner: z.string().min(1), kind: RecordKindNameSchema }),
      z.object({
        deleted: z.number().int().nonnegative(),
        secretsReleased: z.number().int().nonnegative(),
      }),
      { kind: 'mutation', auth: 'admin', caller: 'required' },
    ),
    /**
     * Unset one stale settings key on a running addon (an owner-side write that
     * also clears the keychain values the key held). Re-checked at call time.
     */
    unsetStaleSettingsKey: method(
      z.object({ addonId: z.string().min(1), key: z.string().min(1) }),
      z.object({ removed: z.boolean(), secretsCleared: z.number().int().nonnegative() }),
      { kind: 'mutation', auth: 'admin', caller: 'required' },
    ),
  },
} as const satisfies CapabilityDefinition

export type IStorageAdminProvider = InferProvider<typeof storageAdminCapability>
