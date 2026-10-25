import { z } from 'zod'
import { RECORD_BATCH_MAX, RECORD_ID_MAX_LENGTH, RECORD_QUERY_MAX } from '../records/constants.js'
import {
  RecordFieldPathSchema,
  RecordKindDeclarationSchema,
  RecordKindNameSchema,
} from '../records/record-kind.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'

/**
 * records - an addon's own facts and documents (D881): ledgers, audit rows,
 * config documents, mirrors. The third storage API next to `ctx.settings`
 * (operator intent, D870) and device-history (numbers over time, D850).
 *
 * Who the OWNER is: `callerAddonId`, stamped by the transport on a call that
 * crossed a process and stated by a hub in-process caller (`ctx.records` does
 * that with the addon id closed over). It is deliberately NOT in any input
 * schema, so a session can never supply it, and a call with no stamp is refused
 * `records/no-caller`. A kind is readable and writable only by its owner; other
 * addons go through the owner's capability.
 *
 * Every read is three-way: a row, `null`, or the call THROWS. A failed read is
 * never `[]`. Secret fields are never on the wire: a read shows the
 * redaction token, `secretRefs` hands the owner's `ctx.secrets` the refs it
 * resolves itself, and a write may carry only a keychain marker bound to the
 * row's own ref.
 *
 * Internal: addons reach it through `ctx.records`, never directly.
 */

export const RecordIdSchema = z.string().min(1).max(RECORD_ID_MAX_LENGTH)

/** A JSON object body. Size is the engine's check (`maxDataBytes`), not a schema's. */
export const RecordBodySchema = z.record(z.string(), z.unknown())

export const RecordInputSchema = z.object({
  id: RecordIdSchema,
  /** The device this row belongs to (D865 removal, per-device reads). */
  deviceId: z.number().int().optional(),
  /** The domain clock, ms: observed / created / opened. */
  at: z.number().int().optional(),
  /** Producer-set expiry, ms. Refused on a kind whose retention is an engine TTL. */
  expiresAt: z.number().int().optional(),
  data: RecordBodySchema,
})
export type RecordInput = z.infer<typeof RecordInputSchema>

export const RecordViewSchema = z.object({
  id: z.string(),
  deviceId: z.number().int().nullable(),
  at: z.number().nullable(),
  expiresAt: z.number().nullable(),
  rev: z.number().int(),
  updatedAt: z.number(),
  data: RecordBodySchema,
})
export type RecordView = z.infer<typeof RecordViewSchema>

/** One predicate on a declared index field: equality, a set, or a range. */
export const RecordWhereValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.object({
    in: z
      .array(z.union([z.string(), z.number(), z.boolean()]))
      .min(1)
      .max(RECORD_BATCH_MAX),
  }),
  z
    .object({
      gt: z.union([z.string(), z.number()]).optional(),
      gte: z.union([z.string(), z.number()]).optional(),
      lt: z.union([z.string(), z.number()]).optional(),
      lte: z.union([z.string(), z.number()]).optional(),
    })
    .refine((r) => Object.keys(r).length > 0, { message: 'name at least one bound' }),
])
export type RecordWhereValue = z.infer<typeof RecordWhereValueSchema>

/** Declared index fields only. Anything else does not compile, by design. */
export const RecordWhereSchema = z.record(RecordFieldPathSchema, RecordWhereValueSchema)
export type RecordWhere = z.infer<typeof RecordWhereSchema>

const KindShape = { kind: RecordKindNameSchema }

const TimeWindowShape = {
  deviceId: z.number().int().optional(),
  atFrom: z.number().optional(),
  atTo: z.number().optional(),
}

export const RecordQueryInputSchema = z.object({
  ...KindShape,
  ...TimeWindowShape,
  where: RecordWhereSchema.optional(),
  /** Without `where`: `at` (default for a kind with a clock) or `id`. With `where` the order is the index's. */
  order: z.enum(['at', 'id']).optional(),
  desc: z.boolean().optional(),
  limit: z.number().int().min(1).max(RECORD_QUERY_MAX).default(100),
  /** Opaque keyset cursor from a previous answer. There is no offset. */
  cursor: z.string().min(1).optional(),
})
export type RecordQueryInput = z.infer<typeof RecordQueryInputSchema>

export const RecordQueryResultSchema = z.object({
  records: z.array(RecordViewSchema),
  nextCursor: z.string().nullable(),
})
export type RecordQueryResult = z.infer<typeof RecordQueryResultSchema>

export const RecordKindStateSchema = z.enum(['created', 'unchanged', 'updated'])

export const DeclareKindResultSchema = z.object({
  kindId: z.number().int(),
  state: RecordKindStateSchema,
  createdIndexes: z.array(z.string()),
})
export type DeclareKindResult = z.infer<typeof DeclareKindResultSchema>

/** Keychain refs a write released (the old marker is gone from the row): the owner deletes the values. */
const SecretRefsList = z.array(z.string())

/**
 * One op of a `transact`: the single-row writes, each on a kind of the caller.
 * All ops of one call share ONE database file and ONE `transactFamily`.
 */
export const RecordTransactOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('put'),
    kind: RecordKindNameSchema,
    record: RecordInputSchema,
    ifRev: z.number().int().min(0).optional(),
  }),
  z.object({
    op: z.literal('patch'),
    kind: RecordKindNameSchema,
    id: RecordIdSchema,
    data: RecordBodySchema,
    at: z.number().int().nullable().optional(),
    expiresAt: z.number().int().nullable().optional(),
    ifRev: z.number().int().min(1).optional(),
  }),
  z.object({ op: z.literal('delete'), kind: RecordKindNameSchema, id: RecordIdSchema }),
])
export type RecordTransactOp = z.infer<typeof RecordTransactOpSchema>

export const RecordSecretRefsSchema = z.record(z.string(), z.record(z.string(), z.string()))

export const recordsCapability = {
  name: 'records',
  scope: 'system',
  mode: 'singleton',
  internal: true,
  methods: {
    /** Reconcile this addon's kinds: create the catalog rows and the declared indexes. Additive only. */
    declareKinds: method(
      z.object({ kinds: z.record(RecordKindNameSchema, RecordKindDeclarationSchema) }),
      z.object({ kinds: z.record(z.string(), DeclareKindResultSchema) }),
      { kind: 'mutation', auth: 'admin' },
    ),
    get: method(z.object({ ...KindShape, id: RecordIdSchema }), RecordViewSchema.nullable(), {
      auth: 'admin',
    }),
    getMany: method(
      z.object({ ...KindShape, ids: z.array(RecordIdSchema).min(1).max(RECORD_BATCH_MAX) }),
      z.array(RecordViewSchema),
      { auth: 'admin' },
    ),
    /** The keychain refs of the rows' secret fields, by id and concrete path. For the owner's `ctx.secrets`. */
    secretRefs: method(
      z.object({ ...KindShape, ids: z.array(RecordIdSchema).min(1).max(RECORD_BATCH_MAX) }),
      RecordSecretRefsSchema,
      { auth: 'admin' },
    ),
    put: method(
      z.object({
        ...KindShape,
        record: RecordInputSchema,
        /** Compare-and-set. `0` means "the row must not exist". */
        ifRev: z.number().int().min(0).optional(),
      }),
      z.object({ rev: z.number().int(), releasedRefs: SecretRefsList }),
      { kind: 'mutation', auth: 'admin' },
    ),
    putMany: method(
      z.object({
        ...KindShape,
        records: z.array(RecordInputSchema).min(1).max(RECORD_BATCH_MAX),
      }),
      z.object({ count: z.number().int(), releasedRefs: SecretRefsList }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /** One-statement RFC 7396 merge: `null` removes a field; a merge never reads. */
    patch: method(
      z.object({
        ...KindShape,
        id: RecordIdSchema,
        data: RecordBodySchema,
        at: z.number().int().nullable().optional(),
        expiresAt: z.number().int().nullable().optional(),
        ifRev: z.number().int().min(1).optional(),
      }),
      z.object({ rev: z.number().int(), releasedRefs: SecretRefsList }),
      { kind: 'mutation', auth: 'admin' },
    ),
    delete: method(
      z.object({ ...KindShape, id: RecordIdSchema }),
      z.object({ deleted: z.boolean(), secretRefs: SecretRefsList }),
      { kind: 'mutation', auth: 'admin' },
    ),
    deleteMany: method(
      z.object({ ...KindShape, ids: z.array(RecordIdSchema).min(1).max(RECORD_BATCH_MAX) }),
      z.object({ deleted: z.number().int(), secretRefs: SecretRefsList }),
      { kind: 'mutation', auth: 'admin' },
    ),
    query: method(RecordQueryInputSchema, RecordQueryResultSchema, { auth: 'admin' }),
    count: method(
      z.object({ ...KindShape, ...TimeWindowShape, where: RecordWhereSchema.optional() }),
      z.object({ count: z.number().int() }),
      { auth: 'admin' },
    ),
    histogram: method(
      z.object({
        ...KindShape,
        deviceId: z.number().int().optional(),
        from: z.number(),
        to: z.number(),
        bucketMs: z.number().int().positive(),
      }),
      z.object({
        buckets: z.array(z.object({ bucketStart: z.number(), count: z.number().int() })),
      }),
      { auth: 'admin' },
    ),
    /** Index-served only: every field must belong to ONE declared index. */
    aggregate: method(
      z.object({
        ...KindShape,
        op: z.enum(['sum', 'min', 'max', 'count']),
        field: RecordFieldPathSchema.optional(),
        groupBy: RecordFieldPathSchema.optional(),
        where: RecordWhereSchema.optional(),
      }),
      z.object({
        rows: z.array(
          z.object({
            group: z.union([z.string(), z.number(), z.null()]),
            value: z.number().nullable(),
          }),
        ),
      }),
      { auth: 'admin' },
    ),
    /** Batched (5 000 rows per statement, yielding between). Needs a predicate: there is no "delete all". */
    deleteWhere: method(
      z.object({
        ...KindShape,
        deviceId: z.number().int().optional(),
        atBefore: z.number().optional(),
        where: RecordWhereSchema.optional(),
      }),
      z.object({ deleted: z.number().int(), secretRefs: SecretRefsList }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Several single-row writes (put / patch / delete) in ONE SQLite transaction:
     * all land or none does. Every op's kind must sit in one file and share one
     * `transactFamily` (`records/transact-refused` otherwise). Results are in op order.
     */
    transact: method(
      z.object({ ops: z.array(RecordTransactOpSchema).min(1).max(RECORD_BATCH_MAX) }),
      z.object({
        results: z.array(z.object({ rev: z.number().int().nullable(), deleted: z.boolean() })),
        releasedRefs: SecretRefsList,
        secretRefs: SecretRefsList,
      }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /** The D865 hook body: every kind of this addon declared `deviceRemoval: 'delete'`. */
    deleteDevice: method(
      z.object({ deviceId: z.number().int(), kinds: z.array(RecordKindNameSchema).optional() }),
      z.object({ deleted: z.record(z.string(), z.number().int()), secretRefs: SecretRefsList }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /** A monotonically increasing integer per kind (replaces "resume from the highest"). */
    allocateId: method(z.object(KindShape), z.object({ id: z.number().int() }), {
      kind: 'mutation',
      auth: 'admin',
    }),
  },
} as const satisfies CapabilityDefinition

export type IRecordsProvider = InferProvider<typeof recordsCapability>
