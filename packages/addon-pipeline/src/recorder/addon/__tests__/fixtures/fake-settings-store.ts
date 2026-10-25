/**
 * A settings store that actually honours `columns`, `whereIn` and `limit`.
 *
 * The fakes this replaces returned every row of the table for every query and
 * ignored the projection entirely — which is exactly the shape of test that
 * cannot fail when the production code stops asking for a projection, or asks
 * for the wrong one. D287's whole claim is *what boot does not read*, so the
 * fake has to be able to say no.
 *
 * It also records every query, because "the outcome was right" is a weaker
 * assertion than "the statement was right": a boot that fetched `paths` and
 * then discarded them in JS would pass an outcome test and still be the OOM.
 */
import type { SettingsStoreClient } from '@camstack/types'

export interface FakeQuery {
  readonly collection: string
  readonly columns?: readonly string[]
  readonly filter?: FakeQueryFilter
}

export interface FakeQueryFilter {
  readonly where?: Readonly<Record<string, unknown>>
  readonly whereIn?: Readonly<Record<string, readonly unknown[]>>
  readonly orderBy?: FakeOrderBy
  readonly limit?: number
  readonly offset?: number
}

export interface FakeOrderBy {
  readonly field: string
  readonly direction: 'asc' | 'desc'
}

export interface FakeRecord {
  readonly id: string
  readonly data: Record<string, unknown>
}

/** The handle a test drives: the client itself, what it was asked, and a
 *  switch that makes reads fail so the failure DIRECTION can be pinned. */
export interface FakeSettingsStore {
  readonly store: SettingsStoreClient
  /** Every `query` this store answered (or refused), in order. */
  readonly queries: FakeQuery[]
  /** Every `set` key, in order — a write nobody expected is a regression. */
  readonly writes: string[]
  /** Every `delete` key, in order. */
  readonly deletes: string[]
  /** While true, every `query` REJECTS. */
  failQueries: boolean
  /**
   * Answer this many more queries, then reject every one after them.
   *
   * A read that dies HALFWAY is a different fault from a read that never
   * starts, and it is the one that produces a mirror which half knows what it
   * holds. `null` disables it.
   */
  failAfter: number | null
  /** Rows currently in a collection, as the store holds them. */
  rows(collection: string): readonly FakeRecord[]
}

function matchesWhere(
  data: Record<string, unknown>,
  where: Readonly<Record<string, unknown>>,
): boolean {
  for (const [field, value] of Object.entries(where)) {
    if (data[field] !== value) return false
  }
  return true
}

function matchesWhereIn(
  id: string,
  data: Record<string, unknown>,
  whereIn: Readonly<Record<string, readonly unknown[]>>,
): boolean {
  for (const [field, values] of Object.entries(whereIn)) {
    // The primary key is not a column of `data` — it is the record id.
    const actual = field === 'key' ? id : data[field]
    if (!values.includes(actual)) return false
  }
  return true
}

function project(record: FakeRecord, columns: readonly string[] | undefined): FakeRecord {
  if (columns === undefined) return record
  const data: Record<string, unknown> = {}
  for (const column of columns) {
    if (column in record.data) data[column] = record.data[column]
  }
  return { id: record.id, data }
}

export function fakeSettingsStore(): FakeSettingsStore {
  const tables = new Map<string, Map<string, Record<string, unknown>>>()
  const queries: FakeQuery[] = []
  const writes: string[] = []
  const deletes: string[] = []
  const ensure = (collection: string): Map<string, Record<string, unknown>> => {
    let table = tables.get(collection)
    if (!table) {
      table = new Map()
      tables.set(collection, table)
    }
    return table
  }

  const handle: FakeSettingsStore = {
    queries,
    writes,
    deletes,
    failQueries: false,
    failAfter: null,
    rows: (collection) =>
      [...(tables.get(collection)?.entries() ?? [])].map(([id, data]) => ({ id, data })),
    store: {
      declareCollection: {
        mutate: async (input: { collection: string }): Promise<void> => {
          ensure(input.collection)
        },
      },
      set: {
        mutate: async (input: {
          collection: string
          key: string
          value: Record<string, unknown>
        }): Promise<void> => {
          writes.push(input.key)
          ensure(input.collection).set(input.key, input.value)
        },
      },
      delete: {
        mutate: async (input: { collection: string; key: string }): Promise<void> => {
          deletes.push(input.key)
          tables.get(input.collection)?.delete(input.key)
        },
      },
      query: {
        query: async (input: FakeQuery): Promise<readonly FakeRecord[]> => {
          queries.push(input)
          if (handle.failQueries) throw new Error('fake settings store: reads are down')
          if (handle.failAfter !== null) {
            if (handle.failAfter <= 0) throw new Error('fake settings store: read died mid-stream')
            handle.failAfter -= 1
          }
          let rows: FakeRecord[] = [...(tables.get(input.collection)?.entries() ?? [])].map(
            ([id, data]) => ({ id, data }),
          )
          const filter = input.filter
          if (filter?.where !== undefined) {
            const where = filter.where
            rows = rows.filter((row) => matchesWhere(row.data, where))
          }
          if (filter?.whereIn !== undefined) {
            const whereIn = filter.whereIn
            rows = rows.filter((row) => matchesWhereIn(row.id, row.data, whereIn))
          }
          if (filter?.orderBy !== undefined) {
            const { field, direction } = filter.orderBy
            const sign = direction === 'desc' ? -1 : 1
            rows = rows.toSorted((a, b) => sign * (Number(a.data[field]) - Number(b.data[field])))
          }
          const offset = filter?.offset ?? 0
          const limit = filter?.limit
          rows = rows.slice(offset, limit === undefined ? undefined : offset + limit)
          return rows.map((row) => project(row, input.columns))
        },
      },
      // A documented type boundary: `SettingsStoreClient` is the whole tRPC
      // surface and the hour ledger uses four of its methods. Implementing the
      // rest as stubs would be a fake that answers questions nobody asked;
      // reaching for one of them should be a loud failure.
    } as unknown as SettingsStoreClient,
  }
  return handle
}
