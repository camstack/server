import { describe, expect, it } from 'vitest'
import { text } from '@camstack/develop'
import { groupEntries, messageKey, opsLogs, CONTEXT_RADIUS_MS } from '../mcp/ops-logs.js'
import { opsEvents, opsTrack, resolveLinkBase } from '../mcp/ops-events.js'
import { fakeHub, noSessionContext } from './ops-fake-hub.js'

const NOW = Date.parse('2026-10-30T12:00:00.000Z')
const iso = (msBefore: number): string => new Date(NOW - msBefore).toISOString()

const entry = (msBefore: number, message: string, over: object = {}): object => ({
  timestamp: iso(msBefore),
  level: 'warn',
  message,
  tags: { deviceId: '584' },
  ...over,
})

describe('ops_logs grouping', () => {
  it('folds ids and numbers so repeats group, and sorts severity first', () => {
    expect(messageKey('track 08mfhfsja4 lag 120ms')).toBe(messageKey('track mypy33mg2r lag 5ms'))
    expect(messageKey('getDeviceStatusAggregate failed')).toBe('getDeviceStatusAggregate failed')
    const groups = groupEntries([
      { timestamp: iso(3000), level: 'info', message: 'lag 1ms' },
      { timestamp: iso(2000), level: 'info', message: 'lag 22ms' },
      { timestamp: iso(1000), level: 'error', message: 'boom' },
    ])
    expect(groups.map((g) => [g.level, g.count])).toEqual([
      ['error', 1],
      ['info', 2],
    ])
  })
})

describe('ops_logs tiers', () => {
  const sources = [{ addonId: 'winston-logging', readable: true, isDefault: true }]

  it('answers from the ring when it reaches back to the window start', async () => {
    const { ctx, calls } = fakeHub({
      'logs.query': {
        entries: [entry(60_000, 'a'), entry(1_000, 'a')],
        done: true,
        source: 'ring',
      },
      'logs.sources': sources,
    })
    const out = await opsLogs(ctx, { deviceId: 584, windowMinutes: 1 }, NOW)
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.tier).toBe('ring')
    expect(out.groups?.[0]).toMatchObject({ count: 2, deviceId: '584' })
    expect(calls[0]?.input).toMatchObject({
      source: 'ring',
      tags: { deviceId: '584' },
    })
    expect(calls.some((c) => c.path === 'logs.sources')).toBe(false)
  })

  it('falls through to the persisted tier when the ring is too short, and says so', async () => {
    const { ctx } = fakeHub({
      'logs.query': (input: unknown) => {
        const source =
          typeof input === 'object' && input !== null && 'source' in input ? input.source : null
        return source === 'ring'
          ? { entries: [entry(1_000, 'recent')], done: true, source: 'ring' }
          : {
              entries: [entry(3_600_000, 'old'), entry(1_000, 'recent')],
              done: true,
              source: 'winston-logging',
            }
      },
      'logs.sources': sources,
    })
    const out = await opsLogs(ctx, { windowMinutes: 120 }, NOW)
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.tier).toBe('persisted:winston-logging')
    expect(out.tiersTried).toEqual(['ring', 'persisted:winston-logging'])
    expect(out.groups).toHaveLength(2)
  })

  it('refuses a protected credential instead of calling logs.query', async () => {
    const { ctx, calls } = fakeHub({}, 'protected')
    const out = await opsLogs(ctx, {}, NOW)
    expect(out).toMatchObject({ status: 'refused' })
    expect(calls).toHaveLength(0)
  })

  it('answers no-session without a hub', async () => {
    expect(await opsLogs(noSessionContext(), {}, NOW)).toMatchObject({
      status: 'no-session',
    })
  })

  it('context mode returns the lines around the first match, oldest first', async () => {
    const at = 600_000
    const lines = [
      entry(at + 2_000, 'before-2'),
      entry(at + 1_000, 'before-1'),
      entry(at, 'the track 08mfhfsja4 was born'),
      entry(at - 1_000, 'after-1'),
    ]
    const { ctx, calls } = fakeHub({
      'logs.query': (input: unknown) => {
        const text =
          typeof input === 'object' && input !== null && 'text' in input ? input.text : null
        return text === '08mfhfsja4'
          ? { entries: [lines[2]], done: true, source: 'ring' }
          : { entries: lines, done: true, source: 'ring' }
      },
      'logs.sources': sources,
    })
    const out = await opsLogs(
      ctx,
      { around: '08mfhfsja4', windowMinutes: 60, contextLines: 1 },
      NOW,
    )
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.context?.lines.map((l) => l.message)).toEqual([
      'before-1',
      'the track 08mfhfsja4 was born',
      'after-1',
    ])
    const second = calls.filter((c) => c.path === 'logs.query').at(-1)?.input
    expect(second).toMatchObject({ tags: { deviceId: '584' } })
    const bounds = second as { since: number; until: number }
    expect(bounds.until - bounds.since).toBe(2 * CONTEXT_RADIUS_MS)
  })

  it('never lets a secret through the output scrub', async () => {
    const { ctx } = fakeHub({
      'logs.query': {
        entries: [
          entry(1_000, 'login failed password=hunter2hunter2 token=abcdef0123456789abcdef'),
        ],
        done: true,
        source: 'ring',
      },
      'logs.sources': sources,
    })
    const out = await opsLogs(ctx, {}, NOW)
    const wire = text(out).content[0]?.text ?? ''
    expect(wire).toContain('login failed')
    expect(wire).not.toContain('hunter2hunter2')
    expect(wire).not.toContain('abcdef0123456789abcdef')
  })
})

const addresses = {
  roles: {
    appConnections: {
      resolved: ['http://127.0.0.1:4480', 'http://192.168.1.9:4480/'],
    },
  },
}

const TRACK = {
  trackId: 't1',
  deviceId: 584,
  className: 'person',
  firstSeen: 1_000,
  lastSeen: 61_000,
  state: 'moving',
  active: false,
  positions: [],
  bestEventId: '77',
  hasFace: true,
}

describe('ops_events links', () => {
  it('builds links from the flagged app address and never from loopback', async () => {
    const link = await resolveLinkBase({ call: async () => addresses })
    expect(link.base).toBe('http://192.168.1.9:4480')
  })

  it('reports why there are no links when only loopback is flagged', async () => {
    const link = await resolveLinkBase({
      call: async () => ({
        roles: { appConnections: { resolved: ['http://127.0.0.1:4480'] } },
      }),
    })
    expect(link.base).toBeNull()
    expect(link.reason).toContain('non-loopback')
  })

  it('lists tracks with links, filtered by class', async () => {
    const { ctx } = fakeHub({
      'localNetwork.getAddresses': addresses,
      'deviceManager.listAll': [{ id: 584, name: 'Porch' }],
      'pipelineAnalytics.listRecentTracks': {
        tracks: [TRACK, { ...TRACK, trackId: 't2', className: 'car' }],
      },
      'pipelineAnalytics.getObjectEvents': [
        { id: 77, timestamp: 2_000, className: 'person', trackId: 't1' },
      ],
    })
    const out = await opsEvents(ctx, { deviceId: 584, className: 'person' }, NOW)
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.tracks.map((t) => t.trackId)).toEqual(['t1'])
    expect(out.tracks[0]?.links.viewer).toContain('http://192.168.1.9:4480/')
    expect(out.tracks[0]?.links.viewer).not.toContain('127.0.0.1')
    expect(out.events).toHaveLength(1)
  })

  it('a failed track read is unavailable, not an empty list of tracks', async () => {
    const { ctx } = fakeHub({
      'localNetwork.getAddresses': addresses,
      'deviceManager.listAll': [{ id: 584, name: 'Porch' }],
      'pipelineAnalytics.listRecentTracks': new Error('analytics down'),
    })
    const out = await opsEvents(ctx, { deviceId: 584 }, NOW)
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.unavailable['tracks']).toContain('analytics down')
  })
})

describe('ops_track media audit', () => {
  const media = (kinds: string[]): object[] =>
    kinds.map((kind, i) => ({
      mediaId: i,
      kind,
      sizeBytes: 10,
      timestamp: 1_000 + i,
    }))
  const base = {
    'localNetwork.getAddresses': addresses,
    'pipelineAnalytics.getTrack': TRACK,
  }

  it('names the recorded reason for a missing keyFrame and the cascade after it', async () => {
    const { ctx } = fakeHub({
      ...base,
      'pipelineAnalytics.getTrack': {
        ...TRACK,
        previewMissReason: 'parcel-evicted',
      },
      'pipelineAnalytics.listTrackMedia': media(['firstFrame']),
    })
    const out = await opsTrack(ctx, { deviceId: 584, trackId: 't1' })
    if (out.status !== 'ok') throw new Error('expected ok')
    const missing = Object.fromEntries((out.media?.missing ?? []).map((m) => [m.kind, m.reason]))
    expect(missing['keyFrame']).toBe('parcel-evicted')
    expect(missing['lastFrame']).toContain('follows the missing keyFrame: parcel-evicted')
    expect(missing['thumbnail']).toContain('follows the missing keyFrame')
    expect(missing['firstFrame']).toBeUndefined()
  })

  it('an unreadable media index is null, never "no media"', async () => {
    const { ctx } = fakeHub({
      ...base,
      'pipelineAnalytics.listTrackMedia': new Error('media store down'),
    })
    const out = await opsTrack(ctx, { deviceId: 584, trackId: 't1' })
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.media).toBeNull()
    expect(out.unavailable['media']).toContain('media store down')
  })

  it('an unknown track is found:false and an active track expects nothing yet', async () => {
    const gone = await opsTrack(
      fakeHub({
        ...base,
        'pipelineAnalytics.getTrack': null,
        'pipelineAnalytics.listTrackMedia': [],
      }).ctx,
      { deviceId: 584, trackId: 'zz' },
    )
    expect(gone).toMatchObject({ found: false })
    const live = await opsTrack(
      fakeHub({
        ...base,
        'pipelineAnalytics.getTrack': { ...TRACK, active: true },
        'pipelineAnalytics.listTrackMedia': [],
      }).ctx,
      { deviceId: 584, trackId: 't1' },
    )
    if (live.status !== 'ok') throw new Error('expected ok')
    expect(live.media?.missing).toEqual([])
  })
})
