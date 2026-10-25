import { describe, expect, it } from 'vitest'
import { clampImageBytes, fetchTrackFrame, HARD_IMAGE_MAX_BYTES } from '../frame.js'
import type { MediaFile } from '../hub-api.js'
import { FakeHub, track } from './fixtures.js'

function media(kind: MediaFile['kind'], mediaId: number, sizeBytes: number): MediaFile {
  return {
    mediaId,
    kind,
    sizeBytes,
    timestamp: 1,
    url: `/m/${mediaId}`,
    base64: `b64-${mediaId}`,
  }
}

class MediaHub extends FakeHub {
  constructor(private readonly files: readonly MediaFile[]) {
    super()
  }
  override async getTrack() {
    return track({
      trackId: 't',
      envelope: { minX: 0, minY: 0, maxX: 0.5, maxY: 0.5 },
    })
  }
  override async listTrackMedia() {
    return this.files.map(({ base64: _b, ...rest }) => rest)
  }
  override async getTrackMedia(_d: number, _t: string, kinds: readonly MediaFile['kind'][]) {
    return this.files.filter((f) => kinds.includes(f.kind))
  }
}

describe('fetchTrackFrame', () => {
  it('prefers the small clean key frame and returns its bytes with the envelope', async () => {
    const hub = new MediaHub([media('keyFrame', 1, 900), media('keyFrameSmall', 2, 100)])
    const r = await fetchTrackFrame(hub, 1, 't', 1000)
    expect(r.image).toMatchObject({ kind: 'keyFrameSmall', base64: 'b64-2' })
    expect(r.envelope).toEqual({ minX: 0, minY: 0, maxX: 0.5, maxY: 0.5 })
  })

  it('never returns an image above the size bound', async () => {
    const hub = new MediaHub([media('keyFrame', 1, 5000)])
    const r = await fetchTrackFrame(hub, 1, 't', 1000)
    expect(r.image).toBeUndefined()
    expect(r.note).toContain('no image within 1000')
  })

  it('bounds the requested size', () => {
    expect(clampImageBytes(10 ** 9)).toBe(HARD_IMAGE_MAX_BYTES)
    expect(clampImageBytes(undefined)).toBeLessThanOrEqual(HARD_IMAGE_MAX_BYTES)
  })

  it('reports an unknown track instead of throwing', async () => {
    const r = await fetchTrackFrame(new FakeHub(), 1, 'gone', 1000)
    expect(r.found).toBe(false)
  })

  it('prefers the full key frame over the thumbnail crop and keeps the envelope', async () => {
    const hub = new MediaHub([media('thumbnail', 1, 50), media('keyFrame', 2, 900)])
    const r = await fetchTrackFrame(hub, 1, 't', 1000)
    expect(r.image?.kind).toBe('keyFrame')
    expect(r.imageSpace).toBe('full-frame')
    expect(r.envelope).toBeDefined()
    expect(r.warning).toBeUndefined()
  })

  it('on a thumbnail crop withholds the envelope and warns, in full-frame terms', async () => {
    const hub = new MediaHub([media('thumbnail', 1, 50), media('keyFrame', 2, 5000)])
    const r = await fetchTrackFrame(hub, 1, 't', 1000)
    expect(r.image?.kind).toBe('thumbnail')
    expect(r.imageSpace).toBe('crop')
    expect(r.coordinateSpace).toBe('full-frame')
    expect(r.envelope).toBeUndefined()
    expect(r.warning).toContain('CROP')
  })
})
