import type { DefinedRecordKind, MigrationApiV1, MigrationRecordsKindV1 } from '@camstack/types'
import type { z } from 'zod'

/** One record kind as the migrations call it: positional ids, the row carries `id` and `data`. */
export interface PositionalHandle<T> {
  get(id: string): Promise<{ readonly id: string; readonly data: T } | null>
  getResolved(id: string): Promise<{ readonly id: string; readonly data: T } | null>
  put(
    input: { readonly id: string; readonly data: T },
    opts?: { readonly ifRev?: number },
  ): Promise<unknown>
  patch(id: string, partial: Readonly<Record<string, unknown>>): Promise<unknown>
  delete(id: string): Promise<unknown>
  query(q: { readonly limit: number }): Promise<{
    readonly records: readonly { readonly id: string; readonly data: T }[]
  }>
}

/** Bind a kind by definition. `ctx.records` and the migration API (through {@link positionalRecordsOver}) both fit. */
export interface PositionalRecordsDoor {
  kind<S extends z.ZodType>(definition: DefinedRecordKind<S>): PositionalHandle<z.infer<S>>
}

function positionalHandleOver<T>(handle: MigrationRecordsKindV1<T>): PositionalHandle<T> {
  return {
    get: (id) => handle.get({ id }),
    getResolved: (id) => handle.getResolved({ id }),
    put: (input, opts) =>
      handle.put({
        ...input,
        ...(opts?.ifRev === undefined ? {} : { ifRev: opts.ifRev }),
      }),
    patch: (id, partial) => handle.patch({ id, partial }),
    delete: (id) => handle.delete({ id }),
    query: ({ limit }) => handle.query({ limit }),
  }
}

/** The records door of the migration API, in the shape the migrations call. */
export function positionalRecordsOver(api: Pick<MigrationApiV1, 'records'>): PositionalRecordsDoor {
  return {
    kind: (definition) => positionalHandleOver(api.records.kind(definition)),
  }
}
