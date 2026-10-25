import { beforeEach, describe, expect, it } from 'vitest'
import {
  SQL_SHAPE_ELLIPSIS,
  SQL_SHAPE_MAX_LENGTH,
  resetSqlShapeMemo,
  sqlShape,
} from '../statement-shape.js'

const TRACKS = 'pipeline-analytics:tracks'

/** The statement `queryDeclared` builds, minus the 37-column projection. */
function selectOn(collection: string, tail: string): string {
  return `SELECT "id", "deviceId", "className", "positions" FROM "${collection}"${tail}`
}

describe('sqlShape', () => {
  beforeEach(() => {
    resetSqlShapeMemo()
  })

  it('separates two reads of the SAME table that differ only in their predicate', () => {
    // This is the whole point: on 2026-08-25 both of these were reported as
    // `query pipeline-analytics:tracks` and one of them was a full scan.
    const scan = sqlShape(
      selectOn(TRACKS, ' WHERE "lastSeen" BETWEEN ? AND ? ORDER BY "lastSeen" ASC LIMIT ?'),
      TRACKS,
    )
    const indexed = sqlShape(
      selectOn(
        TRACKS,
        ' WHERE "deviceId" = ? AND "lastSeen" BETWEEN ? AND ? ORDER BY "lastSeen" DESC LIMIT ?',
      ),
      TRACKS,
    )
    expect(scan).not.toBe(indexed)
    expect(scan).toContain('WHERE "lastSeen" BETWEEN ? AND ?')
    expect(indexed).toContain('"deviceId" = ?')
  })

  it('drops the projection, which is the schema restated', () => {
    const shape = sqlShape(selectOn(TRACKS, ' WHERE "deviceId" = ? LIMIT ?'), TRACKS)
    expect(shape).not.toContain('"className"')
    expect(shape).toBe('SELECT … FROM <t> WHERE "deviceId" = ? LIMIT ?')
  })

  it('replaces the table name by VALUE, keeping identically-quoted column names', () => {
    // A quoted-identifier pattern would erase `"deviceId"` too — the only part
    // of the statement worth keeping.
    const shape = sqlShape(selectOn(TRACKS, ' WHERE "deviceId" = ? LIMIT ?'), TRACKS)
    expect(shape).not.toContain(TRACKS)
    expect(shape).toContain('"deviceId"')
  })

  it('collapses an IN list to its WIDTH so paging does not mint a row per page', () => {
    const three = sqlShape(selectOn(TRACKS, ' WHERE "id" IN (?, ?, ?) LIMIT ?'), TRACKS)
    expect(three).toContain('IN (?×3)')
  })

  it('gives the same shape to two IN pages of the same width', () => {
    const a = sqlShape(selectOn(TRACKS, ' WHERE "id" IN (?, ?) LIMIT ?'), TRACKS)
    const b = sqlShape(selectOn(TRACKS, ' WHERE "id" IN (?, ?) LIMIT ?'), TRACKS)
    expect(a).toBe(b)
  })

  it('keeps the WIDTH distinct — one row read and five hundred are not one call site', () => {
    const one = sqlShape(selectOn(TRACKS, ' WHERE "id" IN (?) LIMIT ?'), TRACKS)
    const many = sqlShape(selectOn(TRACKS, ' WHERE "id" IN (?, ?, ?) LIMIT ?'), TRACKS)
    expect(one).not.toBe(many)
  })

  it('names a write without repeating its column list or its conflict clause', () => {
    const shape = sqlShape(
      `INSERT INTO "${TRACKS}" ("id", "deviceId") VALUES (?, ?) ON CONFLICT("id") DO UPDATE SET "deviceId" = excluded."deviceId"`,
      TRACKS,
    )
    expect(shape).toBe('INSERT INTO <t> (…) VALUES (…) ON CONFLICT("id") DO UPDATE SET …')
  })

  it('collapses whitespace so an indented statement is the same call site', () => {
    const shape = sqlShape(`SELECT "id"\n  FROM "${TRACKS}"\n  WHERE "deviceId" = ?`, TRACKS)
    expect(shape).toBe('SELECT … FROM <t> WHERE "deviceId" = ?')
  })

  it('truncates a pathological statement rather than pushing the numbers off the line', () => {
    const wide = Array.from({ length: 80 }, (_, i) => `"c${i}" = ?`).join(' AND ')
    const shape = sqlShape(selectOn(TRACKS, ` WHERE ${wide}`), TRACKS)
    expect(shape.length).toBe(SQL_SHAPE_MAX_LENGTH + SQL_SHAPE_ELLIPSIS.length)
    expect(shape.endsWith(SQL_SHAPE_ELLIPSIS)).toBe(true)
  })

  it('never carries a bound value — a profiler line is not a place for user data', () => {
    const shape = sqlShape(selectOn(TRACKS, ` WHERE "deviceId" = ? AND "id" = ?`), TRACKS)
    expect(shape).not.toMatch(/\d{3}/)
  })
})
