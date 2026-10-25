import { describe, it, expect } from 'vitest'
import {
  presetToRange,
  isRangeActive,
  filterFacesByDateRange,
  filterFacesByCameras,
  distinctDeviceIds,
  dateInputToStartMs,
  dateInputToEndMs,
  msToDateInput,
  formatFaceTimestamp,
  formatFaceTimestampFull,
  EMPTY_DATE_RANGE,
} from '../face-gallery-filters.js'

interface Row {
  readonly faceId: string
  readonly deviceId: number
  readonly timestamp: number
}

const NOW = 1_700_000_000_000
const HOUR = 3_600_000
const DAY = 24 * HOUR

const rows: readonly Row[] = [
  { faceId: 'a', deviceId: 1, timestamp: NOW - 2 * HOUR }, // 2h ago
  { faceId: 'b', deviceId: 2, timestamp: NOW - 2 * DAY }, // 2d ago
  { faceId: 'c', deviceId: 1, timestamp: NOW - 10 * DAY }, // 10d ago
  { faceId: 'd', deviceId: 3, timestamp: NOW - 40 * DAY }, // 40d ago
]

describe('presetToRange / isRangeActive', () => {
  it('all is an open (inactive) range', () => {
    expect(presetToRange('all', NOW)).toEqual(EMPTY_DATE_RANGE)
    expect(isRangeActive(presetToRange('all', NOW))).toBe(false)
  })
  it('24h/7d/30d anchor fromMs relative to now, leave toMs open', () => {
    expect(presetToRange('24h', NOW)).toEqual({ fromMs: NOW - DAY, toMs: null })
    expect(presetToRange('7d', NOW)).toEqual({ fromMs: NOW - 7 * DAY, toMs: null })
    expect(presetToRange('30d', NOW)).toEqual({ fromMs: NOW - 30 * DAY, toMs: null })
    expect(isRangeActive(presetToRange('7d', NOW))).toBe(true)
  })
})

describe('filterFacesByDateRange', () => {
  it('returns a copy when the range is open', () => {
    const out = filterFacesByDateRange(rows, EMPTY_DATE_RANGE)
    expect(out).toEqual(rows)
    expect(out).not.toBe(rows)
  })
  it('keeps only faces within an inclusive lower bound', () => {
    const out = filterFacesByDateRange(rows, presetToRange('7d', NOW))
    expect(out.map((r) => r.faceId)).toEqual(['a', 'b'])
  })
  it('applies both bounds inclusively', () => {
    const out = filterFacesByDateRange(rows, { fromMs: NOW - 11 * DAY, toMs: NOW - 1 * DAY })
    expect(out.map((r) => r.faceId)).toEqual(['b', 'c'])
  })
})

describe('filterFacesByCameras', () => {
  it('empty set = no filter (copy)', () => {
    const out = filterFacesByCameras(rows, new Set<number>())
    expect(out).toEqual(rows)
    expect(out).not.toBe(rows)
  })
  it('keeps only selected cameras, order preserved', () => {
    expect(filterFacesByCameras(rows, new Set([1])).map((r) => r.faceId)).toEqual(['a', 'c'])
    expect(filterFacesByCameras(rows, new Set([2, 3])).map((r) => r.faceId)).toEqual(['b', 'd'])
  })
})

describe('distinctDeviceIds', () => {
  it('returns first-seen unique device ids', () => {
    expect(distinctDeviceIds(rows)).toEqual([1, 2, 3])
    expect(distinctDeviceIds([])).toEqual([])
  })
})

describe('date input helpers', () => {
  it('start/end of day bracket the whole day', () => {
    const start = dateInputToStartMs('2026-04-03')
    const end = dateInputToEndMs('2026-04-03')
    expect(start).not.toBeNull()
    expect(end).not.toBeNull()
    if (start !== null && end !== null) {
      expect(end - start).toBeGreaterThan(23 * HOUR)
      expect(end - start).toBeLessThan(DAY)
    }
  })
  it('empty string → null', () => {
    expect(dateInputToStartMs('')).toBeNull()
    expect(dateInputToEndMs('')).toBeNull()
  })
  it('msToDateInput round-trips a start-of-day value', () => {
    const start = dateInputToStartMs('2026-04-03')
    expect(start).not.toBeNull()
    if (start !== null) expect(msToDateInput(start)).toBe('2026-04-03')
    expect(msToDateInput(null)).toBe('')
  })
})

describe('formatFaceTimestamp', () => {
  it('bogus timestamps render as a dash', () => {
    expect(formatFaceTimestamp(0, NOW)).toBe('—')
    expect(formatFaceTimestamp(-5, NOW)).toBe('—')
    expect(formatFaceTimestamp(Number.NaN, NOW)).toBe('—')
  })
  it('recent values are relative', () => {
    expect(formatFaceTimestamp(NOW - 30_000, NOW)).toBe('just now')
    expect(formatFaceTimestamp(NOW - 5 * 60_000, NOW)).toBe('5m ago')
    expect(formatFaceTimestamp(NOW - 3 * HOUR, NOW)).toBe('3h ago')
    expect(formatFaceTimestamp(NOW - 2 * DAY, NOW)).toBe('2d ago')
  })
  it('values a week or older become a short absolute date', () => {
    expect(formatFaceTimestamp(NOW - 10 * DAY, NOW)).not.toMatch(/ago/)
  })
})

describe('formatFaceTimestampFull', () => {
  it('bogus → dash, real → non-empty string', () => {
    expect(formatFaceTimestampFull(0)).toBe('—')
    expect(formatFaceTimestampFull(NOW).length).toBeGreaterThan(0)
  })
})
