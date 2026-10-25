import { describe, it, expect, vi } from 'vitest'
import { createClipFileSource, ClipSourceError } from '../clip-file-source'
import type { ClipBytesReader } from '../clip-file-source'
import { buildMp4Fixture, FASTSTART_CLIP, HKSV_CLIP } from './mp4-fixture'

const HANDLE = {
  deviceId: 107,
  clipId: 'native:reolink:onboard/abc',
  provider: 'provider-reolink',
  profile: 'low',
} as const
const LOCATE_ARGS = { deviceId: 107, profile: 'low' }

const okReader = (bytes: Uint8Array): ClipBytesReader => vi.fn(async () => bytes)

describe('createClipFileSource', () => {
  it('locates ONE segment covering the whole file, on a file-relative timeline', async () => {
    const bytes = buildMp4Fixture(FASTSTART_CLIP)
    const src = createClipFileSource({ handle: HANDLE, read: okReader(bytes) })
    const loc = await src.locate({ ...LOCATE_ARGS, epochMs: 900 })
    expect(loc.kind).toBe('segment')
    if (loc.kind !== 'segment') return
    expect(loc.startMs).toBe(0)
    expect(loc.durMs).toBe(2000)
    expect(loc.bytes).toBe(bytes.length)
  })

  it('answers past the end with a gap that has NO forward edge, so the feeder ends', async () => {
    const src = createClipFileSource({
      handle: HANDLE,
      read: okReader(buildMp4Fixture(FASTSTART_CLIP)),
    })
    const loc = await src.locate({ ...LOCATE_ARGS, epochMs: 2500 })
    expect(loc.kind).toBe('gap')
    if (loc.kind !== 'gap') return
    expect(loc.nearestEdgeMs).toBeNull()
    expect(loc.prevEndMs).toBe(2000)
  })

  it('snaps a target before the first sync sample forward to it', async () => {
    const src = createClipFileSource({
      handle: HANDLE,
      read: okReader(buildMp4Fixture({ ...FASTSTART_CLIP, stss: [4] })),
    })
    const loc = await src.locate({ ...LOCATE_ARGS, epochMs: 10 })
    expect(loc.kind).toBe('gap')
    if (loc.kind !== 'gap') return
    expect(loc.nearestEdgeMs).toBeCloseTo(3 * (1000 / 15), 6)
  })

  it('fetches the file EXACTLY ONCE for the whole session, whatever is asked', async () => {
    const bytes = buildMp4Fixture(FASTSTART_CLIP)
    const read = okReader(bytes)
    const src = createClipFileSource({ handle: HANDLE, read })
    await Promise.all([
      src.locate({ ...LOCATE_ARGS, epochMs: 0 }),
      src.locate({ ...LOCATE_ARGS, epochMs: 900 }),
    ])
    const out = await src.readBytes({ ...LOCATE_ARGS, startMs: 0 })
    await src.locate({ ...LOCATE_ARGS, epochMs: 1800 })
    expect(read).toHaveBeenCalledTimes(1)
    expect(out).toEqual(bytes)
  })

  it('REFUSES an unindexable (HKSV-shaped) clip by name, and says so in a log line', async () => {
    const onLog = vi.fn()
    const src = createClipFileSource({
      handle: HANDLE,
      read: okReader(buildMp4Fixture(HKSV_CLIP)),
      onLog,
    })
    await expect(src.locate({ ...LOCATE_ARGS, epochMs: 0 })).rejects.toBeInstanceOf(ClipSourceError)
    await expect(src.locate({ ...LOCATE_ARGS, epochMs: 0 })).rejects.toMatchObject({
      reason: 'no-samples',
    })
    expect(onLog).toHaveBeenCalled()
    const [msg, data] = onLog.mock.calls[0] ?? []
    expect(String(msg)).toContain('clip')
    expect(data).toMatchObject({ deviceId: 107, clipId: HANDLE.clipId, reason: 'no-samples' })
  })

  it('caches a TERMINAL refusal — an unindexable file is not re-fetched per locate', async () => {
    const read = okReader(buildMp4Fixture(HKSV_CLIP))
    const src = createClipFileSource({ handle: HANDLE, read })
    await expect(src.locate({ ...LOCATE_ARGS, epochMs: 0 })).rejects.toThrow()
    await expect(src.locate({ ...LOCATE_ARGS, epochMs: 500 })).rejects.toThrow()
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('does NOT cache a transient fetch failure — a sleeping camera can be retried', async () => {
    const bytes = buildMp4Fixture(FASTSTART_CLIP)
    const read = vi
      .fn<ClipBytesReader>()
      .mockRejectedValueOnce(new Error('camera asleep'))
      .mockResolvedValueOnce(bytes)
    const src = createClipFileSource({ handle: HANDLE, read })
    await expect(src.locate({ ...LOCATE_ARGS, epochMs: 0 })).rejects.toMatchObject({
      reason: 'fetch-failed',
    })
    const loc = await src.locate({ ...LOCATE_ARGS, epochMs: 0 })
    expect(loc.kind).toBe('segment')
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('REFUSES an over-size clip before indexing it, and logs the bound it broke', async () => {
    const onLog = vi.fn()
    const bytes = buildMp4Fixture(FASTSTART_CLIP)
    const src = createClipFileSource({
      handle: HANDLE,
      read: okReader(bytes),
      maxBytes: 10,
      onLog,
    })
    await expect(src.locate({ ...LOCATE_ARGS, epochMs: 0 })).rejects.toMatchObject({
      reason: 'too-large',
    })
    expect(onLog).toHaveBeenCalledWith(
      expect.stringContaining('clip'),
      expect.objectContaining({ deviceId: 107, bytes: bytes.length, maxBytes: 10 }),
    )
  })

  it('exposes the indexed duration so the session can bound the file-relative axis', async () => {
    const src = createClipFileSource({
      handle: HANDLE,
      read: okReader(buildMp4Fixture(FASTSTART_CLIP)),
    })
    expect(await src.durationMs()).toBe(2000)
  })
})
