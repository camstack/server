import { describe, expect, it } from 'vitest'
import { analyzeLogs, parseSince } from '../mcp/debug-logs.js'
import { debugReport } from '../mcp/debug-report.js'
import { asProtectedTier, ADDRESSES } from './configure-fixtures.js'
import { fakeHub, noSessionContext } from './ops-fake-hub.js'

const NOW = Date.parse('2026-11-03T12:00:00Z')
const iso = (minAgo: number): string => new Date(NOW - minAgo * 60_000).toISOString()

const line = (minAgo: number, message: string): { [k: string]: unknown } => ({
  timestamp: iso(minAgo),
  level: 'info',
  scope: 'stream-broker',
  message,
  tags: { deviceId: '1' },
})

/** #15: the derived stream flaps, the slots change every few minutes and detection restarts each time. */
const churnLines = [
  line(25, 'profile slot changed: 1/high -> main'),
  line(24, 'derived feeder restarting derived:web-720p (exit 1)'),
  line(20, 'profile slot changed: 1/low -> sub'),
  line(19, 'derived feeder restarting derived:web-720p (exit 1)'),
  line(15, 'profile slot changed: 1/high -> main'),
  line(14, 'derived feeder restarting derived:web-720p (exit 1)'),
]

describe('analyzeLogs', () => {
  const window = { sinceMs: NOW - 30 * 60_000, untilMs: NOW }
  it('counts churn per pattern and attributes derived restarts to the stream', () => {
    const out = analyzeLogs(
      churnLines.map((l) => ({
        timestamp: String(l['timestamp']),
        level: 'info',
        message: String(l['message']),
      })),
      window,
    )
    const slots = out.events.find((e) => e.id === 'profile-slot-changed')
    const feeder = out.events.find((e) => e.id === 'derived-feeder-restart')
    expect(slots?.count).toBe(3)
    expect(slots?.perHour).toBe(6)
    expect(slots?.medianGapSec).toBe(300)
    expect(feeder?.byDerivedStream).toEqual({ 'derived:web-720p': 3 })
  })
  it('an empty window yields no events, not zero-count rows', () => {
    expect(analyzeLogs([], window).events).toEqual([])
  })
})

describe('parseSince', () => {
  it('reads 30m / 2h / 1d / ISO and refuses nonsense', () => {
    expect(parseSince('30m', NOW, 5)).toBe(NOW - 30 * 60_000)
    expect(parseSince('2h', NOW, 5)).toBe(NOW - 2 * 3_600_000)
    expect(parseSince('1d', NOW, 5)).toBe(NOW - 86_400_000)
    expect(parseSince('2026-11-03T11:00:00Z', NOW, 5)).toBe(Date.parse('2026-11-03T11:00:00Z'))
    expect(parseSince(undefined, NOW, 5)).toBe(NOW - 5 * 60_000)
    expect(parseSince('soon', NOW, 5)).toBeNull()
  })
})

const media = (kinds: readonly string[]): readonly { [k: string]: unknown }[] =>
  kinds.map((kind, i) => ({ mediaId: 100 + i, kind, timestamp: NOW }))

const answers = (extra: { [path: string]: unknown } = {}): { [path: string]: unknown } => ({
  'nodes.topology': [{ id: 'hub', isHub: true, isOnline: true, addons: [] }],
  'serverManagement.getServerPackageStatus': { runningVersion: '1.2.523' },
  'alerts.list': [],
  'addons.listUpdates': [],
  'nodes.getNodeAddons': [{ id: 'stream-broker', status: 'running', version: '1.2.10' }],
  'deviceManager.listAll': [{ id: 1, name: 'Front' }],
  'pipelineOrchestrator.getCameraStatuses': [],
  'recordingArchive.getDeviceConfig': { enabled: false, bands: [] },
  'streamBroker.listAllCameraStreams': [
    { camStreamId: 'main', deviceId: 1, kind: 'pull-rtsp' },
    { camStreamId: 'derived:web-720p', deviceId: 1, kind: 'derived' },
  ],
  'streamBroker.listAllProfileSlots': [],
  'streamBroker.getBrokerStats': {
    status: 'streaming',
    inputFps: 7,
    encodedSubscribers: 0,
    uptimeMs: 1,
    bitrateKbps: 100,
    idrIntervalMs: 4000,
    totalBytes: 1,
    packetCount: 1,
    rtspClients: 0,
    pipeClients: 0,
    preBufferSec: 0,
    preBufferMs: 0,
    preBufferPackets: 0,
  },
  'localNetwork.getAddresses': ADDRESSES,
  'logs.query': { entries: churnLines, done: true, source: 'ring' },
  'logs.sources': [],
  'pipelineAnalytics.listRecentTracks': {
    tracks: [
      { trackId: 'closed-both', className: 'person', firstSeen: NOW - 60_000, active: false },
      { trackId: 'closed-none', className: 'car', firstSeen: NOW - 120_000, active: false },
      { trackId: 'open-none', className: 'person', firstSeen: NOW - 5_000, active: true },
      { trackId: 'unreadable', className: 'dog', firstSeen: NOW - 180_000, active: false },
    ],
  },
  'pipelineAnalytics.listTrackMedia': (input: unknown) => {
    const id =
      typeof input === 'object' && input !== null && 'trackId' in input ? input.trackId : ''
    if (id === 'closed-both') return media(['thumbnail', 'keyFrame'])
    if (id === 'unreadable') throw new Error('media index busy')
    return []
  },
  ...extra,
})

describe('debug_report', () => {
  it('answers #15: slot churn and derived-feeder restarts, per derived stream', async () => {
    const { ctx } = fakeHub(answers())
    const out = await debugReport(ctx, { deviceId: 1, issue: 'stream', since: '30m' }, NOW)
    if (out.status !== 'ok') throw new Error(`expected ok: ${JSON.stringify(out)}`)
    const events = out.camera?.logs?.analysis.events ?? []
    expect(events.find((e) => e.id === 'profile-slot-changed')?.count).toBe(3)
    expect(
      events.find((e) => e.id === 'derived-feeder-restart')?.byDerivedStream['derived:web-720p'],
    ).toBe(3)
    expect(out.camera?.streams?.derived.map((s) => s.camStreamId)).toEqual(['derived:web-720p'])
    expect(out.camera?.streams?.derived[0]?.stats?.bitrateKbps).toBe(100)
    expect(out.versions?.[0]?.serverVersion).toBe('1.2.523')
    expect(out.versions?.[0]?.addons?.[0]?.version).toBe('1.2.10')
    expect(out.camera?.tracks).toBeNull()
  })

  it('answers #14: media per kind, missing only for closed tracks, unreadable stays unknown, URL shape', async () => {
    const { ctx } = fakeHub(answers())
    const out = await debugReport(ctx, { deviceId: 1, issue: 'detections' }, NOW)
    if (out.status !== 'ok') throw new Error('expected ok')
    const t = out.camera?.tracks
    expect(t?.checked).toBe(4)
    expect(t?.withThumbnail).toBe(1)
    expect(t?.withoutThumbnailOrKeyFrame).toBe(1) // closed-none only: open-none is still live
    expect(t?.noMediaAtAll).toBe(1)
    expect(t?.unreadMedia).toBe(1)
    const unreadable = t?.items.find((i) => i.trackId === 'unreadable')
    expect(unreadable?.thumbnail).toBeNull()
    expect(unreadable?.kinds).toBeNull()
    const ok = t?.items.find((i) => i.trackId === 'closed-both')
    expect(ok?.viewerThumbUrl.absolute).toBe(
      'https://hub.example.test/addon/pipeline-analytics/event-media/o/track/closed-both?variant=thumb&size=160',
    )
    expect(ok?.thumbnailMediaUrl).toBe('/addon/pipeline-analytics/event-media/m/100')
    expect(out.unavailable['media:unreadable']).toContain('media index busy')
  })

  it('includes the viewer app lines for the camera and window', async () => {
    const viewer = {
      timestamp: iso(2),
      level: 'warn',
      scope: 'stream-broker',
      message: '[app:warn:live] thumbnail 404',
      tags: { source: 'viewer', deviceId: '1', platform: 'web' },
    }
    const { ctx } = fakeHub(
      answers({
        'logs.query': (input: unknown) => {
          const tags =
            typeof input === 'object' && input !== null && 'tags' in input ? input.tags : null
          const isViewer = typeof tags === 'object' && tags !== null && 'source' in tags
          return { entries: isViewer ? [viewer] : churnLines, done: true, source: 'ring' }
        },
      }),
    )
    const out = await debugReport(ctx, { deviceId: 1, issue: 'ui' }, NOW)
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.camera?.viewer?.match).toBe('tag')
    expect(out.camera?.viewer?.lines?.[0]).toMatchObject({
      scope: 'live',
      message: 'thumbnail 404',
      platform: 'web',
    })
  })

  it('issue media reports track media and nothing about streams or viewer lines', async () => {
    const { ctx } = fakeHub(answers())
    const out = await debugReport(ctx, { deviceId: 1, issue: 'media' }, NOW)
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.camera?.tracks?.checked).toBeGreaterThan(0)
    expect(out.camera?.streams).toBeNull()
    expect(out.camera?.viewer).toBeNull()
  })

  it('a failed log read is reported, not an empty churn analysis', async () => {
    const { ctx } = fakeHub(answers({ 'logs.query': new Error('ring down') }))
    const out = await debugReport(ctx, { deviceId: 1 }, NOW)
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.camera?.logs).toBeNull()
    expect(Object.keys(out.unavailable).some((k) => k.startsWith('logs:'))).toBe(true)
  })

  it('without a deviceId only the versions are reported, and it writes nothing', async () => {
    const { ctx, calls } = fakeHub(answers())
    const out = await debugReport(ctx, {}, NOW)
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.camera).toBeUndefined()
    expect(calls.filter((c) => c.method === 'POST')).toEqual([])
  })

  it('refuses a protected credential and reports a missing session', async () => {
    const { ctx } = fakeHub(answers())
    const prot = await asProtectedTier(ctx)
    expect(JSON.stringify(await debugReport(prot, { deviceId: 1 }, NOW))).toMatch(/admin/i)
    expect((await debugReport(noSessionContext(), {}, NOW)).status).not.toBe('ok')
  })

  it('refuses an unreadable since', async () => {
    const { ctx } = fakeHub(answers())
    const out = await debugReport(ctx, { deviceId: 1, since: 'soon' }, NOW)
    expect(out.status).not.toBe('ok')
  })
})
