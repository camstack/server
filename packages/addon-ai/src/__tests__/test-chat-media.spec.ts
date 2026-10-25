/**
 * Resolving a test-chat attachment: a reference in, bytes out, server-side.
 *
 * The failure modes here are all "the picture quietly did not arrive", which is
 * the one thing this surface must never do silently — a vision model answers a
 * question about a missing image with confident prose, and nothing downstream
 * can tell that from a real answer.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  pickTrackMedia,
  renderTranscript,
  resolveImage,
  TRACK_MEDIA_PREFERENCE,
  type MediaDeps,
} from '../test-chat/media.js'
import { createTestLogger, type TestLoggerHandle } from './support/logger.js'

function harness(over: Partial<MediaDeps> = {}): { deps: MediaDeps; logger: TestLoggerHandle } {
  const log = createTestLogger()
  const deps: MediaDeps = {
    getSnapshot: async () => ({
      base64: Buffer.from('snapshot-bytes').toString('base64'),
      contentType: 'image/jpeg',
    }),
    getTrackMedia: async () => [
      {
        mediaId: 3937,
        kind: 'keyFrameSmall',
        base64: Buffer.from('track-bytes').toString('base64'),
        sizeBytes: 11,
        timestamp: 1_700_000_000_000,
      },
    ],
    logger: log.logger,
    ...over,
  }
  return { deps, logger: log }
}

describe('renderTranscript', () => {
  it('flattens a multi-turn exchange into one labelled prompt', () => {
    expect(
      renderTranscript([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        { role: 'user', content: 'what do you see?' },
      ]),
    ).toBe('User: hello\n\nAssistant: hi\n\nUser: what do you see?')
  })

  it('sends a single user turn verbatim — no role prefix to parrot back', () => {
    expect(renderTranscript([{ role: 'user', content: 'ping' }])).toBe('ping')
  })
})

describe('pickTrackMedia', () => {
  it('prefers the clean downscaled best-shot over the raw native frame', () => {
    const rows = [
      { mediaId: 485, kind: 'keyFrame', base64: 'AA', sizeBytes: 1, timestamp: 1 },
      { mediaId: 8403, kind: 'keyFrameSmall', base64: 'BB', sizeBytes: 1, timestamp: 2 },
      { mediaId: 3781, kind: 'thumbnail', base64: 'CC', sizeBytes: 1, timestamp: 3 },
    ]
    expect(pickTrackMedia(rows)?.kind).toBe('keyFrameSmall')
  })

  it('falls back down the ladder rather than returning nothing', () => {
    expect(
      pickTrackMedia([{ mediaId: 3781, kind: 'crop', base64: 'CC', sizeBytes: 1, timestamp: 3 }])
        ?.kind,
    ).toBe('crop')
  })

  /** The one variant with graphics painted over the evidence. */
  it('never judges a frame with a box drawn on it', () => {
    expect(TRACK_MEDIA_PREFERENCE).not.toContain('fullFrameBoxed')
    expect(
      pickTrackMedia([
        { mediaId: 3051, kind: 'fullFrameBoxed', base64: 'XX', sizeBytes: 1, timestamp: 3 },
      ]),
    ).toBeNull()
  })

  it('returns null for an empty media set', () => {
    expect(pickTrackMedia([])).toBeNull()
  })
})

describe('resolveImage — snapshots', () => {
  it('decodes the camera frame and reports what it will send', async () => {
    const h = harness()
    const out = await resolveImage(h.deps, { kind: 'snapshot', deviceId: 102 })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(Buffer.from(out.resolved.image.bytes).toString()).toBe('snapshot-bytes')
    expect(out.resolved.attachment).toMatchObject({
      kind: 'snapshot',
      mimeType: 'image/jpeg',
      sizeBytes: Buffer.from('snapshot-bytes').byteLength,
    })
  })

  it('reports a camera with no frame, and logs it against that camera', async () => {
    const h = harness({ getSnapshot: async () => null })
    const out = await resolveImage(h.deps, { kind: 'snapshot', deviceId: 101 })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.failure.code).toBe('unavailable')
    // Per-camera grouping: the line is useless for "why is 101 worse than 102"
    // without the tag.
    expect(h.logger.entries.some((e) => e.extras?.tags?.deviceId === 101)).toBe(true)
  })

  it('reports a throwing snapshot read with the underlying reason', async () => {
    const h = harness({
      getSnapshot: async () => {
        throw new Error('camera asleep')
      },
    })
    const out = await resolveImage(h.deps, { kind: 'snapshot', deviceId: 101 })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.failure.message).toMatch(/camera asleep/)
  })
})

describe('resolveImage — tracks', () => {
  it('sends the winning stored row and names which kind it used', async () => {
    const h = harness()
    const out = await resolveImage(h.deps, { kind: 'track', trackId: 't-1', deviceId: 102 })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.resolved.attachment).toMatchObject({
      kind: 'track',
      mediaKind: 'keyFrameSmall',
      capturedAt: 1_700_000_000_000,
    })
  })

  it('asks only for the kinds it can use, never the whole multi-MB media set', async () => {
    const getTrackMedia = vi.fn(async () => [])
    const h = harness({ getTrackMedia })
    await resolveImage(h.deps, { kind: 'track', trackId: 't-1', deviceId: 102 })
    const [trackId, kinds] = getTrackMedia.mock.calls[0] as unknown as [string, readonly string[]]
    expect(trackId).toBe('t-1')
    expect(kinds).toEqual(TRACK_MEDIA_PREFERENCE)
    expect(kinds).not.toContain('fullFrame')
  })

  it('reports an evicted track, and says which kinds it did find', async () => {
    const h = harness({
      getTrackMedia: async () => [
        { mediaId: 3051, kind: 'fullFrameBoxed', base64: 'XX', sizeBytes: 1, timestamp: 1 },
      ],
    })
    const out = await resolveImage(h.deps, { kind: 'track', trackId: 't-gone', deviceId: 102 })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.failure.message).toMatch(/best-shot/i)
    const line = h.logger.entries.find((e) => /no usable media/i.test(e.message))
    expect(line?.extras?.meta?.kindsFound).toEqual(['fullFrameBoxed'])
  })
})
