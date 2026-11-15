/**
 * #570 — the Logs page export asks the hub's route with the hub's defaults:
 * the six-hour choice sends no `since`, so the page and the MCP tool share one
 * default; filters go as the comma lists the route reads.
 */
import { describe, expect, it } from 'vitest'
import { isLogExportRange, logExportFileName, logExportQuery } from '../log-export-url'

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
