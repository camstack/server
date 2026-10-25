/**
 * The filter compiler, and the reason it has a MODE.
 *
 * The read path has always been forgiving: a predicate naming something that
 * is not a column of a structured table is dropped, and the query returns a
 * wider result. That is survivable for a SELECT and it is what every existing
 * caller has been built against, so `select` mode keeps it.
 *
 * For a bulk mutation the same forgiveness is data loss. `deleteWhere` with a
 * dropped predicate removes rows the caller meant to exclude, and a filter
 * that compiles to no predicates at all is `DELETE FROM <table>` — the whole
 * collection. `mutate` mode therefore refuses both, loudly, before any SQL is
 * built.
 *
 * These tests are the specification of that difference. If they ever pass
 * while `mutate` behaves like `select`, the guard is gone.
 */
import { describe, expect, it } from 'vitest'
import { type CollectionShape, compileFilter } from '../filter-compiler.js'

/** A structured table: real columns, nothing hidden in a blob. */
const structured: CollectionShape = {
  primaryKey: 'id',
  columns: new Set(['deviceId', 'timestamp', 'label']),
  kvBlobColumn: null,
}

/** A KV collection: one `data` blob, fields reachable via json_extract. */
const kv: CollectionShape = {
  primaryKey: 'id',
  columns: new Set(['data']),
  kvBlobColumn: 'data',
}

const ident = (v: unknown): unknown => v

describe('compileFilter — shared shape', () => {
  it('compiles equality, IN and BETWEEN against real columns', () => {
    const out = compileFilter(
      {
        where: { deviceId: 101 },
        whereIn: { label: ['person', 'vehicle'] },
        whereBetween: { timestamp: [0, 1699] },
      },
      structured,
      'select',
      ident,
    )
    expect(out.whereSql).toBe(
      ' WHERE "deviceId" = ? AND "label" IN (?, ?) AND "timestamp" BETWEEN ? AND ?',
    )
    expect(out.params).toEqual([101, 'person', 'vehicle', 0, 1699])
  })

  it('reaches a KV blob field through json_extract', () => {
    const out = compileFilter({ where: { username: 'a' } }, kv, 'select', ident)
    expect(out.whereSql).toBe(` WHERE json_extract("data", '$.username') = ?`)
  })
})

describe('compileFilter — select mode stays forgiving', () => {
  it('drops a predicate naming a non-column of a structured table', () => {
    const out = compileFilter({ where: { nope: 1, deviceId: 101 } }, structured, 'select', ident)
    expect(out.whereSql).toBe(' WHERE "deviceId" = ?')
    expect(out.params).toEqual([101])
  })

  it('allows an empty filter — a SELECT with no predicate is a full scan, not a hazard', () => {
    expect(compileFilter({}, structured, 'select', ident).whereSql).toBe('')
    expect(compileFilter(undefined, structured, 'select', ident).whereSql).toBe('')
  })
})

describe('compileFilter — mutate mode refuses what select tolerates', () => {
  it('THROWS on a predicate it cannot resolve, naming the field', () => {
    expect(() => compileFilter({ where: { nope: 1 } }, structured, 'mutate', ident)).toThrow(/nope/)
  })

  it('throws even when other predicates DO resolve — a partial filter is the dangerous case', () => {
    expect(() =>
      compileFilter({ where: { deviceId: 101, nope: 1 } }, structured, 'mutate', ident),
    ).toThrow(/nope/)
  })

  it('THROWS on an empty filter rather than emitting an unrestricted statement', () => {
    expect(() => compileFilter({}, structured, 'mutate', ident)).toThrow(/every row/i)
    expect(() => compileFilter(undefined, structured, 'mutate', ident)).toThrow(/every row/i)
  })

  it('throws when a filter is present but every branch is empty', () => {
    expect(() =>
      compileFilter({ where: {}, whereIn: {}, whereBetween: {} }, structured, 'mutate', ident),
    ).toThrow(/every row/i)
  })

  it('throws on an empty IN list — `IN ()` matches nothing and hides a caller bug', () => {
    expect(() => compileFilter({ whereIn: { label: [] } }, structured, 'mutate', ident)).toThrow(
      /label/,
    )
  })

  it('compiles the retention filter that motivated all of this', () => {
    const out = compileFilter(
      { where: { deviceId: 101 }, whereBetween: { timestamp: [0, 1_699_999] } },
      structured,
      'mutate',
      ident,
    )
    expect(out.whereSql).toBe(' WHERE "deviceId" = ? AND "timestamp" BETWEEN ? AND ?')
    expect(out.params).toEqual([101, 0, 1_699_999])
  })
})
