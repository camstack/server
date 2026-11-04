/**
 * Flatten the nested connection of an entry kind's records (D987, planning#408 P3).
 *
 * A broker record used to keep its connection in ONE nested object (`auth`, `connection`) with the
 * secrets inside it; the instances form edits a flat body whose secrets sit at the top level. This
 * procedure moves every row under the SAME id:
 *
 *  1. Phase A, read only: resolve every nested secret of every row from the keychain. A secret that
 *     cannot be read throws, naming the row, before anything is written.
 *  2. Phase B, per row: patch the flat fields in (the nested object is still there), read each flat
 *     secret back from its NEW home, and only when all match patch the nested object out (`null`,
 *     RFC 7396); the old nested refs are then deleted here (the door only releases declared paths). A mismatch undoes
 *     the flat fields and throws: a row is flat or untouched, never between.
 *
 * Idempotent: a row without the nested key is skipped; a crash between the two patches reruns both.
 * After it no code reads the nested shape.
 */
import { isSecretMarker } from '../keychain/secret-marker.js'
import type { SecretsAccess } from '../keychain/secrets-access.js'
import type { RecordKindHandle } from '../records/records-access.js'
import type { MigrationProcedureResult } from './migration.js'

export interface FlattenRowPorts {
  /** Every row of the kind as stored: a nested secret is still a keychain marker. */
  listRaw(): Promise<
    readonly { readonly id: string; readonly data: Readonly<Record<string, unknown>> }[]
  >
  /** Value per ref; `undefined` when the keychain does not answer it. */
  resolve(refs: readonly string[]): Promise<Readonly<Record<string, string | undefined>>>
  /** RFC 7396 patch of one row through the records door. */
  patch(id: string, patch: Readonly<Record<string, unknown>>): Promise<void>
  /**
   * Remove keychain refs. The records door releases only the refs of the kind's DECLARED secret
   * paths, so the refs of the retired nested paths are removed here, once the row no longer
   * points at them.
   */
  deleteRefs(refs: readonly string[]): Promise<void>
  /** The flat secret fields of one row as the door resolves them now. */
  readFlatSecrets(
    id: string,
    keys: readonly string[],
  ): Promise<Readonly<Record<string, string | undefined>>>
}

export interface FlattenSpec {
  /** The nested key to remove (`auth`, `connection`). */
  readonly legacyKey: string
  /** Top-level secret keys of the flat body. */
  readonly flatSecretKeys: readonly string[]
  /** The flat fields for a row, from its nested object with secrets resolved. */
  toFlat(
    legacy: Readonly<Record<string, unknown>>,
    row: Readonly<Record<string, unknown>>,
  ): Readonly<Record<string, unknown>>
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function markerRefs(value: unknown, into: string[]): void {
  if (isSecretMarker(value)) {
    into.push(value.$secret)
  } else if (isPlain(value)) {
    for (const v of Object.values(value)) markerRefs(v, into)
  } else if (Array.isArray(value)) {
    for (const v of value) markerRefs(v, into)
  }
}

function withValues(value: unknown, values: Readonly<Record<string, string>>): unknown {
  if (isSecretMarker(value)) return values[value.$secret] ?? ''
  if (isPlain(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withValues(v, values)]))
  }
  if (Array.isArray(value)) return value.map((v) => withValues(v, values))
  return value
}

export async function flattenNestedRecords(
  ports: FlattenRowPorts,
  spec: FlattenSpec,
): Promise<MigrationProcedureResult> {
  const rows = (await ports.listRaw()).filter((row) => spec.legacyKey in row.data)
  if (rows.length === 0) return { outcome: 'already-done', summary: { converted: 0 } }

  // Phase A: nothing is written until every nested secret has been read.
  const refs: string[] = []
  for (const row of rows) markerRefs(row.data[spec.legacyKey], refs)
  const answers = refs.length === 0 ? {} : await ports.resolve(refs)
  const resolved: Record<string, string> = {}
  for (const row of rows) {
    const own: string[] = []
    markerRefs(row.data[spec.legacyKey], own)
    for (const ref of own) {
      const value = answers[ref]
      if (value === undefined) {
        throw new Error(
          `record '${row.id}': a secret of '${spec.legacyKey}' cannot be read - nothing moved`,
        )
      }
      resolved[ref] = value
    }
  }

  // Phase B: flat in, read back, nested out.
  for (const row of rows) {
    const legacy = withValues(row.data[spec.legacyKey], resolved)
    if (!isPlain(legacy)) {
      throw new Error(`record '${row.id}': '${spec.legacyKey}' is not an object - nothing moved`)
    }
    const flat = spec.toFlat(legacy, row.data)
    await ports.patch(row.id, flat)
    const back = await ports.readFlatSecrets(row.id, spec.flatSecretKeys)
    const wrong = spec.flatSecretKeys.filter((key) => {
      const sent = flat[key]
      return (typeof sent === 'string' ? sent : '') !== (back[key] ?? '')
    })
    if (wrong.length > 0) {
      await ports.patch(
        row.id,
        Object.fromEntries(Object.keys(flat).map((key): [string, null] => [key, null])),
      )
      throw new Error(
        `record '${row.id}': ${wrong.join(', ')} did not read back from its new home - the row is unchanged`,
      )
    }
    await ports.patch(row.id, { [spec.legacyKey]: null })
    const retired: string[] = []
    markerRefs(row.data[spec.legacyKey], retired)
    if (retired.length > 0) await ports.deleteRefs(retired)
  }
  return { outcome: 'done', summary: { converted: rows.length } }
}

/** The ports over one kind's records handle and the addon's keychain handle. */
export function flattenPortsOver<T extends Record<string, unknown>>(
  handle: RecordKindHandle<T>,
  secrets: Pick<SecretsAccess, 'resolve' | 'delete'>,
): FlattenRowPorts {
  return {
    listRaw: async () =>
      (await handle.query({ limit: 1000 })).records.map((r) => ({ id: r.id, data: r.data })),
    resolve: async (refs) => {
      const answers = await secrets.resolve(refs)
      return Object.fromEntries(
        refs.map((ref): [string, string | undefined] => {
          const answer = answers[ref]
          return [ref, answer?.kind === 'value' ? answer.value : undefined]
        }),
      )
    },
    patch: async (id, patch) => {
      await handle.patch(id, patch)
    },
    deleteRefs: async (refs) => {
      await secrets.delete(refs)
    },
    readFlatSecrets: async (id, keys) => {
      const row = await handle.getResolved(id)
      const data: Record<string, unknown> = row?.data ?? {}
      return Object.fromEntries(
        keys.map((key): [string, string | undefined] => {
          const value = data[key]
          return [key, typeof value === 'string' ? value : undefined]
        }),
      )
    },
  }
}
