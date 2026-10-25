/**
 * In-memory `RecordsAccess` for specs. Kinds are declared by the caller.
 * Lives in `@camstack/types` so a spec does not import another package's source.
 *
 * It is the REAL facade (`createRecordsAccess`) over a transport that keeps the
 * engine's contract (`packages/system/src/builtins/sqlite-storage/records/`),
 * refusals included: a `where` no declared index serves, an `in` on a paged
 * query, an `order` next to a `where`, a page that cannot be resumed because
 * its last row has no value for an ordering field, a header the kind forbids,
 * a stale `ifRev`, a unique index, a body over `maxDataBytes`, a plaintext
 * secret. A store that would fail on the engine fails here.
 *
 * `records-in-memory-contract.spec.ts` (in `@camstack/system`) runs the same
 * cases against this world and the real engine so the two cannot drift.
 */
import type { DeclareKindResult, RecordView } from '../capabilities/records.cap.js'
import { RECORD_BATCH_MAX, RECORD_BATCH_MAX_BYTES, RECORD_DELETE_BATCH } from './constants.js'
import {
  BatchTooLargeError,
  FilterRequiredError,
  InvalidRecordError,
  RecordNotFoundError,
  RecordUniqueViolationError,
  RecordTooLargeError,
  RevConflictError,
  UnindexedFilterError,
  UnknownRecordKindError,
} from './errors.js'
import {
  assertValidDeclaration,
  type RecordKindDeclaration,
  RecordKindDeclarationSchema,
} from './record-kind.js'
import { createRecordsAccess, type RecordsAccess, type RecordsTransport } from './records-access.js'
import { assertTransactScope } from './transact-rules.js'
import {
  assertWindowAllowed,
  compareSql,
  extractField,
  inWindow,
  planWhere,
  rowValueAfter,
  type SqlValue,
} from './in-memory-records-plan.js'
import {
  enforceSecrets,
  jsonCopy,
  markersOf,
  mergePatch,
  redactBody,
  serializeBody,
  validateHeader,
} from './in-memory-records-rows.js'

import {
  aggregateOf,
  assertAdditive,
  assertCursor,
  compareKeys,
  type CursorValue,
  decodeCursor,
  encodeCursor,
  HISTOGRAM_MAX_BUCKETS,
  makeSpecKeychain,
  ringBounds,
  TRIM_SLACK,
} from './in-memory-records-support.js'
/** A row as the in-memory engine holds it. `rid` is the insertion order, as the engine's rowid. */
export interface InMemoryStoredRow {
  readonly rid: number
  readonly id: string
  readonly deviceId: number | null
  readonly at: number | null
  readonly expiresAt: number | null
  readonly rev: number
  readonly updatedAt: number
  readonly data: Record<string, unknown>
}

/** A row a spec seeds as the engine would have stored it. */
export interface InMemorySeedRow {
  readonly id: string
  readonly deviceId?: number
  readonly at?: number
  readonly expiresAt?: number
  readonly data: Record<string, unknown>
}

export interface InMemoryRecordsOptions {
  /** The engine's clock (`updated_at`, a ttl's `expires_at`). Default `Date.now`. */
  readonly now?: () => number
}

export interface InMemoryRecords {
  readonly records: RecordsAccess
  /** kind -> id -> row, as stored. */
  readonly tables: ReadonlyMap<string, ReadonlyMap<string, InMemoryStoredRow>>
  /** Every query the owner sent, in order. */
  readonly queries: readonly {
    readonly kind: string
    readonly limit: number
  }[]
  seed(kind: string, row: InMemorySeedRow): void
  /** Make every following write throw (a refused / unreachable engine). */
  failWrites(on: boolean): void
  /** Make every following read throw. */
  failReads(on: boolean): void
}

export function makeInMemoryRecords(
  owner = 'spec',
  options: InMemoryRecordsOptions = {},
): InMemoryRecords {
  const now = options.now ?? Date.now
  const decls = new Map<string, RecordKindDeclaration>()
  const kindIds = new Map<string, number>()
  const tables = new Map<string, Map<string, InMemoryStoredRow>>()
  const sequences = new Map<string, number>()
  const pendingAllocated = new Set<string>()
  const writesSinceTrim = new Map<string, number>()
  const queries: { kind: string; limit: number }[] = []
  let nextRid = 1
  let writesFail = false
  let readsFail = false

  const table = (kind: string): Map<string, InMemoryStoredRow> => {
    let t = tables.get(kind)
    if (t === undefined) {
      t = new Map()
      tables.set(kind, t)
    }
    return t
  }
  const declOf = (kind: string): RecordKindDeclaration => {
    const decl = decls.get(kind)
    if (decl === undefined)
      throw new UnknownRecordKindError(`"${owner}" declared no kind "${kind}"`)
    return decl
  }
  const reading = (): void => {
    if (readsFail) throw new Error('records engine unreachable')
  }
  const writing = (): void => {
    if (writesFail) throw new Error('records engine unreachable')
  }

  const view = (decl: RecordKindDeclaration, row: InMemoryStoredRow): RecordView => ({
    id: row.id,
    deviceId: row.deviceId,
    at: row.at,
    expiresAt: row.expiresAt,
    rev: row.rev,
    updatedAt: row.updatedAt,
    data: redactBody(decl, jsonCopy(row.data)),
  })

  const assertUnique = (
    kind: string,
    decl: RecordKindDeclaration,
    id: string,
    body: Record<string, unknown>,
  ): void => {
    for (const index of decl.indexes) {
      if (index.unique !== true) continue
      const mine = index.fields.map((f) => extractField(body, f))
      if (mine.some((v) => v === null)) continue
      for (const other of table(kind).values()) {
        if (other.id === id) continue
        const theirs = index.fields.map((f) => extractField(other.data, f))
        if (compareKeys(mine, theirs) === 0 && theirs.every((v) => v !== null)) {
          throw new RecordUniqueViolationError(
            `${kind}: the unique index "${index.name}" refused the write`,
          )
        }
      }
    }
  }

  const store = (
    kind: string,
    prev: InMemoryStoredRow | undefined,
    next: Omit<InMemoryStoredRow, 'rid'>,
  ): void => {
    const rid = prev?.rid ?? nextRid
    if (prev === undefined) nextRid += 1
    table(kind).set(next.id, { ...next, rid })
  }

  /** One row of a put / putMany: the engine's `writeRecord`. */
  const writeRecord = (
    kind: string,
    rec: {
      id: string
      deviceId?: number
      at?: number
      expiresAt?: number
      data: Record<string, unknown>
    },
    ifRev: number | undefined,
    nowMs: number,
  ): { readonly rev: number; readonly released: readonly string[] } => {
    const decl = declOf(kind)
    const header = validateHeader(kind, decl, rec, nowMs)
    const allocatedKey = `${kind}:${rec.id}`
    const prev = table(kind).get(rec.id)
    if (pendingAllocated.has(allocatedKey) && prev !== undefined) {
      throw new RevConflictError(
        `${kind}/${rec.id}: an allocated id is insert-only and a row already holds it`,
      )
    }
    if (ifRev !== undefined) {
      if (ifRev === 0 && prev !== undefined) {
        throw new RevConflictError(
          `${kind}/${rec.id}: the row exists (ifRev 0 means "must not exist")`,
        )
      }
      if (ifRev > 0 && prev?.rev !== ifRev) {
        throw new RevConflictError(
          `${kind}/${rec.id}: expected rev ${ifRev}, found ${prev === undefined ? 'no row' : `rev ${prev.rev}`}`,
        )
      }
    }
    const checked = enforceSecrets(owner, kind, decl, rec.id, rec.data, prev?.data ?? null, 'put')
    serializeBody(kind, decl, rec.id, checked.body)
    const body = jsonCopy(checked.body)
    assertUnique(kind, decl, rec.id, body)
    const rev = (prev?.rev ?? 0) + 1
    store(kind, prev, {
      id: header.id,
      deviceId: header.deviceId,
      at: header.at,
      expiresAt: header.expiresAt,
      rev,
      updatedAt: nowMs,
      data: body,
    })
    pendingAllocated.delete(allocatedKey)
    return { rev, released: checked.releasedRefs }
  }

  const trimScope = (kind: string, max: number, deviceId: number | undefined): void => {
    const scope = [...table(kind).values()].filter(
      (r) => deviceId === undefined || r.deviceId === deviceId,
    )
    const excess = Math.min(scope.length - max, RECORD_DELETE_BATCH)
    if (excess <= 0) return
    scope.sort((a, b) => compareKeys([a.at, a.rid], [b.at, b.rid]))
    for (const row of scope.slice(0, excess)) table(kind).delete(row.id)
  }

  /** The engine's ring trim, at the same cadence (once per bound / TRIM_SLACK writes). */
  const afterWrite = (kind: string, devices: readonly (number | undefined)[]): void => {
    const bounds = ringBounds(declOf(kind))
    if (bounds === null) return
    const bound = Math.max(bounds.maxRows ?? 0, bounds.maxRowsPerDevice ?? 0)
    const interval = bound <= TRIM_SLACK ? 1 : Math.floor(bound / TRIM_SLACK)
    const count = (writesSinceTrim.get(kind) ?? 0) + devices.length
    if (count < interval) {
      writesSinceTrim.set(kind, count)
      return
    }
    writesSinceTrim.set(kind, 0)
    if (bounds.maxRows !== undefined) trimScope(kind, bounds.maxRows, undefined)
    if (bounds.maxRowsPerDevice !== undefined) {
      const seen = new Set(devices.filter((d): d is number => d !== undefined))
      for (const device of seen) trimScope(kind, bounds.maxRowsPerDevice, device)
    }
  }

  const refsOf = (decl: RecordKindDeclaration, rows: readonly InMemoryStoredRow[]): string[] =>
    rows.flatMap((row) => [...markersOf(decl, row.data).values()])

  const removeWhere = (
    kind: string,
    test: (row: InMemoryStoredRow) => boolean,
  ): { deleted: number; secretRefs: string[] } => {
    const decl = declOf(kind)
    const gone = [...table(kind).values()].filter(test)
    for (const row of gone) table(kind).delete(row.id)
    return { deleted: gone.length, secretRefs: refsOf(decl, gone) }
  }

  const transport: RecordsTransport = {
    declareKinds: async ({ kinds }) => {
      const out: Record<string, DeclareKindResult> = {}
      for (const [name, raw] of Object.entries(kinds)) {
        const decl = RecordKindDeclarationSchema.parse(raw)
        assertValidDeclaration(name, decl)
        const prior = decls.get(name)
        if (prior !== undefined) assertAdditive(name, prior, decl)
        const kindId = kindIds.get(name) ?? kindIds.size + 1
        kindIds.set(name, kindId)
        const created = decl.indexes
          .filter((i) => prior?.indexes.every((p) => p.name !== i.name) ?? true)
          .map((i) => i.name)
        const state: DeclareKindResult['state'] =
          prior === undefined
            ? 'created'
            : JSON.stringify(prior) === JSON.stringify(decl)
              ? 'unchanged'
              : 'updated'
        decls.set(name, decl)
        out[name] = {
          kindId,
          state,
          createdIndexes: created,
        }
      }
      return { kinds: out }
    },

    get: async ({ kind, id }) => {
      reading()
      const decl = declOf(kind)
      const row = table(kind).get(id)
      return row === undefined ? null : view(decl, row)
    },

    getMany: async ({ kind, ids }) => {
      reading()
      const decl = declOf(kind)
      return [...new Set(ids)]
        .sort((a, b) => compareSql(a, b))
        .flatMap((id) => {
          const row = table(kind).get(id)
          return row === undefined ? [] : [view(decl, row)]
        })
    },

    secretRefs: async ({ kind, ids }) => {
      reading()
      const decl = declOf(kind)
      const out: Record<string, Record<string, string>> = {}
      for (const id of ids) {
        const row = table(kind).get(id)
        if (row === undefined) continue
        const refs = Object.fromEntries(markersOf(decl, row.data))
        if (Object.keys(refs).length > 0) out[id] = refs
      }
      return out
    },

    put: async ({ kind, record, ifRev }) => {
      writing()
      const written = writeRecord(kind, record, ifRev, now())
      afterWrite(kind, [record.deviceId])
      return { rev: written.rev, releasedRefs: [...written.released] }
    },

    putMany: async ({ kind, records }) => {
      writing()
      declOf(kind)
      if (records.length > RECORD_BATCH_MAX) {
        throw new BatchTooLargeError(`${records.length} records exceed ${RECORD_BATCH_MAX}`)
      }
      const bytes = records.reduce(
        (sum, r) => sum + Buffer.byteLength(JSON.stringify(r.data), 'utf8'),
        0,
      )
      if (bytes > RECORD_BATCH_MAX_BYTES) {
        throw new BatchTooLargeError(`${bytes} bytes exceed ${RECORD_BATCH_MAX_BYTES}`)
      }
      const nowMs = now()
      // One transaction: a refused row leaves the kind as it was.
      const before = new Map(table(kind))
      const ridBefore = nextRid
      const released: string[] = []
      try {
        for (const rec of records)
          released.push(...writeRecord(kind, rec, undefined, nowMs).released)
      } catch (err: unknown) {
        tables.set(kind, before)
        nextRid = ridBefore
        throw err
      }
      let top = -1
      for (const r of records) if (/^\d{1,15}$/.test(r.id)) top = Math.max(top, Number(r.id))
      if (top >= 0) sequences.set(kind, Math.max(sequences.get(kind) ?? 0, top + 1))
      afterWrite(
        kind,
        records.map((r) => r.deviceId),
      )
      return { count: records.length, releasedRefs: released }
    },

    patch: async (input) => {
      writing()
      const decl = declOf(input.kind)
      if (input.at !== undefined && decl.at !== 'required') {
        throw new InvalidRecordError(`${input.kind}: declared at: "none"`)
      }
      if (input.at === null) throw new InvalidRecordError(`${input.kind}: "at" cannot be removed`)
      if (input.expiresAt !== undefined && decl.secretPaths.length > 0) {
        throw new InvalidRecordError(
          `${input.kind}: a kind with secret fields cannot expire by the engine (its keychain values would be orphaned)`,
        )
      }
      if (input.expiresAt !== undefined && 'ttlMs' in decl.retention) {
        throw new InvalidRecordError(`${input.kind}: expiresAt is set by the engine`)
      }
      const before = table(input.kind).get(input.id)
      const checked = enforceSecrets(
        owner,
        input.kind,
        decl,
        input.id,
        input.data,
        before?.data ?? null,
        'patch',
      )
      if (before === undefined) {
        throw new RecordNotFoundError(`${input.kind}/${input.id}: no such row`)
      }
      if (input.ifRev !== undefined && before.rev !== input.ifRev) {
        throw new RevConflictError(
          `${input.kind}/${input.id}: expected rev ${String(input.ifRev)}, found rev ${before.rev}`,
        )
      }
      const merged = jsonCopy(mergePatch(before.data, jsonCopy(checked.body)))
      // The engine measures `length(json(data))`: characters, not bytes.
      const size = [...JSON.stringify(merged)].length
      if (size > decl.maxDataBytes) {
        throw new RecordTooLargeError(
          `${input.kind}/${input.id}: the patched body is ${size} bytes, over maxDataBytes ${decl.maxDataBytes}`,
        )
      }
      assertUnique(input.kind, decl, input.id, merged)
      const rev = before.rev + 1
      store(input.kind, before, {
        ...before,
        at: input.at ?? before.at,
        expiresAt: input.expiresAt === undefined ? before.expiresAt : input.expiresAt,
        rev,
        updatedAt: now(),
        data: merged,
      })
      const kept = new Set(markersOf(decl, merged).values())
      const released = [...markersOf(decl, before.data).values()].filter((r) => !kept.has(r))
      return { rev, releasedRefs: released }
    },

    delete: async ({ kind, id }) => {
      writing()
      const decl = declOf(kind)
      const row = table(kind).get(id)
      if (row === undefined) return { deleted: false, secretRefs: [] }
      table(kind).delete(id)
      return { deleted: true, secretRefs: refsOf(decl, [row]) }
    },

    deleteMany: async ({ kind, ids }) => {
      writing()
      const wanted = new Set(ids)
      return removeWhere(kind, (row) => wanted.has(row.id))
    },

    query: async (q) => {
      reading()
      const decl = declOf(q.kind)
      queries.push({ kind: q.kind, limit: q.limit })
      assertWindowAllowed(q.kind, decl, q)
      const desc = q.desc === true
      const dir = desc ? 'DESC' : 'ASC'
      const where = planWhere(q.kind, decl, q.where, { allowIn: false })
      const cursor = q.cursor === undefined ? undefined : decodeCursor(q.cursor)
      let rows = [...table(q.kind).values()].filter((r) => inWindow(r, q))
      let keysOf: (row: InMemoryStoredRow) => SqlValue[]
      let keyCount: number
      let tag: string
      if (where !== null) {
        if (q.order !== undefined) {
          throw new InvalidRecordError(
            `${q.kind}: with a where the order is the index's; drop "order"`,
          )
        }
        const fields = where.orderFields
        keysOf = (row) => [...fields.map((f) => extractField(row.data, f)), row.rid]
        keyCount = fields.length
        tag = `rx:${where.indexName}:${dir}`
        rows = rows.filter((r) => where.matches(r.data))
        if (cursor !== undefined) {
          assertCursor(cursor, tag, fields.length + 1)
          rows = rows.filter((r) => rowValueAfter(keysOf(r), cursor.values, desc))
        }
      } else {
        const order = q.order ?? (decl.at === 'required' ? 'at' : 'id')
        keyCount = 1
        if (order === 'at') {
          if (decl.at !== 'required') {
            throw new InvalidRecordError(
              `${q.kind}: declared at: "none", it has no time order - use order: "id"`,
            )
          }
          keysOf = (row) => [row.at, row.rid]
          tag = `at:${dir}`
          if (cursor !== undefined) {
            assertCursor(cursor, tag, 2)
            rows = rows.filter((r) => rowValueAfter(keysOf(r), cursor.values, desc))
          }
        } else {
          if (q.deviceId !== undefined || q.atFrom !== undefined || q.atTo !== undefined) {
            throw new UnindexedFilterError(
              `${q.kind}: order "id" cannot be combined with a device or time window (use order "at")`,
            )
          }
          keysOf = (row) => [row.id, row.rid]
          tag = `id:${dir}`
          if (cursor !== undefined) {
            assertCursor(cursor, tag, 2)
            const last = cursor.values[0] ?? null
            rows = rows.filter((r) => rowValueAfter([r.id], [last], desc))
          }
        }
      }
      rows.sort((a, b) => (desc ? -1 : 1) * compareKeys(keysOf(a), keysOf(b)))
      const page = rows.slice(0, q.limit)
      const more = rows.length > q.limit
      const last = page.at(-1)
      let nextCursor: string | null = null
      if (more && last !== undefined) {
        const all = keysOf(last)
        const keys: CursorValue[] = []
        for (let i = 0; i < keyCount; i += 1) {
          const value = all[i]
          if (typeof value !== 'string' && typeof value !== 'number') {
            throw new InvalidRecordError(
              `${q.kind}: a row has no value for an ordering field, so this query cannot be paged`,
            )
          }
          keys.push(value)
        }
        keys.push(last.rid)
        nextCursor = encodeCursor(tag, keys)
      }
      return { records: page.map((r) => view(decl, r)), nextCursor }
    },

    count: async (q) => {
      reading()
      const decl = declOf(q.kind)
      assertWindowAllowed(q.kind, decl, q)
      const where = planWhere(q.kind, decl, q.where, { allowIn: true })
      let n = 0
      for (const row of table(q.kind).values()) {
        if (inWindow(row, q) && (where === null || where.matches(row.data))) n += 1
      }
      return { count: n }
    },

    histogram: async (q) => {
      reading()
      const decl = declOf(q.kind)
      assertWindowAllowed(q.kind, decl, {
        deviceId: q.deviceId,
        atFrom: q.from,
      })
      if (!(q.to > q.from)) throw new InvalidRecordError(`${q.kind}: histogram needs from < to`)
      if (Math.ceil((q.to - q.from) / q.bucketMs) > HISTOGRAM_MAX_BUCKETS) {
        throw new InvalidRecordError(
          `${q.kind}: histogram would exceed ${HISTOGRAM_MAX_BUCKETS} buckets`,
        )
      }
      const from = Math.floor(q.from)
      const to = Math.ceil(q.to)
      const step = Math.trunc(q.bucketMs)
      const counts = new Map<number, number>()
      for (const row of table(q.kind).values()) {
        if (q.deviceId !== undefined && row.deviceId !== q.deviceId) continue
        if (row.at === null || row.at < from || row.at >= to) continue
        const b = Math.trunc((row.at - from) / step)
        counts.set(b, (counts.get(b) ?? 0) + 1)
      }
      return {
        buckets: [...counts.entries()]
          .sort(([a], [b]) => a - b)
          .map(([b, count]) => ({ bucketStart: from + b * q.bucketMs, count })),
      }
    },

    aggregate: async (q) => {
      reading()
      const decl = declOf(q.kind)
      if (q.op !== 'count' && q.field === undefined) {
        throw new InvalidRecordError(`${q.kind}: ${q.op} needs a field`)
      }
      const extra = [q.field, q.groupBy].filter((f): f is string => f !== undefined)
      if (extra.length === 0 && q.where === undefined) {
        throw new InvalidRecordError(`${q.kind}: a count with no field and no groupBy is "count"`)
      }
      const where = planWhere(q.kind, decl, q.where, {
        allowIn: true,
        extraFields: extra,
        groupBy: q.groupBy,
      })
      if (where === null) throw new InvalidRecordError(`${q.kind}: aggregate has nothing to read`)
      const rows = [...table(q.kind).values()].filter((r) => where.matches(r.data))
      const groups = new Map<SqlValue, InMemoryStoredRow[]>()
      if (q.groupBy === undefined) groups.set(null, rows)
      else {
        const by = q.groupBy
        for (const row of rows) {
          const g = extractField(row.data, by)
          groups.set(g, [...(groups.get(g) ?? []), row])
        }
      }
      const out = [...groups.entries()]
        .sort(([a], [b]) => compareSql(a, b))
        .map(([group, members]) => ({
          group,
          value: aggregateOf(q.op, q.field, members),
        }))
      return { rows: out }
    },

    deleteWhere: async (q) => {
      writing()
      const decl = declOf(q.kind)
      if (
        q.deviceId === undefined &&
        q.atBefore === undefined &&
        (q.where === undefined || Object.keys(q.where).length === 0)
      ) {
        throw new FilterRequiredError(
          `${q.kind}: deleteWhere needs deviceId, atBefore or where - there is no "delete all"`,
        )
      }
      assertWindowAllowed(q.kind, decl, {
        deviceId: q.deviceId,
        atFrom: q.atBefore,
      })
      const where = planWhere(q.kind, decl, q.where, { allowIn: true })
      return removeWhere(q.kind, (row) => {
        if (where !== null && !where.matches(row.data)) return false
        if (q.deviceId !== undefined && row.deviceId !== q.deviceId) return false
        if (q.atBefore !== undefined && (row.at === null || row.at >= q.atBefore)) return false
        return true
      })
    },

    transact: async ({ ops }) => {
      writing()
      assertTransactScope(ops.map((op) => ({ kind: op.kind, declaration: declOf(op.kind) })))
      // All or nothing: rows are replaced, never mutated, so a copy of each table restores it.
      const before = new Map([...tables].map(([name, rows]) => [name, new Map(rows)] as const))
      const ridBefore = nextRid
      const results: { rev: number | null; deleted: boolean }[] = []
      const releasedRefs: string[] = []
      const secretRefs: string[] = []
      try {
        for (const op of ops) {
          if (op.op === 'put') {
            const r = await transport.put({
              kind: op.kind,
              record: op.record,
              ...(op.ifRev === undefined ? {} : { ifRev: op.ifRev }),
            })
            releasedRefs.push(...r.releasedRefs)
            results.push({ rev: r.rev, deleted: false })
          } else if (op.op === 'patch') {
            const r = await transport.patch({
              kind: op.kind,
              id: op.id,
              data: op.data,
              ...(op.at === undefined ? {} : { at: op.at }),
              ...(op.expiresAt === undefined ? {} : { expiresAt: op.expiresAt }),
              ...(op.ifRev === undefined ? {} : { ifRev: op.ifRev }),
            })
            releasedRefs.push(...r.releasedRefs)
            results.push({ rev: r.rev, deleted: false })
          } else {
            const r = await transport.delete({ kind: op.kind, id: op.id })
            secretRefs.push(...r.secretRefs)
            results.push({ rev: null, deleted: r.deleted })
          }
        }
      } catch (err: unknown) {
        tables.clear()
        for (const [name, rows] of before) tables.set(name, rows)
        nextRid = ridBefore
        throw err
      }
      return { results, releasedRefs, secretRefs }
    },

    deleteDevice: async ({ deviceId, kinds }) => {
      writing()
      const deleted: Record<string, number> = {}
      const secretRefs: string[] = []
      for (const [kind, decl] of decls) {
        if (decl.deviceRemoval !== 'delete') continue
        if (kinds !== undefined && !kinds.includes(kind)) continue
        const result = removeWhere(kind, (row) => row.deviceId === deviceId)
        deleted[kind] = result.deleted
        secretRefs.push(...result.secretRefs)
      }
      return { deleted, secretRefs }
    },

    allocateId: async ({ kind }) => {
      writing()
      declOf(kind)
      const id = sequences.get(kind) ?? 1
      sequences.set(kind, id + 1)
      pendingAllocated.add(`${kind}:${id}`)
      return { id }
    },
  }

  const keychain = makeSpecKeychain(owner)
  const records = createRecordsAccess({
    owner,
    transport,
    secrets: keychain.access,
  })
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
      const prev = table(kind).get(row.id)
      store(kind, prev, {
        id: row.id,
        deviceId: row.deviceId ?? null,
        at: row.at ?? null,
        expiresAt: row.expiresAt ?? null,
        rev: 1,
        updatedAt: 1,
        data: jsonCopy(row.data),
      })
    },
  }
}
