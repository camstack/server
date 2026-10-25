import { describe, it, expect, vi } from 'vitest'
import type { EncodedPacket, IScopedLogger, StreamSource } from '@camstack/types'
import { StreamBroker } from '../stream-broker/stream-broker'

/**
 * Clip retention — the ring `renderPreBufferClip` cuts from.
 *
 * The AnnexB `preBuffer` is deliberately EMPTY for RTP sources (the WebRTC
 * join path reads it, and RTSP cameras bootstrap from the raw-RTP ring
 * instead), which is most cameras. Retention therefore keeps its own ring, so
 * a notification clip works on an RTSP camera without changing what a
 * late-joining viewer is flushed.
 */
function logger(): IScopedLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  } as unknown as IScopedLogger
}

const rtspSource: StreamSource = { type: 'rtsp', url: 'rtsp://cam/main', videoCodec: 'h264' }

function video(pts: number, keyframe = false): EncodedPacket {
  return { type: 'video', data: Buffer.from([pts & 0xff]), pts, dts: pts, keyframe, codec: 'h264' }
}

async function brokerOn(source: StreamSource): Promise<StreamBroker> {
  const broker = new StreamBroker('dev-1', logger())
  await broker.start(source)
  return broker
}

describe('clip retention', () => {
  it('fills its own ring on an RTSP source, where the pre-buffer stays empty', async () => {
    const broker = await brokerOn(rtspSource)
    broker.setClipRetention(10)
    broker.pushEncodedPacket(video(0, true))
    broker.pushEncodedPacket(video(500))
    broker.pushEncodedPacket(video(1000))

    expect(broker.getClipBuffer()).toHaveLength(3)
    // Unchanged: the WebRTC join path still sees nothing here on RTP sources.
    expect(broker.getPreBuffer()).toHaveLength(0)
    await broker.stop()
  })

  it('retains NOTHING until asked — retention is opt-in per broker', async () => {
    const broker = await brokerOn(rtspSource)
    broker.pushEncodedPacket(video(0, true))
    broker.pushEncodedPacket(video(500))
    expect(broker.getClipBuffer()).toHaveLength(0)
    await broker.stop()
  })

  // The pre-roll is exactly the packets BEFORE the last keyframe — the ring's
  // own `getPackets()` cuts there, which would leave a clip that starts after
  // the moment it is supposed to show.
  it('keeps the packets before the most recent keyframe', async () => {
    const broker = await brokerOn(rtspSource)
    broker.setClipRetention(10)
    broker.pushEncodedPacket(video(0, true))
    broker.pushEncodedPacket(video(500))
    broker.pushEncodedPacket(video(1000))
    broker.pushEncodedPacket(video(1500, true))
    broker.pushEncodedPacket(video(2000))

    const held = broker.getClipBuffer()
    expect(held).toHaveLength(5)
    expect(held[0]?.pts).toBe(0)
    await broker.stop()
  })

  it('drops the ring when retention is turned off', async () => {
    const broker = await brokerOn(rtspSource)
    broker.setClipRetention(10)
    broker.pushEncodedPacket(video(0, true))
    broker.setClipRetention(0)
    expect(broker.getClipBuffer()).toHaveLength(0)
    broker.pushEncodedPacket(video(500))
    expect(broker.getClipBuffer()).toHaveLength(0)
    await broker.stop()
  })

  // Across a redial the source re-bases its pts (RFC 3550); stitching the two
  // epochs into one clip would play garbage.
  it('clears the ring on teardown', async () => {
    const broker = await brokerOn(rtspSource)
    broker.setClipRetention(10)
    broker.pushEncodedPacket(video(0, true))
    expect(broker.getClipBuffer()).toHaveLength(1)
    await broker.stop()
    expect(broker.getClipBuffer()).toHaveLength(0)
  })
})
