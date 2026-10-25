/**
 * D898 — reading history back from Loki.
 */
import { describe, expect, it } from 'vitest'
import type { LogReadEntry } from '@camstack/types'
import { LokiDestination, type LokiConfig, type LokiFetch } from '../loki-destination.js'
import {
  buildLogQl,
  parseQueryRange,
  readLokiBackward,
  type LokiRangeQuery,
  type LokiRow,
} from '../loki-read.js'

const NOW = Date.parse('2026-10-21T12:00:00.000Z')

interface Fake {
  readonly ms: number
  readonly level: string
  readonly line: Record<string, unknown>
}

/** A fake `query_range` over an in-memory set, honouring start/end/limit/backward. */
function fakeRange(data: readonly Fake[]): { range: LokiRangeQuery; calls: string[] } {
  const calls: string[] = []
  const body = {
    data: {
      result: data.map((d) => ({
        stream: { job: 'camstack', node: 'hub', level: d.level },
        values: [[`${String(d.ms)}000000`, JSON.stringify(d.line)]],
      })),
    },
  }
  const all = parseQueryRange(body)
  const range: LokiRangeQuery = async ({ logql, startNs, endNs, limit }) => {
    calls.push(logql)
    const rows: LokiRow[] = all.filter((r) => r.ns >= startNs && r.ns < endNs).slice(0, limit)
    return { rows, bytes: rows.length * 100 }
  }
  return { range, calls }
}

describe('LogQL for a read', () => {
  it('labels for node and level, line filters for device, addon and text', () => {
    expect(
      buildLogQl(
        {
          fromNodeId: 'agent-1',
          level: 'warn',
          deviceId: 101,
          fromAddonId: 'provider-x@1.0.0',
          text: 'a.b "c"',
        },
        { job: 'camstack' },
      ),
    ).toBe(
      '{job="camstack",node="agent-1",level=~"warn|error"} |= "\\"deviceId\\":101" |= "\\"addonId\\":\\"provider-x" |~ "(?i)a\\\\.b \\"c\\""',
    )
    expect(buildLogQl({}, { job: 'camstack' })).toBe('{job="camstack"}')
  })
})

describe('readLokiBackward', () => {
  it('pages without a gap or a duplicate when siblings share a millisecond', async () => {
    // 30 lines over 10 distinct milliseconds: every page cut lands mid-millisecond.
    const data: Fake[] = Array.from({ length: 30 }, (_, i) => ({
      ms: NOW - 60_000 + Math.floor(i / 3),
      level: 'info',
      line: { id: `x.${String(i)}`, message: `m${String(i)}`, tags: { deviceId: 7 } },
    }))
    const { range } = fakeRange(data)
    const seen: LogReadEntry[] = []
    let before: string | undefined
    for (let guard = 0; guard < 100; guard += 1) {
      const page = await readLokiBackward({
        query: { limit: 4, deviceId: 7, ...(before !== undefined ? { before } : {}) },
        labels: { job: 'camstack' },
        range,
        isCancelled: () => false,
        now: () => NOW,
      })
      seen.push(...page.entries)
      if (page.nextBefore === null) break
      before = page.nextBefore
    }
    const ids = seen.map((e) => e.id)
    expect(new Set(ids).size).toBe(30)
    expect(ids).toHaveLength(30)
    expect(seen.map((e) => e.timestamp)).toEqual(
      seen.map((e) => e.timestamp).toSorted((a, b) => b - a),
    )
  })

  it('applies the exact filter after the line filter (deviceId 61 is not 101)', async () => {
    const { range } = fakeRange([
      { ms: NOW - 1000, level: 'info', line: { message: 'a', tags: { deviceId: 101 } } },
      { ms: NOW - 2000, level: 'info', line: { message: 'b', tags: { deviceId: 61 } } },
    ])
    const page = await readLokiBackward({
      query: { deviceId: 61, limit: 10 },
      labels: { job: 'camstack' },
      range,
      isCancelled: () => false,
      now: () => NOW,
    })
    expect(page.entries.map((e) => e.message)).toEqual(['b'])
  })

  it('a cancelled slice says so and keeps its place', async () => {
    const { range } = fakeRange([])
    const page = await readLokiBackward({
      query: { limit: 10 },
      labels: { job: 'camstack' },
      range,
      isCancelled: () => true,
      now: () => NOW,
    })
    expect(page.cancelled).toBe(true)
    expect(page.done).toBe(false)
    expect(page.nextBefore).not.toBeNull()
  })
})

describe('LokiDestination.read', () => {
  const config: LokiConfig = {
    enabled: true,
    url: 'http://loki.example.com:3100/',
    job: 'camstack',
    node: 'hub',
    level: 'info',
    batchIntervalMs: 1000,
    batchSize: 100,
    extraLabels: '',
    tenantId: 'tenant-a',
    username: 'u',
    password: 'p',
    timeoutMs: 5000,
  }

  it('is not readable until configured', async () => {
    const dest = new LokiDestination({
      fetchFn: async () => ({ ok: true, status: 204, text: async () => '' }),
    })
    await dest.initialize({ ...config, url: '' })
    expect((await dest.describeRead()).readable).toBe(false)
  })

  it('GETs query_range with the push credentials and returns the parsed page', async () => {
    const urls: string[] = []
    const headers: Array<Readonly<Record<string, string>>> = []
    const fetchFn: LokiFetch = async (url, init) => {
      urls.push(url)
      headers.push(init.headers)
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: {
              result: [
                {
                  stream: { job: 'camstack', node: 'hub', level: 'warn' },
                  values: [
                    [
                      `${String(Date.now() - 1000)}000000`,
                      JSON.stringify({ id: 'b.1', message: 'hello', tags: { deviceId: 3 } }),
                    ],
                  ],
                },
              ],
            },
          }),
      }
    }
    const dest = new LokiDestination({ fetchFn })
    await dest.initialize(config)
    expect((await dest.describeRead()).readable).toBe(true)
    const page = await dest.read({ deviceId: 3, limit: 1, requestId: 'r1' })
    expect(page.entries).toEqual([
      expect.objectContaining({ id: 'b.1', message: 'hello', level: 'warn' }),
    ])
    const url = new URL(urls[0] ?? '')
    expect(url.pathname).toBe('/loki/api/v1/query_range')
    expect(url.searchParams.get('direction')).toBe('backward')
    expect(url.searchParams.get('query')).toContain('|= "\\"deviceId\\":3"')
    expect(headers[0]?.['X-Scope-OrgID']).toBe('tenant-a')
    expect(headers[0]?.['authorization']).toMatch(/^Basic /)
    await dest.shutdown()
  })
})
