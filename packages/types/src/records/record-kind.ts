/**
 * Record kinds (D881): the declaration an addon makes of one kind of fact, the
 * Zod row schema that describes it, and the helper that turns the two into the
 * JSON the engine stores.
 *
 * A kind is declared ONCE, next to the code that owns it, and the engine's
 * reconciler creates its indexes - nothing creates DDL at runtime from a write.
 * Everything the generic machinery needs (secret fields, the entry descriptor)
 * is DERIVED from the Zod schema: `.meta({ secret: true })` marks a credential,
 * never a field name (D879).
 */
import { z } from 'zod'
import { collectZodSecretPaths } from '../device/zod-secret.js'
import {
  RECORD_CLASSES,
  RECORD_DATABASES,
  RECORD_DEFAULT_MAX_DATA_BYTES,
  RECORD_MAX_DATA_BYTES,
  RECORD_MAX_INDEX_FIELDS,
  RECORD_MAX_INDEXES,
  RECORD_SETTINGS_MAX_ROWS,
} from './constants.js'
import { DeclarationRefusedError } from './errors.js'
import { secretArrayPrefixes } from './secret-paths.js'

/** A JSON field path: `trackId`, `auth.accessToken`. Charset-restricted: it is rendered into DDL. */
export const RecordFieldPathSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}(\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,3}$/)

export const RecordIndexSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
    fields: z.array(RecordFieldPathSchema).min(1).max(RECORD_MAX_INDEX_FIELDS),
    unique: z.boolean().optional(),
  })
  .strict()
export type RecordIndex = z.infer<typeof RecordIndexSchema>

export const RecordRetentionSchema = z.union([
  /** The engine sets `expires_at` on write and a scheduled sweep deletes past it. */
  z
    .object({
      ttlMs: z.number().int().positive(),
      from: z.enum(['at', 'write']),
    })
    .strict(),
  /** The engine trims the oldest rows on write. */
  z
    .object({
      maxRows: z.number().int().positive().optional(),
      maxRowsPerDevice: z.number().int().positive().optional(),
    })
    .strict()
    .refine((r) => r.maxRows !== undefined || r.maxRowsPerDevice !== undefined, {
      message: 'name maxRows, maxRowsPerDevice or both',
    }),
  /** The engine does nothing; the owner sweeps with `deleteWhere` on its own clock. */
  z.object({ owner: z.string().min(1), reason: z.string().min(1) }).strict(),
  /** Never pruned; the reason is shown in System -> Data. */
  z.object({ none: z.string().min(1) }).strict(),
])
export type RecordRetention = z.infer<typeof RecordRetentionSchema>

/** The descriptor a generic entries UI reads (D881 "generic entries"). */
export const EntryDescriptorSchema = z
  .object({
    title: z.string().min(1),
    /** The record body field shown as the entry's name. */
    nameField: z.string().min(1),
    /** JSON Schema of the entry body; `secret: true` marks a password field. */
    fields: z.record(z.string(), z.unknown()),
  })
  .strict()
export type EntryDescriptor = z.infer<typeof EntryDescriptorSchema>

const RecordKindDeclarationShape = z.object({
  database: z.enum(RECORD_DATABASES).default('settings'),
  class: z.enum(RECORD_CLASSES),
  writeTrigger: z.string().min(1),
  device: z.enum(['required', 'optional', 'none']).default('none'),
  at: z.enum(['required', 'none']).default('none'),
  indexes: z.array(RecordIndexSchema).max(RECORD_MAX_INDEXES).default([]),
  retention: RecordRetentionSchema,
  deviceRemoval: z.enum(['delete', 'none']).default('none'),
  maxDataBytes: z
    .number()
    .int()
    .positive()
    .max(RECORD_MAX_DATA_BYTES)
    .default(RECORD_DEFAULT_MAX_DATA_BYTES),
  /** Derived from the Zod schema; never written by hand. */
  secretPaths: z.array(z.string().min(1)).default([]),
  /** The id key of each array that carries a secret (`{ headers: 'name' }`). */
  secretArrayKeys: z.record(z.string(), z.string()).default({}),
  /** Kinds that must agree through `transact` sit in one file under one family name. */
  transactFamily: z.string().min(1).optional(),
  entry: EntryDescriptorSchema.optional(),
})

/** What crosses the wire from an addon: JSON only, no Zod. An unknown key is refused. */
export const RecordKindDeclarationSchema = RecordKindDeclarationShape.strict()

/**
 * A declaration as the engine's catalog stored it: an unknown key is DROPPED,
 * because a row written by an older engine must never stop records from
 * starting. Only for rows read back from the catalog, never for input.
 */
export const StoredRecordKindDeclarationSchema = RecordKindDeclarationShape
export type RecordKindDeclaration = z.infer<typeof RecordKindDeclarationSchema>

/** The kind names: lower-case, dash separated, short enough for an index name. */
export const RecordKindNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/)

/** Cross-field rules a declaration must satisfy. Throws {@link DeclarationRefusedError}. */
export function assertValidDeclaration(name: string, decl: RecordKindDeclaration): void {
  const refuse = (why: string): never => {
    throw new DeclarationRefusedError(`kind "${name}": ${why}`)
  }
  if (!RecordKindNameSchema.safeParse(name).success) refuse('the name must be lower-case-dashed')
  const seen = new Set<string>()
  for (const index of decl.indexes) {
    if (seen.has(index.name)) refuse(`index name "${index.name}" is declared twice`)
    seen.add(index.name)
  }
  const { retention } = decl
  const hasSecrets = decl.secretPaths.length > 0
  if ('ttlMs' in retention) {
    if (retention.from === 'at' && decl.at !== 'required') {
      refuse('a ttl from "at" needs at: "required"')
    }
    if (hasSecrets)
      refuse(
        'a kind with secret fields cannot use engine TTL (its keychain values would be orphaned)',
      )
  }
  if ('maxRows' in retention || 'maxRowsPerDevice' in retention) {
    if (retention.maxRowsPerDevice !== undefined && decl.device !== 'required') {
      refuse('maxRowsPerDevice needs device: "required"')
    }
    if (decl.at !== 'required') refuse('a row bound trims the oldest "at": it needs at: "required"')
    if (hasSecrets) refuse('a kind with secret fields cannot use an engine row bound')
    const bound = Math.max(retention.maxRows ?? 0, retention.maxRowsPerDevice ?? 0)
    if (decl.database === 'settings' && bound > RECORD_SETTINGS_MAX_ROWS) {
      refuse(
        `a row bound above ${RECORD_SETTINGS_MAX_ROWS} belongs in database: "events" (a big delete on the settings thread stalls every configuration read)`,
      )
    }
  }
  if (decl.deviceRemoval === 'delete' && decl.device === 'none') {
    refuse('deviceRemoval: "delete" needs a device: "required" or "optional"')
  }
  for (const path of decl.secretPaths) {
    for (const prefix of secretArrayPrefixes(path)) {
      if (decl.secretArrayKeys[prefix] === undefined) {
        refuse(
          `secret path "${path}" crosses the array "${prefix}": declare its id key in secretArrayKeys`,
        )
      }
    }
  }
}

/** The input of {@link defineRecordKinds} for one kind. */
export interface RecordKindSpec<S extends z.ZodType = z.ZodType> {
  readonly schema: S
  readonly database?: (typeof RECORD_DATABASES)[number]
  readonly class: (typeof RECORD_CLASSES)[number]
  readonly writeTrigger: string
  readonly device?: 'required' | 'optional' | 'none'
  readonly at?: 'required' | 'none'
  readonly indexes?: readonly RecordIndex[]
  readonly retention: RecordRetention
  readonly deviceRemoval?: 'delete' | 'none'
  readonly maxDataBytes?: number
  readonly secretArrayKeys?: Readonly<Record<string, string>>
  readonly transactFamily?: string
  /** Makes this an ENTRY kind: it gets the generic list/add/edit/delete UI. */
  readonly entry?: { readonly title: string; readonly nameField?: string }
}

/** A declared kind: its name, the row schema and the JSON the engine stores. */
export interface DefinedRecordKind<S extends z.ZodType = z.ZodType> {
  readonly name: string
  readonly schema: S
  readonly declaration: RecordKindDeclaration
}

function bodyFieldsOf(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' })
  return { ...json }
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Does every branch of the body schema carry `field`? (A discriminated union has several.) */
function hasNameField(json: Record<string, unknown>, field: string): boolean {
  const branches = json['oneOf'] ?? json['anyOf']
  if (Array.isArray(branches)) {
    return branches.length > 0 && branches.every((b) => isRecordLike(b) && hasNameField(b, field))
  }
  const properties = json['properties']
  return isRecordLike(properties) && Object.prototype.hasOwnProperty.call(properties, field)
}

/**
 * Declare the kinds of a package. The keys are the kind names. The result is
 * what `ctx.records.declare` sends to the engine and what `ctx.records.kind`
 * types its handle from.
 */
export function defineRecordKinds<const T extends Readonly<Record<string, RecordKindSpec>>>(
  specs: T,
): { readonly [K in keyof T & string]: DefinedRecordKind<T[K]['schema']> } {
  const out: Record<string, DefinedRecordKind> = {}
  for (const [name, spec] of Object.entries(specs)) {
    const secretPaths = collectZodSecretPaths(spec.schema)
    const nameField = spec.entry?.nameField ?? 'name'
    const fields = bodyFieldsOf(spec.schema)
    if (spec.entry !== undefined && !hasNameField(fields, nameField)) {
      throw new DeclarationRefusedError(
        `kind "${name}": an entry kind's schema needs a "${nameField}" field`,
      )
    }
    const parsed = RecordKindDeclarationSchema.parse({
      database: spec.database,
      class: spec.class,
      writeTrigger: spec.writeTrigger,
      device: spec.device,
      at: spec.at,
      indexes: spec.indexes === undefined ? undefined : [...spec.indexes],
      retention: spec.retention,
      deviceRemoval: spec.deviceRemoval,
      maxDataBytes: spec.maxDataBytes,
      secretPaths: [...secretPaths],
      secretArrayKeys: spec.secretArrayKeys === undefined ? undefined : { ...spec.secretArrayKeys },
      transactFamily: spec.transactFamily,
      entry: spec.entry === undefined ? undefined : { title: spec.entry.title, nameField, fields },
    })
    assertValidDeclaration(name, parsed)
    out[name] = { name, schema: spec.schema, declaration: parsed }
  }
  // The keys are the caller's literal keys; the mapped type restates them.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- documented type boundary: `out` is built key-for-key from `specs`
  return out as { [K in keyof T & string]: DefinedRecordKind<T[K]['schema']> }
}

/** The wire form of a package's kinds: name -> declaration. */
export function declarationsOf(
  kinds: Readonly<Record<string, DefinedRecordKind>>,
): Readonly<Record<string, RecordKindDeclaration>> {
  return Object.fromEntries(Object.entries(kinds).map(([name, kind]) => [name, kind.declaration]))
}
