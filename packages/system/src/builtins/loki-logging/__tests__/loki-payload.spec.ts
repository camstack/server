import { describe, it, expect } from 'vitest'
import type { LogEntry } from '@camstack/types'
import {
  buildPushBody,
  formatLokiLine,
  parseExtraLabels,
  sanitizeLabelName,
  toUnixNano,
} from '../loki-payload.js'

const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  timestamp: new Date('2026-07-26T10:00:00.000Z'),
  level: 'info',
  message: 'hello',
  ...over,
})

describe('toUnixNano', () => {
  it('appends nanosecond zeros instead of multiplying', () => {
    // `epochMs * 1e6` exceeds 2^53 for any present-day timestamp and silently
    // loses precision. String concatenation is exact.
    expect(toUnixNano(new Date('2026-07-26T10:00:00.000Z'))).toBe('1785060000000000000')
  })

  it('accepts the ISO string a broker round-trip leaves behind', () => {
    // Moleculer JSON-serializes Date → string, so a forwarded entry arrives as a
    // string even though the type says Date.
    expect(toUnixNano('2026-07-26T10:00:00.000Z')).toBe('1785060000000000000')
  })

  it('does not emit NaN for an unparseable timestamp', () => {
    // A NaN in the payload is a 400 from Loki for the WHOLE batch, which would
    // discard every good line alongside the bad one.
    expect(toUnixNano('not a date')).toBe('0000000')
  })
})

describe('label hygiene', () => {
  it('rewrites label names Loki would reject', () => {
    expect(sanitizeLabelName('my-label')).toBe('my_label')
    expect(sanitizeLabelName('9lives')).toBe('_9lives')
    expect(sanitizeLabelName('ok_name')).toBe('ok_name')
  })

  it('parses key=value pairs and drops malformed ones', () => {
    expect(parseExtraLabels('env=home, site=garage')).toEqual({ env: 'home', site: 'garage' })
    expect(parseExtraLabels('=novalue,noequals,k=')).toEqual({})
    expect(parseExtraLabels('')).toEqual({})
  })

  it('keeps a value containing = intact', () => {
    expect(parseExtraLabels('token=a=b')).toEqual({ token: 'a=b' })
  })
})

describe('formatLokiLine', () => {
  it('carries scope, tags and meta in the BODY, never as labels', () => {
    const line = formatLokiLine(
      entry({ scope: 'rtsp', tags: { deviceId: 7 }, meta: { attempt: 2 } }),
    )
    expect(JSON.parse(line)).toEqual({
      message: 'hello',
      scope: 'rtsp',
      tags: { deviceId: 7 },
      meta: { attempt: 2 },
    })
  })

  it('omits empty optionals rather than emitting nulls', () => {
    expect(JSON.parse(formatLokiLine(entry()))).toEqual({ message: 'hello' })
    expect(JSON.parse(formatLokiLine(entry({ scope: '', tags: {}, meta: {} })))).toEqual({
      message: 'hello',
    })
  })
})

describe('buildPushBody', () => {
  it('returns null for an empty batch so no request is made', () => {
    expect(buildPushBody([], { job: 'camstack', node: 'hub' })).toBeNull()
  })

  it('labels only job, node and level', () => {
    const body = buildPushBody([entry({ scope: 'rtsp', tags: { deviceId: 7 } })], {
      job: 'camstack',
      node: 'hub',
    })
    // The cardinality guarantee: at most 4 × nodes streams. If deviceId or scope
    // ever appears here, one busy install becomes millions of Loki streams.
    expect(Object.keys(body?.streams[0]?.stream ?? {}).toSorted()).toEqual(['job', 'level', 'node'])
  })

  it('splits one stream per level', () => {
    const body = buildPushBody(
      [entry({ level: 'info' }), entry({ level: 'error' }), entry({ level: 'info' })],
      { job: 'camstack', node: 'hub' },
    )
    expect(body?.streams).toHaveLength(2)
    const byLevel = new Map(body?.streams.map((s) => [s.stream['level'], s.values.length]))
    expect(byLevel.get('info')).toBe(2)
    expect(byLevel.get('error')).toBe(1)
  })

  it('sorts each stream by timestamp', () => {
    // Loki rejects out-of-order entries within a stream, and a batch is NOT
    // naturally ordered — entries arrive from concurrent producers.
    const body = buildPushBody(
      [
        entry({ timestamp: new Date('2026-07-26T10:00:02.000Z'), message: 'third' }),
        entry({ timestamp: new Date('2026-07-26T10:00:00.000Z'), message: 'first' }),
        entry({ timestamp: new Date('2026-07-26T10:00:01.000Z'), message: 'second' }),
      ],
      { job: 'camstack', node: 'hub' },
    )
    const messages = body?.streams[0]?.values.map((v) => JSON.parse(v[1]).message)
    expect(messages).toEqual(['first', 'second', 'third'])
  })

  it('sorts numerically, not lexicographically', () => {
    // Nanosecond strings of equal length compare correctly, but only because they
    // ARE equal length — this pins that assumption.
    const body = buildPushBody(
      [
        entry({ timestamp: new Date(1785103200999), message: 'b' }),
        entry({ timestamp: new Date(1785103200100), message: 'a' }),
      ],
      { job: 'camstack', node: 'hub' },
    )
    const values = body?.streams[0]?.values ?? []
    expect(values[0]?.[0].length).toBe(values[1]?.[0].length)
    expect(values.map((v) => JSON.parse(v[1]).message)).toEqual(['a', 'b'])
  })

  it('merges sanitized extra labels', () => {
    const body = buildPushBody([entry()], {
      job: 'camstack',
      node: 'agent-1',
      extra: parseExtraLabels('env=home,my-site=garage'),
    })
    expect(body?.streams[0]?.stream).toEqual({
      job: 'camstack',
      node: 'agent-1',
      level: 'info',
      env: 'home',
      my_site: 'garage',
    })
  })

  it('labels each entry with its origin node from tags.agentId, not the shipping node', () => {
    // The hub is the single Loki egress: agents forward their logs to it. If
    // every pushed line inherited the destination's node ('hub'), the whole
    // fleet would collapse onto node="hub" and the source would be lost.
    const body = buildPushBody([entry({ tags: { agentId: 'agent-a' } })], {
      job: 'camstack',
      node: 'hub',
    })
    expect(body?.streams[0]?.stream['node']).toBe('agent-a')
  })

  it('falls back to the configured node for an entry with no agentId tag', () => {
    const body = buildPushBody([entry({ tags: { deviceId: 7 } })], { job: 'camstack', node: 'hub' })
    expect(body?.streams[0]?.stream['node']).toBe('hub')
  })

  it('fans a mixed batch into one stream per (node, level)', () => {
    // A single flush on the hub carries hub-local lines alongside forwarded
    // agent lines. Each origin must get its own stream so Grafana can filter by
    // node — this is what makes cross-node logging usable.
    const body = buildPushBody(
      [
        entry({ tags: { agentId: 'hub' }, level: 'info' }),
        entry({ tags: { agentId: 'agent-a' }, level: 'info' }),
        entry({ tags: { agentId: 'agent-a' }, level: 'error' }),
      ],
      { job: 'camstack', node: 'hub' },
    )
    const byNodeLevel = new Map(
      body?.streams.map((s) => [`${s.stream['node']}/${s.stream['level']}`, s.values.length]),
    )
    expect(byNodeLevel.get('hub/info')).toBe(1)
    expect(byNodeLevel.get('agent-a/info')).toBe(1)
    expect(byNodeLevel.get('agent-a/error')).toBe(1)
    expect(body?.streams).toHaveLength(3)
  })
})
