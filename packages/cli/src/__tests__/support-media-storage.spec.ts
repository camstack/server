import { describe, expect, it } from 'vitest'
import { mediaStorageLines } from '../mcp/report-tool-sections.js'
import { maskRoot, mediaStorageCheck } from '../mcp/support-media-storage.js'
import { fakeHub, noSessionContext } from './ops-fake-hub.js'

const loc = (id: string, over: object = {}): object => ({
  id,
  type: id.split(':')[0],
  displayName: id,
  providerId: 'filesystem-storage',
  config: { basePath: `/mnt/user/appdata/camstack/${id.replace(':', '-')}` },
  nodeId: 'hub',
  isSystem: false,
  enabled: true,
  mode: 'active',
  capacity: { totalBytes: 2e12, availableBytes: 5e11 },
  owned: { bytes: 3e9, measuredAtMs: 1 },
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

const track = (id: string, firstSeen: number): object => ({
  trackId: id,
  className: 'person',
  firstSeen,
  active: false,
})

function hub(media: { [trackId: string]: object[] }) {
  return fakeHub({
    'storage.listLocations': [
      loc('eventMedia:default'),
      loc('eventMedia:old', { mode: 'disabled', enabled: false }),
      loc('eventMedia:ro', { mode: 'readonly', capacity: null }),
      loc('recordings:default'),
    ],
    'pipelineAnalytics.getMediaLocationCensus': {
      locations: [
        { locationId: 'eventMedia:default', rows: 900, bytes: 4e9 },
        { locationId: 'eventMedia:old', rows: 120, bytes: 1e9 },
        { locationId: 'eventMedia:ro', rows: 30, bytes: 1e8 },
      ],
      unstamped: { rows: 5, bytes: 1000 },
      unlisted: { rows: 44, bytes: 5e8 },
      total: { rows: 1099, bytes: 5.6e9 },
    },
    'deviceManager.listAll': [
      { id: 7, name: 'Garage', disabled: false },
      { id: 8, name: 'Gate', disabled: true },
    ],
    'pipelineAnalytics.listRecentTracks': {
      tracks: [track('t-ok', 3000), track('t-nothumb', 2000), track('t-none', 1000)],
    },
    'pipelineAnalytics.listTrackMedia': (input: { trackId: string }) => media[input.trackId] ?? [],
  })
}

const m = (kind: string): object => ({ mediaId: 1, kind, timestamp: 1 })

describe('media_storage_check', () => {
  it('answers no-session without a hub', async () => {
    expect(await mediaStorageCheck(noSessionContext())).toMatchObject({ status: 'no-session' })
  })

  it('reports a disabled location with events still on it, a gone one, and a missing thumbnail', async () => {
    const h = hub({
      't-ok': [m('thumbnail'), m('keyFrame')],
      't-nothumb': [m('keyFrame')],
      't-none': [],
    })
    const out = await mediaStorageCheck(h.ctx, {}, 5000)
    if (out.status !== 'ok') throw new Error('expected ok')
    // Only media classes are listed: the recordings location holds no event media.
    expect(out.locations?.map((l) => l.id)).toEqual([
      'eventMedia:default',
      'eventMedia:old',
      'eventMedia:ro',
    ])
    expect(out.locations?.find((l) => l.id === 'eventMedia:old')).toMatchObject({
      mode: 'disabled',
      mediaRows: 120,
      root: '/mnt/user/…/eventMedia-old',
    })
    expect(out.locations?.find((l) => l.id === 'eventMedia:ro')?.volumeReadable).toBeNull()
    const codes = out.findings.map((f) => f.code)
    expect(codes).toEqual(
      expect.arrayContaining(['location-gone', 'location-disabled', 'location-readonly']),
    )
    expect(out.findings.find((f) => f.code === 'location-gone')).toMatchObject({
      rows: 44,
      severity: 'problem',
    })
    expect(out.findings.find((f) => f.code === 'location-disabled')).toMatchObject({ rows: 120 })
    // Disabled cameras are not sampled; the thumbnail-less track is counted and listed.
    expect(out.sample?.cameras).toHaveLength(1)
    expect(out.sample?.cameras[0]).toMatchObject({
      deviceId: 7,
      checked: 3,
      withThumbnail: 1,
      withKeyFrame: 2,
      missingThumbnail: 2,
      noMediaAtAll: 1,
    })
    expect(out.sample?.cameras[0]?.missing.map((x) => x.trackId)).toEqual(
      expect.arrayContaining(['t-nothumb', 't-none']),
    )
    expect(out.sample?.nextCameraOffset).toBeNull()
  })

  it('paginates the camera sample', async () => {
    const h = hub({})
    const out = await mediaStorageCheck(h.ctx, { cameras: 1, cameraOffset: 0 })
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.sample?.camerasTotal).toBe(1)
    const none = await mediaStorageCheck(h.ctx, { cameraOffset: 5 })
    if (none.status !== 'ok') throw new Error('expected ok')
    expect(none.sample?.cameras).toEqual([])
  })

  it('a census that failed leaves counts unknown, not zero', async () => {
    const h = fakeHub({
      'storage.listLocations': [loc('eventMedia:default')],
      'pipelineAnalytics.getMediaLocationCensus': new Error('analytics down'),
      'deviceManager.listAll': [],
    })
    const out = await mediaStorageCheck(h.ctx)
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.census).toBeNull()
    expect(out.locations?.[0]?.mediaRows).toBeNull()
    expect(out.unavailable['census']).toContain('analytics down')
    expect(out.findings).toEqual([])
  })

  it('flags legacy rows that no location can claim', async () => {
    const h = fakeHub({
      'storage.listLocations': [loc('eventMedia:a'), loc('eventMedia:b')],
      'pipelineAnalytics.getMediaLocationCensus': {
        locations: [
          { locationId: 'eventMedia:a', rows: 1, bytes: 1 },
          { locationId: 'eventMedia:b', rows: 1, bytes: 1 },
        ],
        unstamped: { rows: 9, bytes: 9 },
        unlisted: { rows: 0, bytes: 0 },
        total: { rows: 11, bytes: 11 },
      },
      'deviceManager.listAll': [],
    })
    const out = await mediaStorageCheck(h.ctx)
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.findings.map((f) => f.code)).toContain('unstamped-unresolvable')
  })

  it('masks a root to its mount shape', () => {
    expect(maskRoot('/mnt/user/appdata/camstack/events')).toBe('/mnt/user/…/events')
    expect(maskRoot('/data/events')).toBe('/data/events')
    expect(maskRoot('s3://bucket.example.com/x')).toBe('[remote url]')
    expect(maskRoot(undefined)).toBeNull()
  })
})
