/**
 * #570 — the Logs page export asks the hub's route with the hub's defaults:
 * the six-hour choice sends no `since`, so the page and the MCP tool share one
 * default; filters go as the comma lists the route reads.
 */
import { describe, expect, it } from 'vitest'
import {
  clampRangeToReach,
  initialExportSource,
  isLogExportRange,
  type LogSourceReach,
  logExportFileName,
  logExportQuery,
  logExportScopeOf,
  rangeExceedsReach,
  rangesWithinReach,
  sourceReach,
} from '../log-export'

const NOW = Date.parse('2026-11-15T12:00:00.000Z')

describe('logExportQuery', () => {
  it('everything over the last six hours sends no parameter', () => {
    expect(logExportQuery({ components: [], deviceIds: [], rangeHours: 6 }, NOW)).toBe('')
  })

  it('components, devices and another range', () => {
    const url = new URL(
      `/api/logs/export${logExportQuery(
        { components: ['recorder', 'provider-onvif'], deviceIds: [101, 7], rangeHours: 24 },
        NOW,
      )}`,
      'http://x',
    )
    expect(url.searchParams.get('components')).toBe('recorder,provider-onvif')
    expect(url.searchParams.get('deviceIds')).toBe('101,7')
    expect(url.searchParams.get('since')).toBe(String(NOW - 24 * 3_600_000))
  })

  it('only the offered ranges are accepted, and the file is NDJSON', () => {
    expect(isLogExportRange(6)).toBe(true)
    expect(isLogExportRange(5)).toBe(false)
    expect(logExportFileName(NOW)).toBe('camstack-logs-2026-11-15T12-00-00-000Z.ndjson')
  })
})

const source = (over: Partial<LogSourceReach> & { addonId: string }): LogSourceReach => ({
  readable: true,
  reason: null,
  isDefault: false,
  retentionDays: null,
  ...over,
})

describe('the export source', () => {
  it('goes on the query, and a stream without one sends none', () => {
    const sel = { components: [], deviceIds: [], rangeHours: 6 as const }
    expect(logExportQuery({ ...sel, source: 'loki-logging' }, NOW)).toBe('?source=loki-logging')
    expect(logExportQuery(sel, NOW)).toBe('')
  })
})

describe('logExportScopeOf (what the stream pre-fills)', () => {
  it('an addon-locked stream exports that component, a device-locked one that device', () => {
    expect(logExportScopeOf({ addonId: 'recorder', deviceId: 101, source: 'x' })).toEqual({
      components: ['recorder'],
      deviceIds: [101],
      source: 'x',
    })
  })

  it('a container subtree exports the container, and an open stream exports everything', () => {
    expect(logExportScopeOf({ containerDeviceId: 7, deviceId: 9 }).deviceIds).toEqual([7])
    expect(logExportScopeOf({})).toEqual({ components: [], deviceIds: [], source: undefined })
  })
})

describe('what a source can reach', () => {
  it('unknown retention is unknown, never zero days; unreadable keeps its reason', () => {
    expect(sourceReach(source({ addonId: 'a', retentionDays: null }))).toEqual({ kind: 'unknown' })
    expect(sourceReach(source({ addonId: 'a', retentionDays: 14 }))).toEqual({
      kind: 'days',
      days: 14,
    })
    expect(
      sourceReach(source({ addonId: 'a', readable: false, reason: 'no URL configured' })),
    ).toEqual({ kind: 'unreadable', reason: 'no URL configured' })
  })

  it('a range beyond the retention is brought down to the longest one it reaches', () => {
    expect(rangeExceedsReach(168, 2)).toBe(true)
    expect(clampRangeToReach(168, 2)).toBe(24)
    expect(clampRangeToReach(168, 7)).toBe(168)
    expect(rangesWithinReach(3)).toEqual([1, 6, 24, 72])
  })

  it('an unknown reach never clamps, and a sub-hour reach still offers the shortest range', () => {
    expect(clampRangeToReach(168, null)).toBe(168)
    expect(rangesWithinReach(null)).toEqual([1, 6, 24, 72, 168])
    expect(rangesWithinReach(0)).toEqual([1])
  })
})

describe('initialExportSource', () => {
  const sources = [
    source({ addonId: 'winston-logging', isDefault: true }),
    source({ addonId: 'loki-logging' }),
    source({ addonId: 'console-logging', readable: false }),
  ]
  it('keeps the stream source when readable, else the default readable one', () => {
    expect(initialExportSource('loki-logging', sources)).toBe('loki-logging')
    expect(initialExportSource('console-logging', sources)).toBe('winston-logging')
    expect(initialExportSource(undefined, sources)).toBe('winston-logging')
  })
})
