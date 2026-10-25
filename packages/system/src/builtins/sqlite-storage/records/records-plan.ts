/**
 * Statement planning for `records` (D881): turn a request into SQL that is
 * served by an index BY CONSTRUCTION, or refuse it.
 *
 * - `where` accepts declared index fields only: the equality fields must be the
 *   LEADING fields of one declared index (any order), with at most one range on
 *   the field right after them. Anything else throws {@link UnindexedFilterError}
 *   - an unindexed filter does not compile.
 * - Every index path is named with `INDEXED BY`: if SQLite cannot use that index
 *   for the statement it ERRORS instead of quietly scanning.
 * - Pagination is keyset (`(key..., rid) > cursor`); there is no offset.
 *
 * Pure: no database in here, so the statements are testable (and EXPLAINed) on
 * their own.
 */
import {
  InvalidRecordError,
  type RecordKindDeclaration,
  type RecordWhere,
  type RecordWhereValue,
  UnindexedFilterError,
} from '@camstack/types'
import {
  INDEX_KIND_AT,
  INDEX_KIND_DEVICE_AT,
  indexName,
  kindClause,
  recordFieldExpr,
} from './records-sql.js'

type Bindable = string | number | null

interface Predicate {
  readonly field: string
  readonly shape: 'eq' | 'in' | 'range'
  readonly value: RecordWhereValue
}

function bindable(value: unknown): Bindable {
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string' || typeof value === 'number') return value
  throw new InvalidRecordError('a where value must be a string, number or boolean')
}

function predicateOf(field: string, value: RecordWhereValue): Predicate {
  if (typeof value === 'object') {
    return { field, shape: 'in' in value ? 'in' : 'range', value }
  }
  return { field, shape: 'eq', value }
}

/** A declared index and what a `where` leaves for ordering. */
export interface WherePlan {
  readonly index: RecordKindDeclaration['indexes'][number]
  readonly clauses: readonly string[]
  readonly params: readonly Bindable[]
  /** The index fields after the equality prefix: the order a `where` query returns in. */
  readonly orderFields: readonly string[]
}

/** How `planWhere` may serve a filter. */
export interface WhereOptions {
  readonly allowIn: boolean
  /** Fields the statement reads beyond the filter: an aggregate's value and group columns. */
  readonly extraFields?: readonly string[]
  /** The field the statement groups by: an index it leads is preferred. */
  readonly groupBy?: string | undefined
}

/**
 * Find the declared index that serves `where` (plus any `extraFields` the
 * statement reads: an aggregate's value and group columns), or throw.
 */
export function planWhere(
  kind: string,
  decl: RecordKindDeclaration,
  where: RecordWhere | undefined,
  opts: WhereOptions,
): WherePlan | null {
  const predicates = Object.entries(where ?? {}).map(([f, v]) => predicateOf(f, v))
  const extra = opts.extraFields ?? []
  if (predicates.length === 0 && extra.length === 0) return null

  const equalities = predicates.filter((p) => p.shape !== 'range')
  const ranges = predicates.filter((p) => p.shape === 'range')
  if (ranges.length > 1) {
    throw new UnindexedFilterError(
      `${kind}: at most one range predicate (${ranges.map((r) => r.field).join(', ')}) - it must be the field right after the equality fields of one index`,
    )
  }
  if (!opts.allowIn && equalities.some((p) => p.shape === 'in')) {
    throw new UnindexedFilterError(
      `${kind}: an "in" set cannot be paged in index order - ask once per value`,
    )
  }
  const eqCount = equalities.length
  const eqSet = new Set(equalities.map((p) => p.field))
  const range = ranges[0]

  const candidates = decl.indexes.filter((index) => {
    const leading = index.fields.slice(0, eqCount)
    if (leading.length !== eqCount || !leading.every((f) => eqSet.has(f))) return false
    if (range !== undefined && index.fields[eqCount] !== range.field) return false
    return extra.every((f) => index.fields.includes(f))
  })
  // A group is built in index order only when its field comes right after the
  // equality prefix; any other covering index groups in a temp b-tree. So the
  // index the group field LEADS wins over an earlier one it merely trails.
  const groupBy = opts.groupBy
  const candidate =
    (groupBy === undefined
      ? undefined
      : candidates.find((index) => index.fields[eqCount] === groupBy)) ?? candidates[0]
  if (candidate === undefined) {
    const declared = decl.indexes.map((i) => `${i.name}(${i.fields.join(', ')})`).join('; ')
    const asked = [...predicates.map((p) => p.field), ...extra].join(', ')
    throw new UnindexedFilterError(
      `${kind}: no declared index serves [${asked}]. Declared: ${declared.length > 0 ? declared : 'none'}. A filter on an unindexed field does not compile - declare an index`,
    )
  }

  const clauses: string[] = []
  const params: Bindable[] = []
  for (const p of equalities) {
    const expr = recordFieldExpr(p.field)
    if (p.shape === 'in' && typeof p.value === 'object' && 'in' in p.value) {
      clauses.push(`${expr} IN (${p.value.in.map(() => '?').join(', ')})`)
      params.push(...p.value.in.map(bindable))
    } else {
      clauses.push(`${expr} = ?`)
      params.push(bindable(p.value))
    }
  }
  if (range !== undefined && typeof range.value === 'object') {
    const expr = recordFieldExpr(range.field)
    const bounds = range.value
    const ops: readonly (readonly [string, string | number | undefined])[] = [
      ['>', 'gt' in bounds ? bounds.gt : undefined],
      ['>=', 'gte' in bounds ? bounds.gte : undefined],
      ['<', 'lt' in bounds ? bounds.lt : undefined],
      ['<=', 'lte' in bounds ? bounds.lte : undefined],
    ]
    for (const [op, value] of ops) {
      if (value === undefined) continue
      clauses.push(`${expr} ${op} ?`)
      params.push(bindable(value))
    }
  }
  return { index: candidate, clauses, params, orderFields: candidate.fields.slice(eqCount) }
}

/** The built-in filters shared by every statement. */
export interface WindowFilter {
  readonly deviceId?: number | undefined
  readonly atFrom?: number | undefined
  readonly atTo?: number | undefined
}

function assertWindowAllowed(kind: string, decl: RecordKindDeclaration, w: WindowFilter): void {
  if (w.deviceId !== undefined && decl.device === 'none') {
    throw new InvalidRecordError(
      `${kind}: declared device: "none", it cannot be filtered by deviceId`,
    )
  }
  if ((w.atFrom !== undefined || w.atTo !== undefined) && decl.at === 'none') {
    throw new InvalidRecordError(`${kind}: declared at: "none", it cannot be filtered by time`)
  }
}

function windowClauses(w: WindowFilter): { clauses: string[]; params: Bindable[] } {
  const clauses: string[] = []
  const params: Bindable[] = []
  if (w.deviceId !== undefined) {
    clauses.push('device_id = ?')
    params.push(w.deviceId)
  }
  if (w.atFrom !== undefined) {
    clauses.push('at >= ?')
    params.push(w.atFrom)
  }
  if (w.atTo !== undefined) {
    clauses.push('at < ?')
    params.push(w.atTo)
  }
  return { clauses, params }
}

/** The built-in index that serves a device/time window. */
export function windowIndex(w: WindowFilter): string {
  return w.deviceId !== undefined ? INDEX_KIND_DEVICE_AT : INDEX_KIND_AT
}

export interface PlannedStatement {
  readonly sql: string
  readonly params: readonly Bindable[]
}

export interface PlannedQuery extends PlannedStatement {
  /** Names the access path; a cursor is valid only for the plan that issued it. */
  readonly tag: string
  /** How many `_k<i>` cursor-key columns the statement selects (before `rid`). */
  readonly keyCount: number
}

function assertCursor(
  cursor: { readonly tag: string; readonly values: readonly Bindable[] },
  tag: string,
  length: number,
): void {
  if (cursor.tag !== tag || cursor.values.length !== length) {
    throw new InvalidRecordError('the cursor does not belong to this query')
  }
}

const ROW_COLUMNS =
  'rid, id, device_id AS deviceId, at, expires_at AS expiresAt, rev, updated_at AS updatedAt, json(data) AS data'

export interface QueryRequest extends WindowFilter {
  readonly where?: RecordWhere | undefined
  readonly order?: 'at' | 'id' | undefined
  readonly desc?: boolean | undefined
  readonly limit: number
  /** A decoded cursor: the tag of the plan that issued it, and its key values. */
  readonly cursor?: { readonly tag: string; readonly values: readonly Bindable[] } | undefined
}

export function planQuery(
  kind: string,
  kindId: number,
  decl: RecordKindDeclaration,
  q: QueryRequest,
): PlannedQuery {
  assertWindowAllowed(kind, decl, q)
  const dir = q.desc === true ? 'DESC' : 'ASC'
  const cmp = q.desc === true ? '<' : '>'
  const where = planWhere(kind, decl, q.where, { allowIn: false })
  const base = windowClauses(q)

  if (where !== null) {
    if (q.order !== undefined) {
      throw new InvalidRecordError(`${kind}: with a where the order is the index's; drop "order"`)
    }
    const keys = where.orderFields
    const keyExprs = keys.map(recordFieldExpr)
    const clauses = [kindClause(kindId), ...where.clauses, ...base.clauses]
    const params: Bindable[] = [...where.params, ...base.params]
    const tag = `rx:${where.index.name}:${dir}`
    if (q.cursor !== undefined) {
      assertCursor(q.cursor, tag, keys.length + 1)
      clauses.push(
        `(${[...keyExprs, 'rid'].join(', ')}) ${cmp} (${[...keys, 'rid'].map(() => '?').join(', ')})`,
      )
      params.push(...q.cursor.values)
    }
    const select = [ROW_COLUMNS, ...keyExprs.map((e, i) => `${e} AS _k${i}`)].join(', ')
    const order = [...keyExprs, 'rid'].map((e) => `${e} ${dir}`).join(', ')
    return {
      sql: `SELECT ${select} FROM records INDEXED BY "${indexName(kindId, where.index.name)}" WHERE ${clauses.join(' AND ')} ORDER BY ${order} LIMIT ${q.limit + 1}`,
      params,
      keyCount: keys.length,
      tag,
    }
  }

  const order = q.order ?? (decl.at === 'required' ? 'at' : 'id')
  if (order === 'at') {
    if (decl.at !== 'required') {
      throw new InvalidRecordError(
        `${kind}: declared at: "none", it has no time order - use order: "id"`,
      )
    }
    const clauses = [kindClause(kindId), ...base.clauses]
    const params: Bindable[] = [...base.params]
    const tag = `at:${dir}`
    if (q.cursor !== undefined) {
      assertCursor(q.cursor, tag, 2)
      clauses.push(`(at, rid) ${cmp} (?, ?)`)
      params.push(...q.cursor.values)
    }
    return {
      sql: `SELECT ${ROW_COLUMNS}, at AS _k0 FROM records INDEXED BY ${windowIndex(q)} WHERE ${clauses.join(' AND ')} ORDER BY at ${dir}, rid ${dir} LIMIT ${q.limit + 1}`,
      params,
      keyCount: 1,
      tag,
    }
  }

  if (q.deviceId !== undefined || q.atFrom !== undefined || q.atTo !== undefined) {
    throw new UnindexedFilterError(
      `${kind}: order "id" cannot be combined with a device or time window (use order "at")`,
    )
  }
  const clauses = [kindClause(kindId)]
  const params: Bindable[] = []
  const tag = `id:${dir}`
  if (q.cursor !== undefined) {
    // Every cursor is the key values PLUS `rid` (the engine appends it). The
    // id is unique within a kind, so the id alone resumes; `rid` is ignored.
    assertCursor(q.cursor, tag, 2)
    clauses.push(`id ${cmp} ?`)
    params.push(q.cursor.values[0] ?? null)
  }
  return {
    sql: `SELECT ${ROW_COLUMNS}, id AS _k0 FROM records WHERE ${clauses.join(' AND ')} ORDER BY id ${dir} LIMIT ${q.limit + 1}`,
    params,
    keyCount: 1,
    tag,
  }
}

export interface CountRequest extends WindowFilter {
  readonly where?: RecordWhere | undefined
}

export function planCount(
  kind: string,
  kindId: number,
  decl: RecordKindDeclaration,
  q: CountRequest,
): PlannedStatement {
  assertWindowAllowed(kind, decl, q)
  const where = planWhere(kind, decl, q.where, { allowIn: true })
  const base = windowClauses(q)
  const clauses = [kindClause(kindId), ...(where?.clauses ?? []), ...base.clauses]
  const index = where !== null ? `"${indexName(kindId, where.index.name)}"` : windowIndex(q)
  return {
    sql: `SELECT COUNT(*) AS n FROM records INDEXED BY ${index} WHERE ${clauses.join(' AND ')}`,
    params: [...(where?.params ?? []), ...base.params],
  }
}

export interface HistogramRequest {
  readonly deviceId?: number | undefined
  readonly from: number
  readonly to: number
  readonly bucketMs: number
}

/** Buckets one answer may carry: a histogram is a chart, not an export. */
export const HISTOGRAM_MAX_BUCKETS = 10_000

export function planHistogram(
  kind: string,
  kindId: number,
  decl: RecordKindDeclaration,
  q: HistogramRequest,
): PlannedStatement {
  assertWindowAllowed(kind, decl, { deviceId: q.deviceId, atFrom: q.from })
  if (!(q.to > q.from)) throw new InvalidRecordError(`${kind}: histogram needs from < to`)
  if (Math.ceil((q.to - q.from) / q.bucketMs) > HISTOGRAM_MAX_BUCKETS) {
    throw new InvalidRecordError(`${kind}: histogram would exceed ${HISTOGRAM_MAX_BUCKETS} buckets`)
  }
  const from = Math.floor(q.from)
  const clauses = [kindClause(kindId)]
  const params: Bindable[] = [from, q.bucketMs]
  if (q.deviceId !== undefined) {
    clauses.push('device_id = ?')
    params.push(q.deviceId)
  }
  clauses.push('at >= ?', 'at < ?')
  params.push(from, Math.ceil(q.to))
  return {
    sql: `SELECT ((at - CAST(? AS INTEGER)) / CAST(? AS INTEGER)) AS b, COUNT(*) AS c FROM records INDEXED BY ${windowIndex(q)} WHERE ${clauses.join(' AND ')} GROUP BY b ORDER BY b`,
    params,
  }
}

export interface AggregateRequest {
  readonly op: 'sum' | 'min' | 'max' | 'count'
  readonly field?: string | undefined
  readonly groupBy?: string | undefined
  readonly where?: RecordWhere | undefined
}

export function planAggregate(
  kind: string,
  kindId: number,
  decl: RecordKindDeclaration,
  q: AggregateRequest,
): PlannedStatement {
  if (q.op !== 'count' && q.field === undefined) {
    throw new InvalidRecordError(`${kind}: ${q.op} needs a field`)
  }
  const extra = [q.field, q.groupBy].filter((f): f is string => f !== undefined)
  if (extra.length === 0 && q.where === undefined) {
    throw new InvalidRecordError(`${kind}: a count with no field and no groupBy is "count"`)
  }
  const where = planWhere(kind, decl, q.where, {
    allowIn: true,
    extraFields: extra,
    groupBy: q.groupBy,
  })
  if (where === null) throw new InvalidRecordError(`${kind}: aggregate has nothing to read`)
  const fn = q.op.toUpperCase()
  const value = q.field === undefined ? 'COUNT(*)' : `${fn}(${recordFieldExpr(q.field)})`
  // The group column is read as MIN(expr) over a GROUP BY expr: a bare `expr AS g` makes
  // SQLite load the table row to fill the "bare column" of the group, MIN() does not.
  const groupExpr = q.groupBy === undefined ? null : recordFieldExpr(q.groupBy)
  const group = groupExpr === null ? 'NULL' : `MIN(${groupExpr})`
  const clauses = [kindClause(kindId), ...where.clauses]
  return {
    sql: `SELECT ${group} AS g, ${value} AS v FROM records INDEXED BY "${indexName(kindId, where.index.name)}" WHERE ${clauses.join(' AND ')}${groupExpr === null ? '' : ` GROUP BY ${groupExpr}`}`,
    params: where.params,
  }
}

export interface DeleteWhereRequest extends WindowFilter {
  readonly atBefore?: number | undefined
  readonly where?: RecordWhere | undefined
}

/** The subselect that names up to `limit` rows to delete. */
export function planDeleteWhere(
  kind: string,
  kindId: number,
  decl: RecordKindDeclaration,
  q: DeleteWhereRequest,
  limit: number,
): PlannedStatement {
  assertWindowAllowed(kind, decl, { deviceId: q.deviceId, atFrom: q.atBefore })
  const where = planWhere(kind, decl, q.where, { allowIn: true })
  const clauses = [kindClause(kindId), ...(where?.clauses ?? [])]
  const params: Bindable[] = [...(where?.params ?? [])]
  if (q.deviceId !== undefined) {
    clauses.push('device_id = ?')
    params.push(q.deviceId)
  }
  if (q.atBefore !== undefined) {
    clauses.push('at < ?')
    params.push(q.atBefore)
  }
  const index =
    where !== null
      ? `"${indexName(kindId, where.index.name)}"`
      : windowIndex({ deviceId: q.deviceId })
  return {
    sql: `SELECT rid FROM records INDEXED BY ${index} WHERE ${clauses.join(' AND ')} LIMIT ${limit}`,
    params,
  }
}
