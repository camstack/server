import { describe, it, expect, vi } from 'vitest'
import type { DecodedAudioChunk, IScopedLogger } from '@camstack/types'
import { AudioChunkPlane } from '../stream-broker/audio-chunk-plane.js'

/**
 * The plane serves each subscription the format IT declared (D455).
 *
 * The lever this guards: `AudioRtpDecoder` stops expanding G.711 into f32le
 * before the transport, so the plane's chunks carry one byte per sample. Four
 * legs of hub-main were paying four bytes for each of them.
 *
 * What makes that deployable across three nodes one addon at a time is the
 * negotiation, and it is the ONLY thing standing between a coded window and a
 * consumer that would read the bytes as floats and report +43 dBFS in silence.
 * So the guard is not "the plane can carry pcmu" — it is "a subscription that
 * did not ask for pcmu never receives it", which is the case that breaks.
 */
function makeLogger(): IScopedLogger & { lines: Array<{ msg: string; meta: unknown }> } {
  const lines: Array<{ msg: string; meta: unknown }> = []
  const rec =
    (msg: string) =>
    (m: string, opts?: { meta?: unknown }): void => {
      lines.push({ msg: `${msg}:${m}`, meta: opts?.meta })
    }
  const logger = {
    lines,
    info: rec('info'),
    warn: rec('warn'),
    error: rec('error'),
    debug: rec('debug'),
    child: () => logger,
    withTags: () => logger,
  } as unknown as IScopedLogger & { lines: Array<{ msg: string; meta: unknown }> }
  return logger
}

/** 0xff is this table's μ-law silence; 0x80 its positive extreme. */
function codedChunk(bytes: readonly number[]): DecodedAudioChunk {
  return {
    data: Buffer.from(bytes),
    sampleRate: 8000,
    channels: 1,
    timestamp: 1_000,
    format: 'pcmu',
  }
}

describe('AudioChunkPlane format negotiation', () => {
  it('serves the coded bytes verbatim to a subscriber that accepts pcmu', () => {
    const plane = new AudioChunkPlane(makeLogger())
    const { subscriptionId } = plane.subscribe({ tag: 'audio-analyzer', accept: ['pcmu', 'pcma'] })

    plane.fanout(codedChunk([0xff, 0x80, 0x00, 0x7f]))

    const [chunk] = plane.pull(subscriptionId, 10)
    expect(chunk).toBeDefined()
    expect(chunk!.format).toBe('pcmu')
    expect(chunk!.data.byteLength).toBe(4)
  })

  it('expands to f32le for a subscriber that declared nothing — absence is never coded', () => {
    const plane = new AudioChunkPlane(makeLogger())
    const { subscriptionId } = plane.subscribe({ tag: 'legacy' })

    plane.fanout(codedChunk([0xff, 0x80, 0x00, 0x7f]))

    const [chunk] = plane.pull(subscriptionId, 10)
    expect(chunk!.format).toBe('f32le')
    expect(chunk!.data.byteLength).toBe(16)
    const f32 = new Float32Array(
      chunk!.data.buffer,
      chunk!.data.byteOffset,
      chunk!.data.byteLength / 4,
    )
    expect(f32[0]).toBeCloseTo(0, 6)
    // 32124/32768 is ITU-T G.711's μ-law full scale for code 0x80. Pinned at
    // a quarter of it until D459 corrected the table; that record did not
    // re-anchor this spec, so it has been red on main since. Re-anchored
    // here rather than left failing — a red guard states nothing (D461).
    expect(f32[1]).toBeCloseTo(32124 / 32768, 6)
  })

  it('expands for a subscriber whose accept list does not name the source format', () => {
    const plane = new AudioChunkPlane(makeLogger())
    // Accepts A-law only. A μ-law window is NOT A-law: serving it would be a
    // silent codec substitution, which is exactly the D427 failure.
    const { subscriptionId } = plane.subscribe({ tag: 'alaw-only', accept: ['pcma'] })

    plane.fanout(codedChunk([0xff, 0x80]))

    const [chunk] = plane.pull(subscriptionId, 10)
    expect(chunk!.format).toBe('f32le')
    expect(chunk!.data.byteLength).toBe(8)
  })

  it('serves two subscribers of different appetites from ONE fanout, each correctly', () => {
    const plane = new AudioChunkPlane(makeLogger())
    const coded = plane.subscribe({ tag: 'new', accept: ['pcmu'] })
    const wide = plane.subscribe({ tag: 'old' })

    plane.fanout(codedChunk([0xff, 0x80]))

    expect(plane.pull(coded.subscriptionId, 10)[0]!.data.byteLength).toBe(2)
    expect(plane.pull(wide.subscriptionId, 10)[0]!.data.byteLength).toBe(8)
  })

  it('passes an f32le chunk through untouched even to a coded-accepting subscriber', () => {
    // The AAC path decodes through the codec session and emits f32le at
    // 16 kHz. `accept` says what a consumer CAN read, never what it demands.
    const plane = new AudioChunkPlane(makeLogger())
    const { subscriptionId } = plane.subscribe({ tag: 'audio-analyzer', accept: ['pcmu', 'pcma'] })
    const f32 = new Float32Array([0.5, -0.5])

    plane.fanout({
      data: Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength),
      sampleRate: 16000,
      channels: 1,
      timestamp: 1,
    })

    const [chunk] = plane.pull(subscriptionId, 10)
    expect(chunk!.data.byteLength).toBe(8)
    expect(chunk!.sampleRate).toBe(16000)
  })

  it('says what each subscription is being served, once, and again on a change (D427)', () => {
    const logger = makeLogger()
    const plane = new AudioChunkPlane(logger)
    plane.subscribe({ tag: 'audio-analyzer', accept: ['pcmu'] })

    plane.fanout(codedChunk([0xff, 0x80]))
    plane.fanout(codedChunk([0xff, 0x80]))

    const served = logger.lines.filter((l) => l.msg.includes('audio-chunk subscription serving'))
    expect(served).toHaveLength(1)
    expect(served[0]!.meta).toMatchObject({ sourceFormat: 'pcmu', servedFormat: 'pcmu' })

    // The broker is redeployed / the camera flips to the AAC codec session:
    // the served format changes and the line says so rather than the operator
    // discovering it from a byte count.
    const f32 = new Float32Array([0.25])
    plane.fanout({
      data: Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength),
      sampleRate: 16000,
      channels: 1,
      timestamp: 2,
    })

    const after = logger.lines.filter((l) => l.msg.includes('audio-chunk subscription serving'))
    expect(after).toHaveLength(2)
    expect(after[1]!.meta).toMatchObject({ sourceFormat: 'f32le', servedFormat: 'f32le' })
  })

  it('names an expansion the subscriber forced, so a leg paying 4x is visible', () => {
    const logger = makeLogger()
    const plane = new AudioChunkPlane(logger)
    plane.subscribe({ tag: 'legacy' })

    plane.fanout(codedChunk([0xff, 0x80]))

    const served = logger.lines.filter((l) => l.msg.includes('audio-chunk subscription serving'))
    expect(served[0]!.meta).toMatchObject({
      sourceFormat: 'pcmu',
      servedFormat: 'f32le',
      expanded: true,
    })
  })

  it('expands ONCE for N subscribers that all need it', () => {
    const plane = new AudioChunkPlane(makeLogger())
    const a = plane.subscribe({ tag: 'a' })
    const b = plane.subscribe({ tag: 'b' })

    plane.fanout(codedChunk([0xff, 0x80]))

    const chunkA = plane.pull(a.subscriptionId, 10)[0]!
    const chunkB = plane.pull(b.subscriptionId, 10)[0]!
    expect(chunkA.data).toBe(chunkB.data)
  })
})

describe('AudioChunkPlane subscribe input', () => {
  it('keeps the tag warning for an untagged subscription', () => {
    const logger = makeLogger()
    const plane = new AudioChunkPlane(logger)
    plane.subscribe({ accept: ['pcmu'] })
    expect(vi.isMockFunction(logger.info)).toBe(false)
    expect(logger.lines.some((l) => l.msg.includes('audio-chunk subscription added'))).toBe(true)
  })
})
