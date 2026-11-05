import { describe, expect, it } from 'vitest'
import { mediaStorageLines } from '../mcp/report-tool-sections.js'
import { maskPath } from '../mcp/path-mask.js'
import { mediaStorageCheck, rootsOf } from '../mcp/support-media-storage.js'
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

interface CensusInput {
  readonly locationIds: readonly string[]
}

/**
 * A census answered the way the real store does: per asked id, the NULL group,
 * the unfiltered total, and "unlisted" = total minus the ASKED ids minus NULL.
 */
function censusOver(
  db: { readonly [locationId: string]: number },
  unstamped = 0,
): (input: CensusInput) => object {
  return (input) => {
    let total = unstamped
    for (const n of Object.values(db)) total += n
    let known = 0
    const locations = input.locationIds.map((id) => {
      const rows = db[id] ?? 0
      known += rows
      return { locationId: id, rows, bytes: rows * 100 }
    })
    const unlisted = Math.max(0, total - known - unstamped)
    return {
      locations,
      unstamped: { rows: unstamped, bytes: unstamped * 100 },
      unlisted: { rows: unlisted, bytes: unlisted * 100 },
      total: { rows: total, bytes: total * 100 },
    }
  }
}

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
    'pipelineAnalytics.getMediaLocationCensus': censusOver(
      { 'eventMedia:default': 900, 'eventMedia:old': 120, 'eventMedia:ro': 30, 'gone:x': 44 },
      5,
    ),
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
      roots: ['basePath=/mnt/…/eventMedia-old'],
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
      'pipelineAnalytics.getMediaLocationCensus': censusOver(
        { 'eventMedia:a': 1, 'eventMedia:b': 1 },
        9,
      ),
      'deviceManager.listAll': [],
    })
    const out = await mediaStorageCheck(h.ctx)
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.findings.map((f) => f.code)).toContain('unstamped-unresolvable')
  })

  it('does not call a row on another live class gone', async () => {
    const h = fakeHub({
      'storage.listLocations': [loc('eventMedia:default'), loc('recordings:default')],
      'pipelineAnalytics.getMediaLocationCensus': censusOver({
        'eventMedia:default': 10,
        'recordings:default': 50,
      }),
      'deviceManager.listAll': [],
    })
    const out = await mediaStorageCheck(h.ctx)
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.findings.map((f) => f.code)).not.toContain('location-gone')
    expect(out.census?.unlistedRows).toBe(0)
    // A location outside the media classes is shown because a row names it.
    expect(out.locations?.map((l) => l.id)).toContain('recordings:default')
  })

  it('asks every location in chunks of 50 and finds no false gone over 50 locations', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `eventMedia:l${String(i)}`)
    const db: { [id: string]: number } = {}
    db['eventMedia:l100'] = 7
    const asked: number[] = []
    const answer = censusOver(db)
    const h = fakeHub({
      'storage.listLocations': ids.map((id) => loc(id)),
      'pipelineAnalytics.getMediaLocationCensus': (input: CensusInput) => {
        asked.push(input.locationIds.length)
        return answer(input)
      },
      'deviceManager.listAll': [],
    })
    const out = await mediaStorageCheck(h.ctx)
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(asked).toEqual([50, 50, 20])
    expect(out.findings.map((f) => f.code)).not.toContain('location-gone')
    expect(out.census?.unlistedRows).toBe(0)
    expect(out.locations?.find((l) => l.id === 'eventMedia:l100')?.mediaRows).toBe(7)
  })

  it('a chunk that failed makes gone unknown, never a problem', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `eventMedia:l${String(i)}`)
    const answer = censusOver({ 'eventMedia:l55': 9 })
    let n = 0
    const h = fakeHub({
      'storage.listLocations': ids.map((id) => loc(id)),
      'pipelineAnalytics.getMediaLocationCensus': (input: CensusInput) => {
        n += 1
        if (n === 2) throw new Error('second chunk down')
        return answer(input)
      },
      'deviceManager.listAll': [],
    })
    const out = await mediaStorageCheck(h.ctx)
    if (out.status !== 'ok') throw new Error('expected ok')
    const codes = out.findings.map((f) => f.code)
    expect(codes).not.toContain('location-gone')
    expect(codes).toContain('location-gone-unknown')
    expect(out.census?.unlistedRows).toBeNull()
  })

  it('confirms a remainder that a second full read still sees', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `eventMedia:l${String(i)}`)
    const answer = censusOver({ 'eventMedia:l1': 5, 'gone:x': 9 })
    const h = fakeHub({
      'storage.listLocations': ids.map((id) => loc(id)),
      'pipelineAnalytics.getMediaLocationCensus': answer,
      'deviceManager.listAll': [],
    })
    const out = await mediaStorageCheck(h.ctx)
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.findings.find((f) => f.code === 'location-gone')).toMatchObject({ rows: 9 })
    // two full passes of two chunks
    expect(h.calls.filter((c) => c.path.endsWith('getMediaLocationCensus'))).toHaveLength(4)
  })

  it('a remainder that vanishes on the second read is unknown, not gone', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `eventMedia:l${String(i)}`)
    let n = 0
    const h = fakeHub({
      'storage.listLocations': ids.map((id) => loc(id)),
      'pipelineAnalytics.getMediaLocationCensus': (input: CensusInput) => {
        n += 1
        // Pass 1 sees 10 phantom rows (retention moved the total between chunks);
        // pass 2 (calls 3, 4) is consistent.
        const total = n <= 2 ? 10 : 0
        return {
          locations: input.locationIds.map((id) => ({ locationId: id, rows: 0, bytes: 0 })),
          unstamped: { rows: 0, bytes: 0 },
          unlisted: { rows: 0, bytes: 0 },
          total: { rows: total, bytes: 0 },
        }
      },
      'deviceManager.listAll': [],
    })
    const out = await mediaStorageCheck(h.ctx)
    if (out.status !== 'ok') throw new Error('expected ok')
    const codes = out.findings.map((f) => f.code)
    expect(codes).not.toContain('location-gone')
    expect(codes).toContain('location-gone-unknown')
  })

  it('a location being drained has its own finding', async () => {
    const h = fakeHub({
      'storage.listLocations': [loc('eventMedia:d', { mode: 'drain' })],
      'pipelineAnalytics.getMediaLocationCensus': censusOver({ 'eventMedia:d': 12 }),
      'deviceManager.listAll': [],
    })
    const out = await mediaStorageCheck(h.ctx)
    if (out.status !== 'ok') throw new Error('expected ok')
    const f = out.findings.find((x) => x.code === 'location-draining')
    expect(f?.message).toContain('drained')
    expect(out.findings.map((x) => x.code)).not.toContain('location-readonly')
  })

  it('an older hub without the census still produces the sample', async () => {
    const h = fakeHub({
      'storage.listLocations': [loc('eventMedia:default')],
      'deviceManager.listAll': [{ id: 7, name: 'Garage', disabled: false }],
      'pipelineAnalytics.listRecentTracks': { tracks: [track('t1', 1)] },
      'pipelineAnalytics.listTrackMedia': [m('thumbnail')],
    })
    const out = await mediaStorageCheck(h.ctx)
    if (out.status !== 'ok') throw new Error('expected ok')
    expect(out.unavailable['census']).toContain('no fake answer')
    expect(out.census).toBeNull()
    expect(out.sample?.cameras[0]).toMatchObject({ deviceId: 7, checked: 1 })
  })

  it('shows every root-bearing key masked and never a credential or host', () => {
    expect(
      rootsOf({
        basePath: '/mnt/user/appdata/camstack/events',
        rootPath: '\\\\nas\\share\\cams\\events',
        url: 'https://u:pw@nas.example.com/x',
        bucket: 'my-bucket',
        retention: 30,
      }),
    ).toEqual([
      'basePath=/mnt/…/events',
      'rootPath=\\\\[host]\\share\\…\\events',
      'url=[remote]',
      'bucket=[remote]',
    ])
  })

  it('masks paths: unix, UNC, scheme-less credentials, short ones', () => {
    expect(maskPath('/mnt/user/appdata/camstack/events')).toBe('/mnt/…/events')
    expect(maskPath('/data/events')).toBe('/data/…')
    expect(maskPath('/data')).toBe('/data')
    expect(maskPath('bob-private/cams/events')).toBe('…/events')
    expect(maskPath('events')).toBe('…/events')
    expect(maskPath('\\\\nas\\share\\cams\\events')).toBe('\\\\[host]\\share\\…\\events')
    expect(maskPath('//user:pw@nas/share/events')).toBe('[remote url]')
    expect(maskPath('s3://bucket.example.com/x')).toBe('[remote url]')
    expect(maskPath('C:\\Users\\bob\\cams\\events')).toBe('C:\\Users\\…\\events')
  })
})
