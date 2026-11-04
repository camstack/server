/**
 * Flatten the nested connection of an entry kind's records (D987, planning#408 P3).
 *
 * A broker record used to keep its connection in ONE nested object (`auth`, `connection`) with the
 * secrets inside it; the instances form edits a flat body whose secrets sit at the top level. This
 * procedure moves every row under the SAME id. The kind keeps the nested secret paths declared
 * (`retiredSecretPaths`; the engine never lets a path stop being secret), so the records door still
 * serves the nested secrets resolved and still releases their keychain refs when the nested object
 * goes:
 *
 *  1. Phase A, read only: resolve the nested object of every row through the door. A secret that
 *     cannot be read throws, naming the row, before anything is written.
 *  2. Phase B, per row: patch the flat fields in (the nested object is still there), read each flat
 *     secret back from its NEW home, and only when all match patch the nested object out (`null`,
 *     RFC 7396); the door releases the nested refs in that same call. A mismatch undoes the flat
 *     fields and throws: a row is flat or untouched, never between.
 *
 * Idempotent: a row without the nested key is skipped. A crash before the last patch leaves the
 * nested object and its refs intact, so the rerun redoes the row; a crash cannot strand refs that
 * nothing points at, because the pointer and the refs leave together.
 */
import type { RecordKindHandle } from '../records/records-access.js'
import type { MigrationProcedureResult } from './migration.js'

export interface FlattenRowPorts {
  /** Ids of the rows that still carry the nested key. */
  listNested(legacyKey: string): Promise<readonly string[]>
  /** The row as stored with every secret resolved; throws when one cannot be served. */
  readResolved(id: string): Promise<Readonly<Record<string, unknown>>>
  /** RFC 7396 patch of one row through the records door. */
  patch(id: string, patch: Readonly<Record<string, unknown>>): Promise<void>
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

export async function flattenNestedRecords(
  ports: FlattenRowPorts,
  spec: FlattenSpec,
): Promise<MigrationProcedureResult> {
  const ids = await ports.listNested(spec.legacyKey)
  if (ids.length === 0) return { outcome: 'already-done', summary: { converted: 0 } }

  // Phase A: nothing is written until every row has been read, secrets included.
  const rows = new Map<string, Readonly<Record<string, unknown>>>()
  for (const id of ids) {
    try {
      rows.set(id, await ports.readResolved(id))
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      throw new Error(`record '${id}': cannot be read with its secrets (${why}) - nothing moved`)
    }
  }

  // Phase B: flat in, read back, nested out.
  for (const [id, row] of rows) {
    const legacy = row[spec.legacyKey]
    if (!isPlain(legacy)) {
      throw new Error(`record '${id}': '${spec.legacyKey}' is not an object - nothing moved`)
    }
    const flat = spec.toFlat(legacy, row)
    await ports.patch(id, flat)
    const back = await ports.readResolved(id)
    const wrong = spec.flatSecretKeys.filter((key) => {
      const sent = flat[key]
      const got = back[key]
      return (typeof sent === 'string' ? sent : '') !== (typeof got === 'string' ? got : '')
    })
    if (wrong.length > 0) {
      await ports.patch(
        id,
        Object.fromEntries(Object.keys(flat).map((key): [string, null] => [key, null])),
      )
      throw new Error(
        `record '${id}': ${wrong.join(', ')} did not read back from its new home - the row is unchanged`,
      )
    }
    await ports.patch(id, { [spec.legacyKey]: null })
  }
  return { outcome: 'done', summary: { converted: rows.size } }
}

/** The ports over one kind's records handle. */
export function flattenPortsOver<T extends Record<string, unknown>>(
  handle: RecordKindHandle<T>,
): FlattenRowPorts {
  return {
    listNested: async (legacyKey) =>
      (await handle.query({ limit: 1000 })).records
        .filter((r) => legacyKey in r.data)
        .map((r) => r.id),
    readResolved: async (id) => {
      const row = await handle.getResolved(id)
      if (row === null) throw new Error('the record is gone')
      return row.data
    },
    patch: async (id, patch) => {
      await handle.patch(id, patch)
    },
  }
}
