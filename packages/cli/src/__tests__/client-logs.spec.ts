import { describe, expect, it } from 'vitest'
import { clientLogs, parseViewerLine } from '../mcp/client-logs.js'
import { asProtectedTier } from './configure-fixtures.js'
import { fakeHub } from './ops-fake-hub.js'

const NOW = Date.parse('2026-11-03T12:00:00Z')
const iso = (minAgo: number): string => new Date(NOW - minAgo * 60_000).toISOString()

const viewerLine = (
  minAgo: number,
  level: string,
  scope: string,
  msg: string,
  tags: { [k: string]: string } = {},
): { [k: string]: unknown } => ({
  timestamp: iso(minAgo),
  level: level === 'debug' ? 'info' : level,
  scope: 'stream-broker',
  message: `[app:${level}:${scope}] ${msg}`,
  tags: { source: 'viewer', deviceId: '1', ...tags },
})

const tagged = [
  viewerLine(10, 'warn', 'live', 'stalled', {
    user: 'gian',
    platform: 'ios',
    appVersion: '1.4',
    clientSessionId: 's1',
  }),
  viewerLine(20, 'error', 'playback', 'seek failed', {
    user: 'gian',
    platform: 'ios',
    clientSessionId: 's1',
  }),
  viewerLine(5, 'debug', 'live', 'tick', { clientSessionId: 's2' }),
]

const hub = (answer: unknown): ReturnType<typeof fakeHub> =>
  fakeHub({ 'logs.query': answer, 'logs.sources': [] })

const page = (entries: readonly unknown[]): { [k: string]: unknown } => ({
  entries,
  done: true,
  source: 'ring',
})

describe('client_logs', () => {
  it('reads viewer lines by tag, oldest first, with level and scope parsed from the message', async () => {
    const { ctx, calls } = hub(page(tagged))
    const out = await clientLogs(ctx, { deviceId: 1 }, NOW)
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.match).toBe('tag')
    expect(out.lines?.map((l) => [l.level, l.scope, l.message])).toEqual([
      ['error', 'playback', 'seek failed'],
      ['warn', 'live', 'stalled'],
      ['debug', 'live', 'tick'],
    ])
    expect(out.lines?.[1]).toMatchObject({
      user: 'gian',
      platform: 'ios',
      appVersion: '1.4',
      sessionId: 's1',
    })
    expect(out.bySession).toEqual({ s1: 2, s2: 1 })
    const first = calls.find((c) => c.path === 'logs.query')?.input
    expect(JSON.stringify(first)).toContain('"source":"viewer"')
  })

  it('filters by viewer level floor and scope', async () => {
    const { ctx } = hub(page(tagged))
    const warn = await clientLogs(ctx, { level: 'warn' }, NOW)
    const live = await clientLogs(ctx, { scope: 'live' }, NOW)
    if (warn.status !== 'ok' || live.status !== 'ok') throw new Error('expected ok')
    expect(warn.lines?.map((l) => l.message)).toEqual(['seek failed', 'stalled'])
    expect(live.lines?.map((l) => l.message)).toEqual(['stalled', 'tick'])
  })

  it('an older hub (no tag) is found by the [app: text, and says so', async () => {
    const legacy = [{ ...viewerLine(3, 'warn', 'live', 'old line'), tags: { deviceId: '1' } }]
    const { ctx } = hub((input: unknown) => {
      const tags =
        typeof input === 'object' && input !== null && 'tags' in input ? input.tags : null
      const wantsViewer = typeof tags === 'object' && tags !== null && 'source' in tags
      return page(wantsViewer ? [] : legacy)
    })
    const out = await clientLogs(ctx, {}, NOW)
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.match).toBe('text-legacy')
    expect(out.lines?.[0]?.message).toBe('old line')
  })

  it('an identity filter does not fall back to the text grep', async () => {
    const { ctx, calls } = hub(page([]))
    const out = await clientLogs(ctx, { user: 'gian' }, NOW)
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.lines).toEqual([])
    expect(
      JSON.stringify(calls.filter((c) => c.path === 'logs.query').map((c) => c.input)),
    ).not.toContain('[app:')
  })

  it('a failed read is lines null with a reason, never an empty list', async () => {
    const { ctx } = hub(new Error('ring down'))
    const out = await clientLogs(ctx, {}, NOW)
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.lines).toBeNull()
    expect(out.total).toBeNull()
    expect(Object.keys(out.unavailable).length).toBeGreaterThan(0)
  })

  it('refuses a protected credential and an unreadable since', async () => {
    const { ctx } = hub(page([]))
    expect(JSON.stringify(await clientLogs(await asProtectedTier(ctx), {}, NOW))).toMatch(/admin/i)
    expect((await clientLogs(ctx, { since: 'soon' }, NOW)).status).not.toBe('ok')
  })

  it('parseViewerLine leaves a non-viewer message whole', () => {
    expect(parseViewerLine({ timestamp: iso(1), level: 'info', message: 'plain' })).toMatchObject({
      level: null,
      scope: null,
      message: 'plain',
    })
  })
})
