/**
 * The statement rules of the records engine, without SQL, for the in-memory
 * world (`makeInMemoryRecords`). This MIRRORS
 * `packages/system/src/builtins/sqlite-storage/records/records-plan.ts`:
 *
 * - a `where` is served by ONE declared index: its equality fields are that
 *   index's LEADING fields (any order), with at most one range on the field
 *   right after them; `in` is accepted only where the engine accepts it
 *   (count, aggregate, deleteWhere) — a page cannot be served in index order
 *   from a set;
 * - with a `where`, the order IS the index's (the fields after the equality
 *   prefix, then the row id); asking for an `order` too is refused;
 * - values compare the way SQLite compares `json_extract` results: a boolean
 *   is 1/0, a missing field is NULL, NULL < numbers < text, and NULL matches
 *   no predicate.
 *
 * The contract spec in `@camstack/system`
 * (`sqlite-storage/__tests__/records-in-memory-contract.spec.ts`) runs the same
 * cases against this and the real engine, so the two cannot drift silently.
 */
import type { RecordWhere, RecordWhereValue } from '../capabilities/records.cap.js'
import { InvalidRecordError, UnindexedFilterError } from './errors.js'
import type { RecordKindDeclaration } from './record-kind.js'

/** A value as SQLite holds it after `json_extract`. */
export type SqlValue = string | number | null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** `json_extract(data, '$.a.b')`. */
export function extractField(data: Record<string, unknown>, path: string): SqlValue {
  let current: unknown = data
  for (const segment of path.split('.')) {
    if (!isRecord(current)) return null
    current = current[segment]
  }
  if (current === undefined || current === null) return null
  if (typeof current === 'boolean') return current ? 1 : 0
  if (typeof current === 'number' || typeof current === 'string') return current
  return JSON.stringify(current)
}

/** A bound parameter. */
export function bindable(value: unknown): SqlValue {
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string' || typeof value === 'number') return value
  throw new InvalidRecordError('a where value must be a string, number or boolean')
}

function compareText(a: string, b: string): number {
  // BINARY collation is memcmp over UTF-8, which is code-point order.
  const ai = a[Symbol.iterator]()
  const bi = b[Symbol.iterator]()
  for (;;) {
    const x = ai.next()
    const y = bi.next()
    if (x.done === true) return y.done === true ? 0 : -1
    if (y.done === true) return 1
    const cx = x.value.codePointAt(0) ?? 0
    const cy = y.value.codePointAt(0) ?? 0
    if (cx !== cy) return cx < cy ? -1 : 1
  }
}

/** ORDER BY order: NULL < numbers < text. */
export function compareSql(a: SqlValue, b: SqlValue): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1
  if (typeof a === 'number') return -1
  if (typeof b === 'number') return 1
  return compareText(a, b)
}

/**
 * A row-value comparison `(a, b, …) > (x, y, …)` with SQL's three values:
 * the first unequal pair decides, and a NULL met before it makes the whole
 * comparison NULL (the row is not returned).
 */
export function rowValueAfter(
  row: readonly SqlValue[],
  cursor: readonly SqlValue[],
  desc: boolean,
): boolean {
  for (let i = 0; i < row.length; i += 1) {
    const a = row[i] ?? null
    const b = cursor[i] ?? null
    if (a === null || b === null) return false
    const c = compareSql(a, b)
    if (c !== 0) return desc ? c < 0 : c > 0
  }
  return false
}

type PredicateShape = 'eq' | 'in' | 'range'

interface Predicate {
  readonly field: string
  readonly shape: PredicateShape
  readonly value: RecordWhereValue
}

function predicateOf(field: string, value: RecordWhereValue): Predicate {
  if (typeof value === 'object') return { field, shape: 'in' in value ? 'in' : 'range', value }
  return { field, shape: 'eq', value }
}

/** The index a `where` is served by and the test a row must pass. */
export interface WherePlan {
  readonly indexName: string
  /** The index fields after the equality prefix: the order a `where` query returns in. */
  readonly orderFields: readonly string[]
  readonly matches: (data: Record<string, unknown>) => boolean
}

export interface WhereOptions {
  readonly allowIn: boolean
  readonly extraFields?: readonly string[]
  readonly groupBy?: string | undefined
}

function predicateTest(p: Predicate): (data: Record<string, unknown>) => boolean {
  const value = p.value
  if (p.shape === 'eq') {
    const wanted = bindable(value)
    return (data) => {
      const got = extractField(data, p.field)
      return got !== null && compareSql(got, wanted) === 0
    }
  }
  if (typeof value === 'object' && 'in' in value) {
    const set = value.in.map(bindable)
    return (data) => {
      const got = extractField(data, p.field)
      return got !== null && set.some((w) => w !== null && compareSql(got, w) === 0)
    }
  }
  if (typeof value !== 'object') return () => false
  const bounds: readonly (readonly [string | number | undefined, (c: number) => boolean])[] = [
    ['gt' in value ? value.gt : undefined, (c) => c > 0],
    ['gte' in value ? value.gte : undefined, (c) => c >= 0],
    ['lt' in value ? value.lt : undefined, (c) => c < 0],
    ['lte' in value ? value.lte : undefined, (c) => c <= 0],
  ]
  const active = bounds.flatMap(([b, ok]) => (b === undefined ? [] : [{ bound: bindable(b), ok }]))
  return (data) => {
    const got = extractField(data, p.field)
    if (got === null) return false
    return active.every(({ bound, ok }) => ok(compareSql(got, bound)))
  }
}

/** `planWhere` of the engine: find the declared index, or refuse with the engine's error. */
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
  // Values are bound up front, as the engine binds them: a bad value refuses the statement.
  const tests = predicates.map(predicateTest)
  return {
    indexName: candidate.name,
    orderFields: candidate.fields.slice(eqCount),
    matches: (data) => tests.every((t) => t(data)),
  }
}

/** The built-in device/time window of a statement. */
export interface WindowFilter {
  readonly deviceId?: number | undefined
  readonly atFrom?: number | undefined
  readonly atTo?: number | undefined
}

export function assertWindowAllowed(
  kind: string,
  decl: RecordKindDeclaration,
  w: WindowFilter,
): void {
  if (w.deviceId !== undefined && decl.device === 'none') {
    throw new InvalidRecordError(
      `${kind}: declared device: "none", it cannot be filtered by deviceId`,
    )
  }
  if ((w.atFrom !== undefined || w.atTo !== undefined) && decl.at === 'none') {
    throw new InvalidRecordError(`${kind}: declared at: "none", it cannot be filtered by time`)
  }
}

/** The header columns a window reads. */
export interface WindowRow {
  readonly deviceId: number | null
  readonly at: number | null
}

export function inWindow(row: WindowRow, w: WindowFilter): boolean {
  if (w.deviceId !== undefined && row.deviceId !== w.deviceId) return false
  if (w.atFrom !== undefined && (row.at === null || row.at < w.atFrom)) return false
  if (w.atTo !== undefined && (row.at === null || row.at >= w.atTo)) return false
  return true
}
