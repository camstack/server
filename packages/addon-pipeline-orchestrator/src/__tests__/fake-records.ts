/**
 * A records world for orchestrator specs: the REAL `ctx.records` facade
 * (`createRecordsAccess`) over an in-memory transport that enforces the same
 * rules the engine does — mirrors the pipeline-analytics equivalent.
 *
 * Nothing is faked between the transport and the facade, so a store that
 * forgot `at`, or filtered on an unindexed field, fails here.  Test-only.
 */
import {
  createRecordsAccess,
  type RecordKindDeclaration,
  type RecordsAccess,
  type RecordsTransport,
  type RecordView,
} from '@camstack/types'
import { orchestratorRecordKinds } from '../record-kinds.js'

interface StoredRow {
  readonly id: string
  readonly at: number | null
  readonly rev: number
  readonly updatedAt: number
  readonly data: Record<string, unknown>
}

export interface FakeRecords {
  readonly records: RecordsAccess
  /** kind -> id -> row, as stored. */
  readonly tables: ReadonlyMap<string, ReadonlyMap<string, StoredRow>>
  /** Seed a row as the engine would have stored it (what an adoption writes). */
  seed(kind: string, row: { id: string; at?: number; data: Record<string, unknown> }): void
  /** Every query the stores sent, in order. */
  readonly queries: readonly { readonly kind: string; readonly limit: number }[]
  /** Make every following write throw (a refused / unreachable engine). */
  failWrites(on: boolean): void
  /** Make every following read throw. */
  failReads(on: boolean): void
}

export function makeFakeRecords(owner = 'pipeline-orchestrator'): FakeRecords {
  const decls = new Map<string, RecordKindDeclaration>()
  const tables = new Map<string, Map<string, StoredRow>>()
  const queries: { kind: string; limit: number }[] = []
  let clock = 1
  let writesFail = false
  let readsFail = false

  const table = (kind: string): Map<string, StoredRow> => {
    let t = tables.get(kind)
    if (t === undefined) {
      t = new Map()
      tables.set(kind, t)
    }
    return t
  }
  const declOf = (kind: string): RecordKindDeclaration => {
    const decl = decls.get(kind)
    if (decl === undefined) throw new Error(`kind "${kind}" is not declared`)
    return decl
  }
  const view = (row: StoredRow): RecordView => ({
    id: row.id,
    deviceId: null,
    at: row.at,
    expiresAt: null,
    rev: row.rev,
    updatedAt: row.updatedAt,
    data: row.data,
  })
  const write = (
    kind: string,
    input: { id: string; at?: number; data: Record<string, unknown> },
  ) => {
    if (writesFail) throw new Error('records engine unreachable')
    const decl = declOf(kind)
    if (decl.at === 'required' && input.at === undefined) {
      throw new Error(`${kind}/${input.id}: the kind needs "at" on every write`)
    }
    const prev = table(kind).get(input.id)
    const rev = (prev?.rev ?? 0) + 1
    clock += 1
    table(kind).set(input.id, {
      id: input.id,
      at: input.at ?? null,
      rev,
      updatedAt: clock,
      data: input.data,
    })
    return rev
  }
  const unimplemented = (op: string): never => {
    throw new Error(`the fake records transport does not implement ${op}`)
  }

  const transport: RecordsTransport = {
    declareKinds: async ({ kinds }) => {
      const out: Record<string, { kindId: number; state: 'created'; createdIndexes: string[] }> = {}
      let n = 0
      for (const [name, decl] of Object.entries(kinds)) {
        decls.set(name, decl)
        n += 1
        out[name] = {
          kindId: n,
          state: 'created',
          createdIndexes: decl.indexes.map((i) => i.name),
        }
      }
      return { kinds: out }
    },
    get: async ({ kind, id }) => {
      if (readsFail) throw new Error('records engine unreachable')
      const row = table(kind).get(id)
      return row === undefined ? null : view(row)
    },
    getMany: async ({ kind, ids }) =>
      ids.flatMap((id) => {
        const row = table(kind).get(id)
        return row === undefined ? [] : [view(row)]
      }),
    secretRefs: async () => ({}),
    put: async ({ kind, record }) => ({
      rev: write(kind, record),
      releasedRefs: [],
    }),
    putMany: async ({ kind, records }) => {
      for (const record of records) write(kind, record)
      return { count: records.length, releasedRefs: [] }
    },
    patch: async () => unimplemented('patch'),
    delete: async ({ kind, id }) => {
      if (writesFail) throw new Error('records engine unreachable')
      return { deleted: table(kind).delete(id), secretRefs: [] }
    },
    deleteMany: async ({ kind, ids }) => {
      let deleted = 0
      for (const id of ids) if (table(kind).delete(id)) deleted += 1
      return { deleted, secretRefs: [] }
    },
    query: async (q) => {
      if (readsFail) throw new Error('records engine unreachable')
      queries.push({ kind: q.kind, limit: q.limit })
      const decl = declOf(q.kind)
      const asked = Object.keys(q.where ?? {})
      if (asked.length > 0) {
        const served = decl.indexes.some((index) => {
          const leading = new Set(index.fields.slice(0, asked.length))
          return asked.length <= index.fields.length && asked.every((f) => leading.has(f))
        })
        if (!served) throw new Error(`${q.kind}: no declared index serves [${asked.join(', ')}]`)
      }
      let rows = [...table(q.kind).values()]
      for (const [field, wanted] of Object.entries(q.where ?? {})) {
        rows = rows.filter((r) => r.data[field] === wanted)
      }
      const byAt = q.order === 'at' || (q.order === undefined && decl.at === 'required')
      rows.sort((a, b) =>
        byAt ? (a.at ?? 0) - (b.at ?? 0) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      )
      if (q.desc === true) rows.reverse()
      const start = q.cursor === undefined ? 0 : Number(q.cursor)
      const page = rows.slice(start, start + q.limit)
      const more = start + q.limit < rows.length
      return {
        records: page.map(view),
        nextCursor: more ? String(start + q.limit) : null,
      }
    },
    count: async ({ kind }) => ({ count: table(kind).size }),
    histogram: async () => unimplemented('histogram'),
    aggregate: async () => unimplemented('aggregate'),
    deleteWhere: async () => unimplemented('deleteWhere'),
    transact: async () => unimplemented('transact'),
    deleteDevice: async () => unimplemented('deleteDevice'),
    allocateId: async () => unimplemented('allocateId'),
  }

  const records = createRecordsAccess({ owner, transport, secrets: null })
  return {
    records,
    tables,
    queries,
    failWrites: (on) => {
      writesFail = on
    },
    failReads: (on) => {
      readsFail = on
    },
    seed: (kind, row) => {
      table(kind).set(row.id, {
        id: row.id,
        at: row.at ?? null,
        rev: 1,
        updatedAt: 1,
        data: row.data,
      })
    },
  }
}

/** The fake with all orchestrator record kinds declared. */
export async function makeOrchestratorRecords(): Promise<FakeRecords> {
  const world = makeFakeRecords()
  await world.records.declare(orchestratorRecordKinds)
  return world
}
