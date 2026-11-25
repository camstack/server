import type { EncodedPacket, IScopedLogger, StreamSource } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StreamBroker } from '../stream-broker/stream-broker'
import { createPushFrameSource } from '../webrtc/broker-webrtc-server'

/**
 * Drop visibility on the broker's fan-out paths.
 *
 * A branch that drops work logs it — silence reads as "never happened". Before
 * this suite the whole broker had exactly ONE drop counter, and three paths
 * discarded media without a line at any level: the source-RTP ring reset on cap
 * overflow (which silently throws away every joiner's bootstrap), the WebRTC
 * push-frame queue purge (60 frames), and a throwing Annex-B consumer, which
 * additionally aborted the fan-out for every consumer after it in Map order.
 */

function createMockLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
  return logger
}

const RTP_HEADER_SIZE = 12

/** Build a raw H.264 RTP packet of `payloadBytes` carrying `nalType`. */
function buildRtp(seq: number, ts: number, nalType: number, payloadBytes: number): Buffer {
  const header = Buffer.alloc(RTP_HEADER_SIZE)
  header[0] = 0x80
  header[1] = 0x80 | 96 // marker + PT 96
  header.writeUInt16BE(seq & 0xffff, 2)
  header.writeUInt32BE(ts >>> 0, 4)
  header.writeUInt32BE(0x11223344, 8)
  const payload = Buffer.alloc(payloadBytes, 0xcd)
  payload[0] = 0x60 | nalType
  return Buffer.concat([header, payload])
}

function videoPacket(keyframe: boolean): EncodedPacket {
  return {
    type: 'video',
    codec: 'h264',
    data: Buffer.from([0x00, 0x00, 0x00, 0x01, keyframe ? 0x65 : 0x41, 0xaa]),
    pts: 0,
    dts: 0,
    keyframe,
  }
}

function warnedForDevice(logger: IScopedLogger, deviceId: number): boolean {
  return vi.mocked(logger.warn).mock.calls.some(([, extras]) => extras?.tags?.deviceId === deviceId)
}

describe('StreamBroker source-RTP ring overflow', () => {
  let broker: StreamBroker
  let logger: IScopedLogger

  beforeEach(() => {
    vi.useFakeTimers()
    logger = createMockLogger()
    broker = new StreamBroker('101/native', logger)
  })

  afterEach(async () => {
    await broker.stop()
    vi.useRealTimers()
  })

  it('reports the ring reset that throws away every joiner bootstrap', async () => {
    await broker.start({ type: 'push-rtp', url: '', videoCodec: 'h264' } satisfies StreamSource)

    // One keyframe AU so the ring is armed, then P-frames only: nothing trims
    // it, so it grows to the 24 MB cap and is discarded whole.
    broker.pushVideoRtp(buildRtp(1, 90_000, 7, 32))
    broker.pushVideoRtp(buildRtp(2, 90_000, 5, 4096))
    expect(broker.getRtpPreBuffer().length).toBeGreaterThan(0)

    const PKT = 256 * 1024
    for (let i = 0; i < 24 * 4 + 4; i++) {
      broker.pushVideoRtp(buildRtp(10 + i, 93_000 + i * 3000, 1, PKT))
    }

    // The bootstrap is gone…
    expect(broker.getRtpPreBuffer()).toEqual([])
    // …and it said so, per camera.
    expect(warnedForDevice(logger, 101)).toBe(true)
  })
})

describe('StreamBroker Annex-B fan-out', () => {
  let broker: StreamBroker
  let logger: IScopedLogger

  beforeEach(() => {
    vi.useFakeTimers()
    logger = createMockLogger()
    broker = new StreamBroker('102/native', logger)
  })

  afterEach(async () => {
    await broker.stop()
    vi.useRealTimers()
  })

  it('delivers to every consumer even when an earlier one throws', async () => {
    await broker.start({ type: 'push', url: '', videoCodec: 'h264' } satisfies StreamSource)

    const seen: string[] = []
    broker.onEncodedData(() => {
      seen.push('first')
    })
    broker.onEncodedData(() => {
      throw new Error('consumer exploded')
    })
    broker.onEncodedData(() => {
      seen.push('third')
    })

    broker.pushEncodedPacket(videoPacket(true))
    broker.pushEncodedPacket(videoPacket(false))

    // Unguarded, the throw aborts the loop and every consumer after it in Map
    // insertion order loses the packet — `third` would never appear.
    expect(seen).toEqual(['first', 'third', 'first', 'third'])
    expect(warnedForDevice(logger, 102)).toBe(true)
  })
})

describe('WebRTC push frame source', () => {
  it('reports the frames purged when the queue overflows', () => {
    const dropped: number[] = []
    const { pushFrame, close } = createPushFrameSource((n) => dropped.push(n))

    // Nothing consumes the async generator, so every frame queues.
    for (let i = 0; i < 130; i++) {
      pushFrame({
        type: 'video',
        frame: {
          data: Buffer.from([i]),
          codec: 'H264',
          isKeyframe: false,
          timestampMicros: i,
        },
      })
    }
    close()

    // 121 queued → purge back to 60 = 61 frames discarded, once, reported.
    // No keyframe anywhere: the plain-bound cut plus the leftover mid-GOP video.
    expect(dropped).toEqual([121])
  })

  /**
   * The 587 Alexa session: `webrtc push queue overflow — encoded frames dropped
   * {frames=61}` one second after the session was created. The queue is the
   * gap between subscribing (which replays the broker's retained GOP and then
   * takes live packets) and the moment werift starts pulling the generator —
   * which for Alexa is after non-trickle ICE gathering and the Echo's answer,
   * seconds later. The bound itself is right; the CUT was not. Keeping "the
   * last 60" starts the retained window at whatever P-frame happened to land
   * there, so the first thing the Echo could decode was the NEXT IDR — a whole
   * keyframe interval of black after a purge that was supposed to be a
   * recovery.
   */
  it('purges to a KEYFRAME boundary so what survives is decodable', async () => {
    const dropped: number[] = []
    const aligned: boolean[] = []
    const { source, pushFrame, close } = createPushFrameSource((n, keyframeAligned) => {
      dropped.push(n)
      aligned.push(keyframeAligned)
    })

    // A 50-frame GOP: keyframes at 0, 50, 100. The purge fires at 121.
    for (let i = 0; i < 121; i++) {
      pushFrame({
        type: 'video',
        frame: {
          data: Buffer.from([i]),
          codec: 'H264',
          isKeyframe: i % 50 === 0,
          timestampMicros: i * 40_000,
        },
      })
    }
    close()

    // The smallest cut that is BOTH within the bound (≥ 61, so ≤ 60 frames are
    // retained) and lands on a keyframe: index 100.
    expect(dropped).toEqual([100])
    expect(aligned).toEqual([true])

    const first = await source.next()
    expect(first.done).toBe(false)
    expect(first.value?.type).toBe('video')
    expect(first.value?.type === 'video' && first.value.frame.isKeyframe).toBe(true)
  })
})

describe('WebRTC push frame source - keyframe-aligned start (planning#730)', () => {
  const vid = (i: number, key: boolean) =>
    ({
      type: 'video',
      frame: { data: Buffer.from([i]), codec: 'H264', isKeyframe: key, timestampMicros: i },
    }) as const

  it('starts from the LATEST queued keyframe, not a stale backlog', async () => {
    const { source, pushFrame, close } = createPushFrameSource()
    for (let i = 0; i < 30; i++) pushFrame(vid(i, i === 0 || i === 20))
    const first = await source.next()
    close()
    expect(first.value?.type === 'video' && first.value.frame.data[0]).toBe(20)
  })

  it('a purge with no keyframe leaves no mid-GOP video and waits for the next IDR', async () => {
    const { source, pushFrame, close } = createPushFrameSource()
    for (let i = 0; i < 125; i++) pushFrame(vid(i % 200, false))
    pushFrame(vid(200, false))
    pushFrame(vid(201, true))
    pushFrame(vid(202, false))
    const first = await source.next()
    const second = await source.next()
    close()
    expect(first.value?.type === 'video' && first.value.frame.data[0]).toBe(201)
    expect(second.value?.type === 'video' && second.value.frame.data[0]).toBe(202)
  })

  it('an EMPTY queue at the first pull still waits for a keyframe (no mid-GOP start)', async () => {
    const { source, pushFrame, close } = createPushFrameSource()
    const pending = source.next()
    // The generator has run its first pull and parked: P-frames must not reach it.
    await Promise.resolve()
    pushFrame(vid(1, false))
    pushFrame(vid(2, true))
    const first = await pending
    close()
    expect(first.value?.type === 'video' && first.value.frame.data[0]).toBe(2)
  })

  const aud = (i: number) =>
    ({
      type: 'audio',
      frame: {
        data: Buffer.from([i]),
        codec: 'Opus',
        sampleRate: 48000,
        channels: 2,
        timestampMicros: i,
      },
    }) as const

  it('audio pushed while waiting for the IDR is dropped, after an empty first pull', async () => {
    const { source, pushFrame, close } = createPushFrameSource()
    const pending = source.next()
    await Promise.resolve()
    pushFrame(aud(7))
    pushFrame(vid(2, true))
    const first = await pending
    close()
    expect(first.value?.type).toBe('video')
    expect(first.value?.type === 'video' && first.value.frame.isKeyframe).toBe(true)
  })

  it('audio pushed after a no-keyframe purge is dropped until the IDR', async () => {
    const { source, pushFrame, close } = createPushFrameSource()
    // Consume the first pull (a keyframe) so the purge below runs on a live queue.
    pushFrame(vid(0, true))
    await source.next()
    for (let i = 1; i < 130; i++) pushFrame(vid(i % 200, false))
    pushFrame(aud(9))
    pushFrame(vid(201, true))
    const first = await source.next()
    close()
    expect(first.value?.type).toBe('video')
    expect(first.value?.type === 'video' && first.value.frame.isKeyframe).toBe(true)
  })

  it('an audio-only source (video rides RTP) is never gated on a keyframe', async () => {
    const { source, pushFrame, close } = createPushFrameSource(undefined, () => false)
    const pending = source.next()
    await Promise.resolve()
    pushFrame(aud(7))
    const first = await pending
    close()
    expect(first.value?.type).toBe('audio')
  })
})
