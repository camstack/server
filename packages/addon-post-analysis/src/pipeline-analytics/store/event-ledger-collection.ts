/**
 * One event ledger (motion, audio, sensor, faces, plates …) over its
 * `ctx.records` kind. Every node has `ctx.records`, so there is no other path.
 */
import {
  type DefinedRecordKind,
  InvalidRecordError,
  type IScopedLogger,
  type MutationFilter,
  type PreparedTransactOp,
  type RecordKindHandle,
  type RecordWhere,
  type RecordsAccess,
  type TransactOpResult,
} from '@camstack/types'
/** Matches {@link EventStore.LEDGER_PAGE_SIZE} — kept local to avoid a circular import. */
const LEDGER_PAGE_SIZE = 500

/** The row's clock field, mapped to the record header's `at`. */
export type EventLedgerLegacyAtField =
  | 'timestamp'
  | 'at'
  | 'archivedAt'
  | 'createdAt'
  | 'updatedAt'
  | 'copiedAt'
  | 'addedAt'

export interface EventLedgerRow {
  readonly id: string
  readonly data: Record<string, unknown>
}

/** One keyset page of {@link EventLedgerCollection.pageById}. */
export interface EventLedgerPage {
  readonly rows: readonly EventLedgerRow[]
  readonly nextCursor: string | null
}

/**
 * A field the ledger derives from what a write says, so no caller can forget
 * it: `put` gets a whole row, `patch` a merge patch (RFC 7396).
 */
export type EventLedgerBodyDerivation = (
  body: Record<string, unknown>,
  mode: 'put' | 'patch',
) => Record<string, unknown>

export interface EventLedgerCollectionDeps {
  readonly collection: string
  readonly records: Pick<RecordsAccess, 'kind' | 'transact'>
  readonly definition: DefinedRecordKind
  readonly kindName: string
  readonly autoIntegerId: boolean
  /** Legacy clock column; stored as record `at`. Default `timestamp`. */
  readonly legacyAtField?: EventLedgerLegacyAtField
  /** When `optional`, rows without `deviceId` are allowed. */
  readonly deviceIdMode?: 'required' | 'optional'
  readonly logger?: IScopedLogger
  /** Applied to every row written and every patch sent — the ledger's one write door. */
  readonly deriveBody?: EventLedgerBodyDerivation
}

export class EventLedgerCollection {
  private readonly collection: string
  private readonly kind: RecordKindHandle<Record<string, unknown>>
  private readonly records: Pick<RecordsAccess, 'transact'>
  private readonly autoIntegerId: boolean
  private readonly legacyAtField: EventLedgerLegacyAtField
  private readonly deviceIdMode: 'required' | 'optional'
  private readonly logger: IScopedLogger | undefined
  private readonly deriveBody: EventLedgerBodyDerivation | undefined
  /** The field lists of the kind's declared indexes, for {@link legacyFilterToRecordsQuery}. */
  private readonly indexFields: readonly (readonly string[])[]

  private constructor(deps: EventLedgerCollectionDeps) {
    this.collection = deps.collection
    this.autoIntegerId = deps.autoIntegerId
    this.legacyAtField = deps.legacyAtField ?? 'timestamp'
    this.deviceIdMode = deps.deviceIdMode ?? 'required'
    this.logger = deps.logger
    this.deriveBody = deps.deriveBody
    this.indexFields = deps.definition.declaration.indexes.map((i) => i.fields)
    this.records = deps.records
    const handle = deps.records.kind(deps.definition)
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- documented type boundary: per-kind Zod bodies; ledger IO is dynamic JSON
    this.kind = handle as RecordKindHandle<Record<string, unknown>>
  }

  static create(deps: EventLedgerCollectionDeps): EventLedgerCollection {
    return new EventLedgerCollection(deps)
  }

  /** Upsert by explicit id (faces, plates, sensor events). */
  async upsertRow(id: string, value: Record<string, unknown>): Promise<void> {
    const put = this.buildRecordPut(id, value)
    if (put === null) {
      this.logger?.warn('event ledger upsert refused — record could not be mapped', {
        meta: { collection: this.collection, id },
      })
      return
    }
    await this.kind.put(put)
  }

  /**
   * `upsertRow` as an op of {@link EventLedgerCollection.transact}. A row that
   * cannot be mapped THROWS here: inside a transaction a silently skipped write
   * would let the rest of the call commit without it.
   */
  async txUpsert(id: string, value: Record<string, unknown>): Promise<PreparedTransactOp> {
    const put = this.buildRecordPut(id, value)
    if (put === null) {
      throw new InvalidRecordError(`${this.collection}/${id}: the record could not be mapped`)
    }
    return this.kind.txPut(put)
  }

  /** `update` as an op of {@link EventLedgerCollection.transact}. */
  txUpdate(id: string, patch: Record<string, unknown>): Promise<PreparedTransactOp> {
    return this.kind.txPatch(id, this.derived(patch, 'patch'))
  }

  /** `deleteKey` as an op of {@link EventLedgerCollection.transact}. */
  txDelete(id: string): PreparedTransactOp {
    return this.kind.txDelete(id)
  }

  /**
   * Run ops (built by the `tx*` methods of ledgers whose kinds share a
   * `transactFamily`) in ONE transaction: all land or none does.
   */
  transact(ops: readonly PreparedTransactOp[]): Promise<readonly TransactOpResult[]> {
    return this.records.transact(ops)
  }

  async insert(record: Record<string, unknown>): Promise<string | number | null> {
    const idNum = this.autoIntegerId ? await this.kind.allocateId() : null
    const id =
      idNum !== null ? String(idNum) : typeof record['id'] === 'string' ? record['id'] : null
    if (id === null) return null
    const put = this.buildRecordPut(id, record)
    if (put === null) {
      this.logger?.warn('event ledger insert refused — record could not be mapped', {
        meta: { collection: this.collection, id },
      })
      return null
    }
    await this.kind.put(put)
    return this.autoIntegerId ? idNum! : id
  }

  async updateWhere(
    filter: Record<string, unknown>,
    rawPatch: Record<string, unknown>,
  ): Promise<{ readonly updated: number }> {
    const patch = this.derived(rawPatch, 'patch')
    if (residualPredicate(filter) !== null) {
      const ids = await this.residualIds(filter)
      for (const id of ids) await this.kind.patch(id, patch)
      return { updated: ids.length }
    }
    const mapped = legacyFilterToRecordsQuery(filter, this.legacyAtField, this.indexFields)
    let cursor: string | undefined
    let updated = 0
    for (;;) {
      const page = await this.kind.query({
        ...mapped,
        limit: LEDGER_PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      })
      if (page.records.length === 0) break
      for (const row of page.records) {
        await this.kind.patch(row.id, patch)
        updated += 1
      }
      if (page.nextCursor === null) break
      cursor = page.nextCursor
    }
    return { updated }
  }

  async deleteWhere(filter: MutationFilter): Promise<number> {
    const whereInRaw = (filter as Record<string, unknown>)['whereIn']
    const whereIn =
      typeof whereInRaw === 'object' && whereInRaw !== null
        ? (whereInRaw as Record<string, unknown>)
        : null
    const trackIds = whereIn !== null ? whereIn['trackId'] : undefined
    if (Array.isArray(trackIds) && trackIds.length > 0) {
      const ids: string[] = []
      for (const trackId of trackIds) {
        if (typeof trackId !== 'string') continue
        const rows = await this.query({ where: { trackId }, limit: 100_000 })
        for (const row of rows) ids.push(row.id)
      }
      if (ids.length === 0) return 0
      return this.kind.deleteMany(ids)
    }
    if (residualPredicate(filter as Record<string, unknown>) !== null) {
      return this.deleteByIds(await this.residualIds(filter as Record<string, unknown>))
    }
    const mapped = legacyFilterToRecordsDelete(
      filter as Record<string, unknown>,
      this.legacyAtField,
      this.indexFields,
    )
    let total = 0
    for (;;) {
      const deleted = await this.kind.deleteWhere(mapped)
      total += deleted
      if (deleted === 0) break
    }
    return total
  }

  async update(id: string, patch: Record<string, unknown>): Promise<void> {
    await this.kind.patch(id, this.derived(patch, 'patch'))
  }

  async query(
    filter: Record<string, unknown>,
    columns?: readonly string[],
  ): Promise<readonly EventLedgerRow[]> {
    const whereInRaw = filter['whereIn']
    const whereIn =
      typeof whereInRaw === 'object' && whereInRaw !== null
        ? (whereInRaw as Record<string, unknown>)
        : null
    if (whereIn !== null && Array.isArray(whereIn['id'])) {
      const ids = whereIn['id'].filter((id): id is string => typeof id === 'string')
      const limit = typeof filter['limit'] === 'number' ? filter['limit'] : ids.length
      return (await this.getManyByIds(ids)).slice(0, limit)
    }
    const deviceIdList = whereIn !== null ? whereIn['deviceId'] : undefined
    if (Array.isArray(deviceIdList) && deviceIdList.length > 0) {
      const merged: EventLedgerRow[] = []
      const { whereIn: _drop, ...rest } = filter
      for (const deviceId of deviceIdList) {
        if (typeof deviceId !== 'number') continue
        const where =
          typeof filter['where'] === 'object' && filter['where'] !== null
            ? { ...(filter['where'] as Record<string, unknown>), deviceId }
            : { deviceId }
        const part = await this.query({ ...rest, where }, columns)
        merged.push(...part)
      }
      merged.sort(
        (a, b) =>
          Number(b.data[this.legacyAtField] ?? b.data['timestamp'] ?? 0) -
          Number(a.data[this.legacyAtField] ?? a.data['timestamp'] ?? 0),
      )
      const limit = typeof filter['limit'] === 'number' ? filter['limit'] : merged.length
      return merged.slice(0, limit)
    }
    const mergedWhereIn = await this.fanOutWhereInField(filter, whereIn, 'mediaKey', columns)
    if (mergedWhereIn !== null) return mergedWhereIn
    const mergedCollectionIn = await this.fanOutWhereInField(
      filter,
      whereIn,
      'collectionId',
      columns,
    )
    if (mergedCollectionIn !== null) return mergedCollectionIn
    const mergedFrameIn = await this.fanOutWhereInField(filter, whereIn, 'frameId', columns)
    if (mergedFrameIn !== null) return mergedFrameIn
    const trackIdList = whereIn !== null ? whereIn['trackId'] : undefined
    if (Array.isArray(trackIdList) && trackIdList.length > 1) {
      const merged: EventLedgerRow[] = []
      const { whereIn: _drop, ...rest } = filter
      for (const trackId of trackIdList) {
        if (typeof trackId !== 'string') continue
        const part = await this.query({ ...rest, whereIn: { trackId: [trackId] } }, columns)
        merged.push(...part)
      }
      merged.sort(
        (a, b) =>
          Number(b.data[this.legacyAtField] ?? b.data['timestamp'] ?? 0) -
          Number(a.data[this.legacyAtField] ?? a.data['timestamp'] ?? 0),
      )
      const limit = typeof filter['limit'] === 'number' ? filter['limit'] : merged.length
      return merged.slice(0, limit)
    }
    // Records `where` is equality-only: fan out multi-kind `whereIn` (same as deviceId).
    const kindList = whereIn !== null ? whereIn['kind'] : undefined
    if (Array.isArray(kindList) && kindList.length > 1) {
      const merged: EventLedgerRow[] = []
      const { whereIn: _drop, ...rest } = filter
      for (const kind of kindList) {
        if (typeof kind !== 'string') continue
        const part = await this.query({ ...rest, whereIn: { kind: [kind] } }, columns)
        merged.push(...part)
      }
      merged.sort(
        (a, b) =>
          Number(b.data[this.legacyAtField] ?? b.data['timestamp'] ?? 0) -
          Number(a.data[this.legacyAtField] ?? a.data['timestamp'] ?? 0),
      )
      const limit = typeof filter['limit'] === 'number' ? filter['limit'] : merged.length
      return merged.slice(0, limit)
    }
    const mapped = legacyFilterToRecordsQuery(filter, this.legacyAtField, this.indexFields)
    const keep = residualPredicate(filter)
    const offset = typeof filter['offset'] === 'number' ? filter['offset'] : 0
    const out: EventLedgerRow[] = []
    let cursor: string | undefined
    let skipped = 0
    for (;;) {
      const page = await this.kind.query({
        ...mapped,
        limit: mapped.limit ?? LEDGER_PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      })
      for (const row of page.records) {
        const legacy = recordsRowToLegacy(row, this.legacyAtField)
        if (keep !== null && !keep(legacy.data)) continue
        if (skipped < offset) {
          skipped += 1
          continue
        }
        out.push(legacy)
      }
      if (page.nextCursor === null) break
      cursor = page.nextCursor
      if (mapped.limit !== undefined && out.length >= mapped.limit) break
    }
    if (mapped.limit !== undefined && out.length > mapped.limit) {
      return out.slice(0, mapped.limit)
    }
    return out
  }

  /**
   * One page of the kind in clock order, newest first (`at` desc, `rid` desc),
   * resumed from the records engine's keyset cursor (`null` = from the top).
   * A `deviceId` uses the built-in `(kind, device, at)` index.
   */
  async pageByClock(
    cursor: string | null,
    limit: number,
    deviceId?: number,
  ): Promise<EventLedgerPage> {
    const page = await this.kind.query({
      desc: true,
      limit,
      ...(deviceId !== undefined ? { deviceId } : {}),
      ...(cursor === null ? {} : { cursor }),
    })
    return {
      rows: page.records.map((row) => recordsRowToLegacy(row, this.legacyAtField)),
      nextCursor: page.nextCursor,
    }
  }

  /**
   * `COUNT(*) GROUP BY field`, optionally filtered by an equality the kind's
   * indexes can serve. The value is the row count; the group is the field.
   * Callers use it so a hot page never loads the grouped rows' bodies (D447).
   */
  async countGroupedBy(
    field: string,
    where?: RecordWhere,
  ): Promise<readonly { readonly group: string | number | null; readonly value: number | null }[]> {
    return this.kind.aggregate({
      op: 'count',
      groupBy: field,
      ...(where === undefined ? {} : { where }),
    })
  }

  /**
   * One page of the whole kind in `id` order, resumed from the records
   * engine's OPAQUE keyset cursor (`null` = from the top). The answer's
   * `nextCursor` is `null` at the end. A keyset cursor names the last row
   * read, so deleting rows behind it never shifts what comes next — the
   * reason a bulk walk that reclaims as it goes needs this, not an offset.
   */
  async pageById(cursor: string | null, limit: number): Promise<EventLedgerPage> {
    const page = await this.kind.query({
      order: 'id',
      limit,
      ...(cursor === null ? {} : { cursor }),
    })
    return {
      rows: page.records.map((row) => recordsRowToLegacy(row, this.legacyAtField)),
      nextCursor: page.nextCursor,
    }
  }

  async getManyByIds(ids: readonly string[]): Promise<readonly EventLedgerRow[]> {
    if (ids.length === 0) return []
    const rows = await this.kind.getMany([...ids])
    return rows.map((row) => recordsRowToLegacy(row, this.legacyAtField))
  }

  async get(key: string): Promise<EventLedgerRow | null> {
    const row = await this.kind.get(key)
    return row === null ? null : recordsRowToLegacy(row, this.legacyAtField)
  }

  async deleteKey(key: string): Promise<void> {
    await this.kind.delete(key)
  }

  /** Delete explicit row ids — never map multi-id `whereIn` through `deleteWhere`. */
  async deleteByIds(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0
    return this.kind.deleteMany([...ids])
  }

  /**
   * Every id matching a filter with a residual predicate (a `null` in `where`,
   * a `whereNot`), read through {@link query}, which applies it: the engine's
   * `where` has no null and no negation, and dropping them would match rows
   * the filter excludes — for a delete, rows it must never touch.
   */
  private async residualIds(filter: Record<string, unknown>): Promise<string[]> {
    const { limit: _limit, offset: _offset, ...unbounded } = filter
    return (await this.query(unbounded)).map((row) => row.id)
  }

  async collectIds(filter: MutationFilter): Promise<string[]> {
    if (residualPredicate(filter as Record<string, unknown>) !== null) {
      return this.residualIds(filter as Record<string, unknown>)
    }
    const ids: string[] = []
    const mapped = legacyFilterToRecordsQuery(
      filter as Record<string, unknown>,
      this.legacyAtField,
      this.indexFields,
    )
    let cursor: string | undefined
    for (;;) {
      const page = await this.kind.query({
        deviceId: mapped.deviceId,
        atFrom: mapped.atFrom,
        atTo: mapped.atTo,
        where: mapped.where,
        // With a `where` the order is the index's and an explicit one is refused.
        ...(mapped.where === undefined ? { order: 'at' as const } : {}),
        desc: mapped.desc,
        limit: LEDGER_PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      })
      if (page.records.length === 0) break
      for (const row of page.records) ids.push(row.id)
      if (page.nextCursor === null) break
      cursor = page.nextCursor
    }
    return ids
  }

  async drainMatching(filter: MutationFilter): Promise<string[]> {
    const ids = await this.collectIds(filter)
    if (ids.length === 0) return ids
    if (residualPredicate(filter as Record<string, unknown>) !== null) {
      return (await this.deleteByIds(ids)) === 0 ? [] : ids
    }
    const mapped = legacyFilterToRecordsDelete(
      filter as Record<string, unknown>,
      this.legacyAtField,
      this.indexFields,
    )
    let total = 0
    for (;;) {
      const deleted = await this.kind.deleteWhere(mapped)
      total += deleted
      if (deleted === 0) break
    }
    return total === 0 ? [] : ids
  }

  async count(filter?: { readonly where?: { readonly deviceId?: number } }): Promise<number> {
    return this.kind.count({
      deviceId: filter?.where?.deviceId,
    })
  }

  async histogramDevice(): Promise<Map<number, number>> {
    const groups = await this.kind.aggregate({ op: 'count', groupBy: 'deviceId' })
    const out = new Map<number, number>()
    for (const g of groups) {
      if (typeof g.group === 'number' && Number.isFinite(g.group) && g.value !== null) {
        out.set(g.group, g.value)
      }
    }
    return out
  }

  /** Unassigned rows: count + newest `timestamp` (gallery rescore marker). */
  async pendingUnassignedMarker(): Promise<{ count: number; maxTimestamp: number | null }> {
    const count = await this.kind.count({ where: { assigned: false } })
    // No `order`: with a `where` the order is the index's (`assigned_ts` →
    // `timestamp`), and the engine refuses an explicit one.
    const page = await this.kind.query({
      where: { assigned: false },
      desc: true,
      limit: 1,
    })
    const maxTimestamp = page.records[0]?.at ?? null
    return { count, maxTimestamp }
  }

  async histogramTime(params: {
    readonly deviceId: number
    readonly since: number
    readonly until: number
    readonly bucketMs: number
  }): Promise<Map<number, number>> {
    // An empty window has no buckets; the engine refuses `from >= to`.
    if (params.until <= params.since) return new Map()
    const buckets = await this.kind.histogram({
      deviceId: params.deviceId,
      from: params.since,
      to: params.until,
      bucketMs: params.bucketMs,
    })
    const out = new Map<number, number>()
    for (const b of buckets) {
      const index = Math.floor((b.bucketStart - params.since) / params.bucketMs)
      if (index >= 0) out.set(index, b.count)
    }
    return out
  }

  private async fanOutWhereInField(
    filter: Record<string, unknown>,
    whereIn: Record<string, unknown> | null,
    field: string,
    columns: readonly string[] | undefined,
  ): Promise<readonly EventLedgerRow[] | null> {
    if (whereIn === null) return null
    const values = whereIn[field]
    if (!Array.isArray(values) || values.length <= 1) return null
    const merged: EventLedgerRow[] = []
    const { whereIn: _drop, ...rest } = filter
    for (const value of values) {
      if (typeof value !== 'string') continue
      const part = await this.query({ ...rest, whereIn: { [field]: [value] } }, columns)
      merged.push(...part)
    }
    merged.sort(
      (a, b) =>
        Number(b.data[this.legacyAtField] ?? b.data['timestamp'] ?? 0) -
        Number(a.data[this.legacyAtField] ?? a.data['timestamp'] ?? 0),
    )
    const limit = typeof filter['limit'] === 'number' ? filter['limit'] : merged.length
    return merged.slice(0, limit)
  }

  private derived(body: Record<string, unknown>, mode: 'put' | 'patch'): Record<string, unknown> {
    return this.deriveBody === undefined ? body : this.deriveBody(body, mode)
  }

  private buildRecordPut(
    id: string,
    record: Record<string, unknown>,
  ): {
    readonly id: string
    readonly deviceId?: number
    readonly at: number
    readonly data: Record<string, unknown>
  } | null {
    const deviceId = record['deviceId']
    const at = readLegacyClock(record, this.legacyAtField)
    if (at === undefined) return null
    if (this.deviceIdMode === 'required' && typeof deviceId !== 'number') return null
    const body = this.derived(eventBodyFromLegacyRecord(record), 'put')
    return {
      id,
      ...(typeof deviceId === 'number' ? { deviceId } : {}),
      at,
      data: body,
    }
  }
}

function readLegacyClock(
  record: Record<string, unknown>,
  field: EventLedgerLegacyAtField,
): number | undefined {
  const v = record[field]
  return typeof v === 'number' ? v : undefined
}

/**
 * The record body of a legacy-shaped row: everything but `id`.
 *
 * The clock stays in the body although it is also the header's `at`: the
 * kinds' indexes name the BODY field (`assigned_ts` → `timestamp`,
 * `identity_added` → `addedAt` …), and a row without it cannot be paged
 * through any of them. Stripping it here is what broke every faces page.
 */
function eventBodyFromLegacyRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (key === 'id') continue
    out[key] = value
  }
  return out
}

function recordsRowToLegacy(
  row: {
    readonly id: string
    readonly deviceId: number | null
    readonly at: number | null
    readonly data: Record<string, unknown>
  },
  legacyAtField: EventLedgerLegacyAtField,
): EventLedgerRow {
  const deviceId = row.deviceId ?? row.data['deviceId']
  const clock = row.at ?? readLegacyClock(row.data, legacyAtField)
  return {
    id: row.id,
    data: {
      ...row.data,
      ...(typeof deviceId === 'number' ? { deviceId } : {}),
      ...(typeof clock === 'number' ? { [legacyAtField]: clock } : {}),
      ...(legacyAtField === 'timestamp' && typeof clock === 'number' ? { timestamp: clock } : {}),
    },
  }
}

const LEGACY_CLOCK_FIELDS: readonly EventLedgerLegacyAtField[] = [
  'timestamp',
  'at',
  'archivedAt',
  'createdAt',
  'updatedAt',
  'copiedAt',
  'addedAt',
]

/**
 * Map a legacy-shaped filter onto a records query. `where.deviceId` goes to the
 * header; it ALSO stays in the `where` when an index of the kind leads with
 * `deviceId` plus exactly the other equality fields (`device_kind`): the
 * engine matches a `where` against an index's leading BODY fields, and the
 * header `deviceId` is not one of them, so `{ kind }` alone is refused there.
 */
function legacyFilterToRecordsQuery(
  filter: Record<string, unknown>,
  legacyAtField: EventLedgerLegacyAtField,
  indexFields: readonly (readonly string[])[],
): {
  deviceId?: number
  atFrom?: number
  atTo?: number
  where?: Record<string, string | number | boolean>
  desc?: boolean
  limit?: number
} {
  const where = filter['where']
  const deviceId =
    typeof where === 'object' &&
    where !== null &&
    typeof (where as Record<string, unknown>)['deviceId'] === 'number'
      ? ((where as Record<string, unknown>)['deviceId'] as number)
      : undefined
  const between = filter['whereBetween']
  let atFrom: number | undefined
  let atTo: number | undefined
  if (typeof between === 'object' && between !== null) {
    const betweenObj = between as Record<string, unknown>
    for (const field of LEGACY_CLOCK_FIELDS) {
      const range = betweenObj[field]
      if (Array.isArray(range) && range.length === 2) {
        // A legacy `whereBetween` is INCLUSIVE at both ends; the engine's `atTo`
        // is exclusive (`at < atTo`). A clock is integer ms, so the inclusive
        // upper bound is `atTo - 1`. Passing it through unchanged dropped every
        // row stamped exactly at the bound from reads while the delete (one past
        // it) still removed it: a pruned event whose media was never deleted.
        atFrom = Number(range[0])
        atTo = Number(range[1]) + 1
        break
      }
    }
  }
  const orderBy = filter['orderBy']
  const orderField =
    typeof orderBy === 'object' && orderBy !== null
      ? (orderBy as Record<string, unknown>)['field']
      : undefined
  const desc =
    typeof orderBy === 'object' &&
    orderBy !== null &&
    (orderBy as Record<string, unknown>)['direction'] === 'desc'
  const orderUsesAt =
    orderField === undefined ||
    orderField === legacyAtField ||
    orderField === 'timestamp' ||
    orderField === 'at'
  const limit = typeof filter['limit'] === 'number' ? filter['limit'] : undefined
  const whereExtra: Record<string, string | number | boolean> = {}
  if (typeof where === 'object' && where !== null) {
    for (const [k, v] of Object.entries(where)) {
      if (k === 'deviceId') continue
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        whereExtra[k] = v
      }
    }
  }
  const whereIn = filter['whereIn']
  if (typeof whereIn === 'object' && whereIn !== null) {
    for (const [field, values] of Object.entries(whereIn as Record<string, unknown>)) {
      if (Array.isArray(values) && values.length === 1) {
        const only = values[0]
        if (typeof only === 'string' || typeof only === 'number' || typeof only === 'boolean') {
          whereExtra[field] = only
        }
      }
    }
  }
  const extraKeys = Object.keys(whereExtra)
  if (
    deviceId !== undefined &&
    extraKeys.length > 0 &&
    indexFields.some((fields) => leadsWith(fields, ['deviceId', ...extraKeys]))
  ) {
    whereExtra['deviceId'] = deviceId
  }
  return {
    ...(deviceId !== undefined ? { deviceId } : {}),
    ...(atFrom !== undefined ? { atFrom } : {}),
    ...(atTo !== undefined ? { atTo } : {}),
    ...(Object.keys(whereExtra).length > 0 ? { where: whereExtra } : {}),
    ...(desc && orderUsesAt ? { desc: true } : {}),
    ...(limit !== undefined ? { limit } : {}),
  }
}

/** A row test applied after the engine's page. */
type RowPredicate = (data: Record<string, unknown>) => boolean

function isAbsent(value: unknown): boolean {
  return value === null || value === undefined
}

/**
 * The part of a legacy filter the engine's `where` cannot carry: an equality
 * with `null` (`where: { f: null }`, IS NULL — an RFC 7396 patch removes a
 * field set to null, so absent IS null) and every `whereNot` (`{ f: null }` is
 * IS NOT NULL; `{ f: v }` is `f IS NULL OR f != v`, D312). `null` when there
 * is none.
 */
function residualPredicate(filter: Record<string, unknown>): RowPredicate | null {
  const where = filter['where']
  const nullFields =
    typeof where === 'object' && where !== null
      ? Object.entries(where)
          .filter(([, v]) => v === null)
          .map(([k]) => k)
      : []
  const whereNot = filter['whereNot']
  const notEntries =
    typeof whereNot === 'object' && whereNot !== null ? Object.entries(whereNot) : []
  if (nullFields.length === 0 && notEntries.length === 0) return null
  return (data) =>
    nullFields.every((k) => isAbsent(data[k])) &&
    notEntries.every(([k, v]) =>
      v === null ? !isAbsent(data[k]) : isAbsent(data[k]) || data[k] !== v,
    )
}

/** True when `fields` begins with exactly the set `keys` (any order). */
function leadsWith(fields: readonly string[], keys: readonly string[]): boolean {
  if (fields.length < keys.length) return false
  const lead = new Set(fields.slice(0, keys.length))
  return keys.every((k) => lead.has(k))
}

function legacyFilterToRecordsDelete(
  filter: Record<string, unknown>,
  legacyAtField: EventLedgerLegacyAtField,
  indexFields: readonly (readonly string[])[],
): {
  deviceId?: number
  atBefore?: number
  where?: Record<string, string | number | boolean>
} {
  const q = legacyFilterToRecordsQuery(filter, legacyAtField, indexFields)
  // `atTo` is already exclusive, as `atBefore` is.
  const atBefore = q.atTo
  return {
    ...(q.deviceId !== undefined ? { deviceId: q.deviceId } : {}),
    ...(atBefore !== undefined ? { atBefore } : {}),
    ...(q.where !== undefined ? { where: q.where } : {}),
  }
}
