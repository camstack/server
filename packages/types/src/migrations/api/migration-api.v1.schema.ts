/**
 * The wire shapes of the migration API, version 1 (planning#447).
 *
 * A migration is code that outlives the server it was written against: an addon at
 * version 1.4 that is brought to 1.9 in one jump still runs its 1.4 catalogue, against
 * the 1.9 kernel. The only thing that code may call is {@link MigrationApiV1}; this file
 * is the contract of every method of it, one Zod pair per method.
 *
 * APPEND-ONLY. A released method is never removed and never changes meaning: an input
 * field is never removed or made required, an enum never narrows, an output field is
 * never removed. A change that cannot be expressed that way is `migration-api.v2`, next
 * to this file. `scripts/check-migration-api-append-only.ts` holds the line against
 * `scripts/migration-api-contract.json`, and every `behaviours` id below must have an
 * `it('<id>'` in `migration-api.contract.spec.ts`.
 */
import { z } from 'zod'
import { RecordWhereSchema } from '../../capabilities/records.cap.js'
import {
  MigrationMetaSchema,
  MigrationOwnerResultSchema,
  MigrationOwnerStepSchema,
  MigrationStatusSchema,
} from '../migration.js'

import { MIGRATION_API_VERSION } from './migration-api-version.js'

export { MIGRATION_API_VERSION }

/** One method of the contract: its input, its output and the behaviours a spec must prove. */
export interface MigrationApiMethodSpec {
  readonly input: z.ZodType
  readonly output: z.ZodType
  /** Stable ids; each one has an `it('<id>'` in the contract spec. Never renamed. */
  readonly behaviours: readonly string[]
}

const Rows = z.record(z.string(), z.unknown())
const IntegrationId = z.object({ integrationId: z.string().min(1) })
const RecordId = z.object({ id: z.string().min(1) })

const RecordRowSchema = z.object({
  id: z.string(),
  deviceId: z.number().int().nullable(),
  at: z.number().nullable(),
  expiresAt: z.number().nullable(),
  rev: z.number().int(),
  updatedAt: z.number(),
  data: Rows,
})

const RecordPutShape = {
  id: z.string().min(1),
  deviceId: z.number().int().optional(),
  at: z.number().int().optional(),
  expiresAt: z.number().int().optional(),
  data: Rows,
}

const MigrationIntegrationSchema = z.object({
  id: z.string(),
  addonId: z.string(),
  name: z.string(),
  info: Rows,
  /** The registry's stored switch: read by the one-switch migration, nothing else. */
  enabled: z.boolean().optional(),
  originStableId: z.string().optional(),
})

const MigrationDeviceSchema = z.object({
  id: z.number().int(),
  integrationId: z.string().nullable().optional(),
  /** The owning device; null or absent for a root. */
  parentDeviceId: z.number().int().nullable().optional(),
  type: z.string().optional(),
  name: z.string().optional(),
  stableId: z.string().optional(),
})

/** What the engine says about the migration API it serves: lets an addon notice an older server. */
export const MigrationApiInfoSchema = z.object({
  version: z.number().int(),
  methods: z.array(z.string()),
})

const LogInput = z.object({
  message: z.string(),
  meta: Rows.optional(),
  /** Grouping tags of the line; a line about a device carries `{ deviceId }`. */
  tags: z.object({ deviceId: z.number().int().optional() }).optional(),
})

export const MIGRATION_API_V1_METHODS = {
  'ledger.declare': {
    input: z.object({ owner: z.string().min(1), metas: z.array(MigrationMetaSchema) }),
    output: z.object({
      bootId: z.string(),
      snapshot: z.enum(['none', 'written', 'refused']),
      steps: z.array(MigrationOwnerStepSchema),
      /** The migration API the engine serves; absent from a server that predates it. */
      migrationApi: MigrationApiInfoSchema.optional(),
    }),
    behaviours: [
      'ledger.declare.answers-steps-in-engine-order',
      'ledger.declare.answers-the-migration-api',
    ],
  },
  'ledger.start': {
    input: z.object({ id: z.string().min(1) }),
    output: z.object({
      proceed: z.boolean(),
      state: z.union([z.literal('pending'), MigrationStatusSchema]),
      reason: z.string().nullable(),
    }),
    behaviours: ['ledger.start.proceeds-when-predecessors-applied'],
  },
  'ledger.finish': {
    input: z.object({ id: z.string().min(1), result: MigrationOwnerResultSchema }),
    output: z.object({
      status: MigrationStatusSchema,
      error: z.string().nullable(),
      rowsChanged: z.number().int().nonnegative(),
    }),
    behaviours: ['ledger.finish.records-the-outcome'],
  },
  'legacyRows.read': {
    input: IntegrationId,
    output: Rows,
    behaviours: [
      'legacyRows.read.returns-stored-rows',
      'legacyRows.read.absent-store-is-empty',
      'legacyRows.caller.sibling-package',
    ],
  },
  'legacyRows.clear': {
    input: IntegrationId,
    output: z.object({
      rows: z.number().int().nonnegative(),
      secrets: z.number().int().nonnegative(),
    }),
    behaviours: ['legacyRows.clear.deletes-the-rows', 'legacyRows.clear.absent-store-is-noop'],
  },
  'legacyRows.patch': {
    input: IntegrationId.extend({ patch: Rows }),
    output: z.object({ written: z.boolean() }),
    behaviours: [
      'legacyRows.patch.upserts-keys-and-keeps-the-rest',
      'legacyRows.patch.absent-store-writes-nothing',
    ],
  },
  'legacyRows.deleteKeys': {
    input: IntegrationId.extend({ keys: z.array(z.string().min(1)) }),
    output: z.object({ present: z.boolean(), removed: Rows }),
    behaviours: [
      'legacyRows.deleteKeys.removes-the-named-keys',
      'legacyRows.deleteKeys.absent-store-reports-not-present',
    ],
  },
  'records.get': {
    input: RecordId,
    output: RecordRowSchema.nullable(),
    behaviours: ['records.get.returns-the-row-or-null'],
  },
  'records.getResolved': {
    input: RecordId,
    output: RecordRowSchema.nullable(),
    behaviours: ['records.getResolved.resolves-secret-fields'],
  },
  'records.put': {
    input: z.object({ ...RecordPutShape, ifRev: z.number().int().optional() }),
    output: z.object({ rev: z.number().int() }),
    behaviours: ['records.put.creates-and-replaces', 'records.put.if-rev-conflict-throws'],
  },
  'records.putMany': {
    input: z.object({ records: z.array(z.object(RecordPutShape)) }),
    output: z.object({ count: z.number().int().nonnegative() }),
    behaviours: ['records.putMany.writes-every-row'],
  },
  'records.patch': {
    input: RecordId.extend({ partial: Rows, ifRev: z.number().int().optional() }),
    output: z.object({ rev: z.number().int() }),
    behaviours: ['records.patch.merges-and-null-removes'],
  },
  'records.delete': {
    input: RecordId,
    output: z.object({ deleted: z.boolean() }),
    behaviours: ['records.delete.reports-whether-a-row-went'],
  },
  'records.query': {
    input: z.object({
      deviceId: z.number().int().optional(),
      atFrom: z.number().optional(),
      atTo: z.number().optional(),
      where: RecordWhereSchema.optional(),
      limit: z.number().int().min(1).optional(),
      cursor: z.string().min(1).optional(),
      resolveSecrets: z.boolean().optional(),
    }),
    output: z.object({ records: z.array(RecordRowSchema), nextCursor: z.string().nullable() }),
    behaviours: ['records.query.pages-with-a-cursor', 'records.query.filters-on-a-declared-index'],
  },
  'records.deleteWhere': {
    input: z.object({
      deviceId: z.number().int().optional(),
      atBefore: z.number().optional(),
      where: RecordWhereSchema.optional(),
    }),
    output: z.object({ count: z.number().int().nonnegative() }),
    behaviours: ['records.deleteWhere.deletes-the-matching-rows'],
  },
  'settings.read': {
    input: z.object({}),
    output: z.object({ store: Rows }),
    behaviours: ['settings.read.returns-the-addon-store'],
  },
  'settings.write': {
    input: z.object({ patch: Rows }),
    output: z.object({}),
    behaviours: ['settings.write.merges-and-keeps-other-keys'],
  },
  'settings.deleteKeys': {
    input: z.object({ keys: z.array(z.string().min(1)) }),
    output: z.object({ removed: z.array(z.string()) }),
    behaviours: ['settings.deleteKeys.removes-only-the-named-keys'],
  },
  'deviceSettings.listIds': {
    // The addon's OWN per-device settings: the ids that have a blob in its store, never another addon's.
    input: z.object({}),
    output: z.object({ deviceIds: z.array(z.number().int()) }),
    behaviours: ['deviceSettings.listIds.names-only-the-addons-own-devices'],
  },
  'deviceSettings.read': {
    input: z.object({ deviceIds: z.array(z.number().int()) }),
    // Keyed by the device id as text (JSON has no numeric keys); a device with no blob is absent.
    output: z.object({ blobs: z.record(z.string(), Rows) }),
    behaviours: ['deviceSettings.read.returns-only-the-addons-own-blobs'],
  },
  'secrets.resolve': {
    input: z.object({ refs: z.array(z.string()) }),
    output: z.object({ values: z.record(z.string(), z.string().nullable()) }),
    behaviours: ['secrets.resolve.answers-null-for-a-missing-ref'],
  },
  'secrets.put': {
    input: z.object({ ref: z.string().min(1), value: z.string() }),
    output: z.object({}),
    behaviours: ['secrets.put.stores-under-the-owner'],
  },
  'secrets.delete': {
    input: z.object({ refs: z.array(z.string()) }),
    output: z.object({ deleted: z.number().int().nonnegative() }),
    behaviours: ['secrets.delete.ignores-unknown-refs'],
  },
  'integrations.list': {
    input: z.object({}),
    output: z.object({ integrations: z.array(MigrationIntegrationSchema) }),
    behaviours: ['integrations.list.lists-every-integration'],
  },
  'integrations.get': {
    input: z.object({ id: z.string().min(1) }),
    output: MigrationIntegrationSchema.nullable(),
    behaviours: ['integrations.get.null-for-an-unknown-id'],
  },
  'devices.list': {
    // Always scoped: a migration never walks every device of the cluster.
    input: z.object({ addonId: z.string().min(1), integrationId: z.string().min(1).optional() }),
    output: z.object({ devices: z.array(MigrationDeviceSchema) }),
    behaviours: ['devices.list.scoped-to-the-addon', 'devices.list.filters-by-integration'],
  },
  'devices.get': {
    input: z.object({ deviceId: z.number().int() }),
    output: z
      .object({
        id: z.number().int(),
        integrationId: z.string().nullable(),
        /** Whether the device carries any stored config; its content is not offered. */
        hasConfig: z.boolean(),
      })
      .nullable(),
    behaviours: ['devices.get.null-for-an-unknown-id', 'devices.get.reports-link-and-config'],
  },
  'devices.aliases': {
    // By explicit id, never a walk: a migration asks about the devices ITS rows name. Read only.
    input: z.object({ deviceIds: z.array(z.number().int()) }),
    // Keyed by the device id as text; a device without an alias (or unknown) is absent.
    output: z.object({ aliases: z.record(z.string(), z.string()) }),
    behaviours: ['devices.aliases.answers-for-the-named-ids-only'],
  },
  'devices.setIntegrationId': {
    input: z.object({ deviceId: z.number().int(), integrationId: z.string().min(1) }),
    output: z.object({}),
    behaviours: ['devices.setIntegrationId.links-the-device'],
  },
  'node.localNodeId': {
    input: z.object({}),
    output: z.object({ nodeId: z.string() }),
    behaviours: ['node.localNodeId.names-this-node'],
  },
  'log.info': {
    input: LogInput,
    output: z.object({}),
    behaviours: ['log.info.writes-a-line'],
  },
  'log.warn': {
    input: LogInput,
    output: z.object({}),
    behaviours: ['log.warn.writes-a-line'],
  },
} as const satisfies Record<string, MigrationApiMethodSpec>

export type MigrationApiMethodName = keyof typeof MIGRATION_API_V1_METHODS

type Spec = typeof MIGRATION_API_V1_METHODS

/** The argument of a contract method. */
export type MigrationApiInput<M extends MigrationApiMethodName> = z.input<Spec[M]['input']>
/** What a contract method answers. */
export type MigrationApiOutput<M extends MigrationApiMethodName> = z.output<Spec[M]['output']>
