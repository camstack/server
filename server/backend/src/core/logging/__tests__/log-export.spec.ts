/**
 * #570 — the log export: components and/or devices over a time range, by
 * default everything over the last six hours, one NDJSON line per entry with
 * its tags (deviceId included). One implementation behind the admin Logs page
 * and the ops MCP tool.
 */

import type { LogReadEntry, LogReadQuery, LogReadResult } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  exportLogEntries,
  LOG_EXPORT_DEFAULT_WINDOW_MS,
  parseLogExportRequest,
  toNdjsonLine,
} from '../log-export'

const NOW = Date.parse('2026-11-15T12:00:00.000Z')
const MIN = 60_000

function line(
  id: string,
  minutesAgo: number,
  tags: Record<string, string | number> = {},
): LogReadEntry {
  return {
    id,
    timestamp: NOW - minutesAgo * MIN,
    level: 'info',
    message: `m ${id}`,
    ...(Object.keys(tags).length > 0 ? { tags } : {}),
  }
}

/** A source that honours the read contract's indexed filters and pages by index. */
function store(all: readonly LogReadEntry[]): {
  readonly read: (q: LogReadQuery) => Promise<LogReadResult>
  readonly queries: LogReadQuery[]
} {
  const queries: LogReadQuery[] = []
  const newestFirst = all.toSorted((a, b) => b.timestamp - a.timestamp)
  return {
    queries,
    read: async (q) => {
      queries.push(q)
      const matching = newestFirst.filter(
        (e) =>
          (q.deviceId === undefined || e.tags?.['deviceId'] === q.deviceId) &&
          (q.fromAddonId === undefined || e.tags?.['addonId'] === q.fromAddonId) &&
          (q.since === undefined || e.timestamp >= q.since) &&
          (q.until === undefined || e.timestamp <= q.until),
      )
      const start = q.before === undefined ? 0 : Number(q.before)
      const limit = q.limit ?? 200
      const entries = matching.slice(start, start + limit)
      const next = start + entries.length
      const done = next >= matching.length
      return {
        entries,
        nextBefore: done ? null : String(next),
        nextAfter: null,
        scannedBytes: 0,
        done,
      }
    },
  }
}

async function ids(gen: AsyncIterable<LogReadEntry>): Promise<string[]> {
  const out: string[] = []
  for await (const e of gen) out.push(e.id ?? '')
  return out
}

const FIXTURE: readonly LogReadEntry[] = [
  line('a1-d1', 10, { addonId: 'a', deviceId: 1 }),
  line('a1-d2', 20, { addonId: 'a', deviceId: 2 }),
  line('b-d1', 30, { addonId: 'b', deviceId: 1 }),
  line('c-d1', 40, { addonId: 'c', deviceId: 1 }),
  line('kernel', 50),
  line('b-nodev', 60, { addonId: 'b' }),
  line('a-old', 7 * 60, { addonId: 'a', deviceId: 1 }),
]

describe('parseLogExportRequest', () => {
  it('defaults to everything over the last six hours', () => {
    const parsed = parseLogExportRequest({}, NOW)
    expect(parsed).toEqual({
      ok: true,
      request: {
        components: [],
        deviceIds: [],
        since: NOW - LOG_EXPORT_DEFAULT_WINDOW_MS,
        until: NOW,
      },
    })
    expect(LOG_EXPORT_DEFAULT_WINDOW_MS).toBe(6 * 60 * MIN)
  })

  it('reads comma-separated components and devices, and an explicit range', () => {
    const parsed = parseLogExportRequest(
      { components: 'a, b', deviceIds: '1,2', since: '1000', until: '2000', level: 'warn' },
      NOW,
    )
    expect(parsed).toEqual({
      ok: true,
      request: {
        components: ['a', 'b'],
        deviceIds: [1, 2],
        since: 1000,
        until: 2000,
        level: 'warn',
      },
    })
  })

  it('refuses a non-numeric device and an inverted range', () => {
    expect(parseLogExportRequest({ deviceIds: 'cam' }, NOW).ok).toBe(false)
    expect(parseLogExportRequest({ since: '2000', until: '1000' }, NOW).ok).toBe(false)
  })
})

describe('exportLogEntries', () => {
  it('with no filter: every line in the default window, newest first, older ones left out', async () => {
    const src = store(FIXTURE)
    const request = parseLogExportRequest({}, NOW)
    if (!request.ok) throw new Error(request.error)
    const got = await ids(exportLogEntries({ request: request.request, read: src.read }))
    expect(got).toEqual(['a1-d1', 'a1-d2', 'b-d1', 'c-d1', 'kernel', 'b-nodev'])
    expect(src.queries[0]).toMatchObject({ since: NOW - 6 * 60 * MIN, until: NOW })
  })

  it('components OR, devices OR, the two facets AND — merged newest first across pages', async () => {
    const src = store(FIXTURE)
    const got = await ids(
      exportLogEntries({
        request: {
          components: ['a', 'b'],
          deviceIds: [1],
          since: NOW - 6 * 60 * MIN,
          until: NOW,
        },
        read: src.read,
        pageLimit: 1,
      }),
    )
    expect(got).toEqual(['a1-d1', 'b-d1'])
    // The filters reach the source as indexed fields, one read per pair.
    expect(src.queries.some((q) => q.fromAddonId === 'a' && q.deviceId === 1)).toBe(true)
    expect(src.queries.some((q) => q.fromAddonId === 'b' && q.deviceId === 1)).toBe(true)
  })

  it('devices only: every component of those devices', async () => {
    const src = store(FIXTURE)
    const got = await ids(
      exportLogEntries({
        request: { components: [], deviceIds: [1], since: NOW - 6 * 60 * MIN, until: NOW },
        read: src.read,
        pageLimit: 2,
      }),
    )
    expect(got).toEqual(['a1-d1', 'b-d1', 'c-d1'])
  })
})

describe('toNdjsonLine', () => {
  it('one JSON object per line, with the tags kept and deviceId as a string', () => {
    const text = toNdjsonLine(line('x', 1, { addonId: 'a', deviceId: 42 }))
    expect(text.endsWith('\n')).toBe(true)
    expect(text.indexOf('\n')).toBe(text.length - 1)
    const parsed: unknown = JSON.parse(text)
    expect(parsed).toMatchObject({
      id: 'x',
      timestamp: new Date(NOW - MIN).toISOString(),
      level: 'info',
      message: 'm x',
      tags: { addonId: 'a', deviceId: '42' },
    })
  })
})
