/**
 * THE SENTRY COVERS THE WINDOW BETWEEN "PLAY PRESSED" AND "MEDIA ARRIVES".
 *
 * A lazy source — a battery camera, a cloud-relayed one — takes 2.2 to 12.4 s
 * from demand to first packet (measured on the wyze bridge, devices 3838/3836).
 * The consumer sees black for all of it, and Amazon gives an Alexa session SIX
 * SECONDS to answer an SDP, so a cold battery camera could not answer an Echo
 * at all.
 *
 * What is pinned here is the wiring, and only the wiring:
 *
 *  - it starts in the lazy-materialize branch, ALONGSIDE `notifySourceRefresh`
 *    and never instead of it — the sentry must never dial, wake, or hold
 *    demand, so the publisher request has to survive it verbatim;
 *  - every frame it pushes carries `isPlaceholder: true`, which is what keeps
 *    it out of the decoder, the frame plane and the clip buffer
 *    (`synthetic-frame-containment.spec.ts`);
 *  - it stops on the FIRST non-placeholder packet, and on no other edge.
 */
import type { EncodedPacket, IScopedLogger, StreamSource } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StreamBroker } from '../stream-broker/stream-broker.js'

function createMockLogger(): IScopedLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
}

const SDP = 'v=0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\n'
const SENTRY_IDR = Buffer.from([0, 0, 0, 1, 0x67, 0x42])

function lazySource(): StreamSource {
  return {
    type: 'rfc4571',
    url: 'lazy:rfc4571:3838',
    videoCodec: 'h264',
    metadata: { sdp: SDP },
  }
}

function realPacket(): EncodedPacket {
  return {
    type: 'video',
    data: Buffer.from([0, 0, 0, 1, 0x65]),
    pts: 1,
    dts: 1,
    keyframe: true,
    codec: 'h264',
  }
}

describe('the sentry in the lazy-materialize window', () => {
  let broker: StreamBroker
  let logger: IScopedLogger
  let packets: EncodedPacket[]

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-13T10:00:00Z'))
    logger = createMockLogger()
    broker = new StreamBroker('3838/native:main', logger)
    packets = []
    broker.onEncodedData((p) => packets.push(p))
  })

  afterEach(async () => {
    await broker.stop()
    vi.useRealTimers()
  })

  function armPrestream(): void {
    broker.setPrestreamProvider({
      prepare: async () => ({ annexB: SENTRY_IDR, codec: 'h264' }),
    })
  }

  it('fills the window at 1 fps with frames tagged as synthetic', async () => {
    armPrestream()
    broker.setSourceProvider(() => lazySource())
    await broker.start(lazySource())
    await vi.advanceTimersByTimeAsync(3_500)

    const sentry = packets.filter((p) => p.data === SENTRY_IDR)
    expect(sentry.length).toBeGreaterThanOrEqual(3)
    expect(sentry.every((p) => p.isPlaceholder === true)).toBe(true)
    expect(sentry.every((p) => p.keyframe)).toBe(true)
  })

  it('does NOT replace the publisher request — the camera is still asked to build', async () => {
    armPrestream()
    const refreshes: number[] = []
    broker.setRequestSourceRefresh(() => refreshes.push(Date.now()))
    broker.setSourceProvider(() => lazySource())
    await broker.start(lazySource())
    await vi.advanceTimersByTimeAsync(2_000)

    expect(refreshes.length).toBeGreaterThan(0)
  })

  it('STOPS on the first real packet, and emits no synthetic frame after it', async () => {
    armPrestream()
    broker.setSourceProvider(() => lazySource())
    await broker.start(lazySource())
    await vi.advanceTimersByTimeAsync(2_500)
    expect(packets.some((p) => p.data === SENTRY_IDR)).toBe(true)

    // The camera woke: real media arrives.
    broker.pushEncodedPacket(realPacket())
    const afterReal = packets.length
    await vi.advanceTimersByTimeAsync(6_000)

    expect(packets.slice(afterReal).some((p) => p.data === SENTRY_IDR)).toBe(false)
  })

  it('does not RE-OPEN the window on the next materialize poll tick', async () => {
    // The lazy branch is re-entered every second while the source still reads
    // `lazy:`. Without a latch, real media would be painted over with a still
    // picture once a second for as long as the publisher kept republishing.
    armPrestream()
    broker.setSourceProvider(() => lazySource())
    await broker.start(lazySource())
    await vi.advanceTimersByTimeAsync(1_500)
    broker.pushEncodedPacket(realPacket())
    const afterReal = packets.length

    await vi.advanceTimersByTimeAsync(20_000)
    expect(packets.slice(afterReal).some((p) => p.data === SENTRY_IDR)).toBe(false)
  })

  it('is NOT stopped by another synthetic frame — only real media ends the window', async () => {
    armPrestream()
    broker.setSourceProvider(() => lazySource())
    await broker.start(lazySource())
    await vi.advanceTimersByTimeAsync(1_500)

    broker.pushEncodedPacket({
      type: 'video',
      data: Buffer.from([0, 0, 0, 1, 0x67]),
      pts: 2,
      dts: 2,
      keyframe: true,
      codec: 'h264',
      isPlaceholder: true,
    })
    const after = packets.length
    await vi.advanceTimersByTimeAsync(3_000)

    expect(packets.slice(after).some((p) => p.data === SENTRY_IDR)).toBe(true)
  })

  it('a broker with NO sentry provider behaves exactly as it did — no frames, no throw', async () => {
    broker.setSourceProvider(() => lazySource())
    await broker.start(lazySource())
    await vi.advanceTimersByTimeAsync(3_000)

    expect(packets).toEqual([])
  })

  it('a REFUSED sentry (unknown geometry) emits nothing', async () => {
    broker.setPrestreamProvider({ prepare: async () => null })
    broker.setSourceProvider(() => lazySource())
    await broker.start(lazySource())
    await vi.advanceTimersByTimeAsync(4_000)

    expect(packets).toEqual([])
  })

  it('never runs for a source that is not lazy', async () => {
    armPrestream()
    const real: StreamSource = {
      type: 'rfc4571',
      url: 'tcp://127.0.0.1:51234',
      videoCodec: 'h264',
      metadata: { sdp: SDP },
    }
    broker.setSourceProvider(() => real)
    await broker.start(real)
    await vi.advanceTimersByTimeAsync(3_000)

    expect(packets.some((p) => p.data === SENTRY_IDR)).toBe(false)
  })
})
