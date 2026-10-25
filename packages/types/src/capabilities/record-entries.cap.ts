import { z } from 'zod'
import { RecordKindNameSchema } from '../records/record-kind.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'
import { RecordBodySchema, RecordIdSchema } from './records.cap.js'

/**
 * record-entries - the ONE admin surface for every list of user-created entries
 * (D881): notification targets, brokers, LLM profiles, anything an addon
 * declares as an ENTRY kind (`entry: { title }` in `defineRecordKinds`).
 *
 * The UI is generic. `listEntryKinds` hands it, per kind, the JSON Schema of
 * the entry body with `secret: true` on every credential field, so a password
 * field is derived from the schema and never from a name. `putEntry` takes the
 * redaction token for an untouched secret (the stored value is kept), a string
 * for a new one, and the clear instruction to remove one. A read never carries
 * a secret value, and a locked keychain refuses the write with
 * `records/secret-unavailable` instead of storing plaintext.
 *
 * Hub-only, served in-process (it acts for each entry's owner on the keychain).
 */

export const EntryKindInfoSchema = z.object({
  owner: z.string(),
  kind: RecordKindNameSchema,
  title: z.string(),
  nameField: z.string(),
  /** JSON Schema of the body; `secret: true` marks a password field. */
  fields: z.record(z.string(), z.unknown()),
  secretPaths: z.array(z.string()),
  rows: z.number().int().nonnegative(),
})
export type EntryKindInfo = z.infer<typeof EntryKindInfoSchema>

export const EntryViewSchema = z.object({
  id: RecordIdSchema,
  name: z.string(),
  rev: z.number().int(),
  updatedAt: z.number(),
  /** Secret fields hold the redaction token. */
  data: RecordBodySchema,
})
export type EntryView = z.infer<typeof EntryViewSchema>

const EntryAddress = { owner: z.string().min(1), kind: RecordKindNameSchema }

export const recordEntriesCapability = {
  name: 'record-entries',
  scope: 'system',
  mode: 'singleton',
  methods: {
    listEntryKinds: method(z.object({}), z.object({ kinds: z.array(EntryKindInfoSchema) }), {
      auth: 'admin',
    }),
    listEntries: method(
      z.object({ ...EntryAddress }),
      z.object({ entries: z.array(EntryViewSchema) }),
      { auth: 'admin' },
    ),
    /** Create (no `id`: one is generated) or edit. `ifRev` guards an edit against a concurrent one. */
    putEntry: method(
      z.object({
        ...EntryAddress,
        id: RecordIdSchema.optional(),
        data: RecordBodySchema,
        ifRev: z.number().int().min(1).optional(),
      }),
      z.object({ id: z.string(), rev: z.number().int() }),
      { kind: 'mutation', auth: 'admin' },
    ),
    deleteEntry: method(
      z.object({ ...EntryAddress, id: RecordIdSchema }),
      z.object({ deleted: z.boolean() }),
      { kind: 'mutation', auth: 'admin' },
    ),
  },
} as const satisfies CapabilityDefinition

export type IRecordEntriesProvider = InferProvider<typeof recordEntriesCapability>
