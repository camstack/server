import { describe, expect, it } from 'vitest'
import { collectTracks, MAX_TRACKS, PAGE_SIZE } from '../collect.js'
import type { RecentTracksPage, RecentTracksQuery, ReviewHub } from '../hub-api.js'
import { track } from './fixtures.js'

/** Serves like the real hub: a page is min(limit, floor(2000 / deviceCount)) rows. */
function fakeHub(cameraIds: readonly number[], perCamera: number): ReviewHub {
  const FANOUT_BUDGET = 2000
  const hub = {
    async listCameras() {
      return cameraIds.map((id) => ({ id, name: `c${id}`, type: 'camera', disabled: false }))
    },
    async listRecentTracks(q: RecentTracksQuery): Promise<RecentTracksPage> {
      const size = Math.min(q.limit, Math.floor(FANOUT_BUDGET / q.deviceIds.length))
      const device = q.deviceIds[0]!
      const offset = q.cursor === undefined ? 0 : Number(q.cursor)
      const take = Math.min(size, perCamera - offset)
      const tracks = Array.from({ length: take }, (_, i) =>
        track({ trackId: `${device}-${offset + i}`, deviceId: device }),
      )
      const end = offset + take
      return { tracks, nextCursor: end < perCamera ? String(end) : null }
    },
  }
  return hub as unknown as ReviewHub
}

const ids = Array.from({ length: 32 }, (_, i) => i + 1)
const base = { hours: 72, now: 1_000_000_000 }

describe('collectTracks', () => {
  it('reads a 10k-track window on 32 cameras whole (page size is the server ceiling)', async () => {
    const out = await collectTracks(fakeHub(ids, 320), base)
    expect(out.tracks).toHaveLength(10_240)
    expect(out.truncated).toBe(false)
    expect(out.camerasComplete).toBe(32)
  })

  it('stops at the track bound and says which bound hit', async () => {
    const out = await collectTracks(fakeHub(ids, 5000), base)
    expect(out.truncated).toBe(true)
    expect(out.truncatedBy).toBe('max-tracks')
    expect(out.tracks.length).toBeGreaterThanOrEqual(MAX_TRACKS)
    expect(out.tracks.length).toBeLessThan(MAX_TRACKS + 32 * PAGE_SIZE)
  })

  it('stops at the wall-time bound', async () => {
    let t = 0
    const out = await collectTracks(fakeHub(ids, 320), {
      ...base,
      maxWalkMs: 10,
      clock: () => (t += 5),
    })
    expect(out.truncated).toBe(true)
    expect(out.truncatedBy).toBe('max-wall-time')
  })
})
