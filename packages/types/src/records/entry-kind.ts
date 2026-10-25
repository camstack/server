/**
 * Entry kinds (D881): every list of user-created entries (notification
 * targets, brokers, LLM profiles) is ONE record kind with an id, a name and a
 * kind-specific body, and the admin UI lists/adds/edits/deletes all of them
 * through the `record-entries` capability with password fields derived from
 * the schema (`.meta({ secret: true })`).
 */
import { z } from 'zod'
import type { RecordIndex, DefinedRecordKind } from './record-kind.js'
import { defineRecordKinds } from './record-kind.js'
import { DeclarationRefusedError } from './errors.js'

/** What an entry kind adds to a bare record kind. */
export interface EntryKindSpec<S extends z.ZodType> {
  /** The title the entries UI shows for the list. */
  readonly title: string
  /** The body: a `name` field plus the kind's own. A discriminated union is fine. */
  readonly schema: S
  readonly writeTrigger?: string
  readonly nameField?: string
  readonly database?: 'settings' | 'events'
  readonly indexes?: readonly RecordIndex[]
  readonly secretArrayKeys?: Readonly<Record<string, string>>
}

/** The body of a plain entry: a name and the fields the kind adds. */
export function entryBody<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.object({ name: z.string().min(1), ...shape })
}

/**
 * Declare one entry kind. An entry is configuration: never trimmed by the
 * engine, never aged, belonging to no device.
 */
export function defineEntryKind<S extends z.ZodType>(
  name: string,
  spec: EntryKindSpec<S>,
): DefinedRecordKind<S> {
  const kinds = defineRecordKinds({
    [name]: {
      schema: spec.schema,
      class: 'config',
      writeTrigger: spec.writeTrigger ?? 'an operator adds or edits an entry in the entries UI',
      retention: { none: 'an entry goes only when the operator deletes it' },
      ...(spec.database === undefined ? {} : { database: spec.database }),
      ...(spec.indexes === undefined ? {} : { indexes: spec.indexes }),
      ...(spec.secretArrayKeys === undefined ? {} : { secretArrayKeys: spec.secretArrayKeys }),
      entry: {
        title: spec.title,
        ...(spec.nameField === undefined ? {} : { nameField: spec.nameField }),
      },
    },
  })
  const defined = kinds[name]
  if (defined === undefined) throw new DeclarationRefusedError(`entry kind "${name}" was not built`)
  // `defineRecordKinds` keyed it by `name`; the schema type is the caller's.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- documented type boundary: built from `spec.schema` one line above
  return defined as DefinedRecordKind<S>
}
