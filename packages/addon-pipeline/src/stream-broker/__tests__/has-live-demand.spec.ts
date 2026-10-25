/**
 * `hasLiveDemand` is what separates a battery camera that slept unasked from one
 * that failed to wake for somebody (D883). It must count every real consumer and
 * must NOT count a sentry or a prestream, which never dial the camera (D173, D502).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import { StreamBroker } from '../stream-broker/stream-broker.js'

function logger(): IScopedLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
}

describe('StreamBroker.hasLiveDemand', () => {
  const brokers: StreamBroker[] = []

  async function broker(): Promise<StreamBroker> {
    const b = new StreamBroker('640/native:main', logger())
    await b.start({ type: 'push', url: '', videoCodec: 'h264' })
    brokers.push(b)
    return b
  }

  afterEach(async () => {
    await Promise.all(brokers.splice(0).map((b) => b.stop().catch(() => {})))
    vi.restoreAllMocks()
  })

  it('is false with no consumer at all', async () => {
    expect((await broker()).hasLiveDemand()).toBe(false)
  })

  it('counts a live viewer, and stops counting it when it leaves', async () => {
    const b = await broker()
    const off = b.onEncodedData(() => {}, { kind: 'webrtc-browser' })
    expect(b.hasLiveDemand()).toBe(true)
    off()
    expect(b.hasLiveDemand()).toBe(false)
  })

  it('counts a recording (raw RTP consumer)', async () => {
    const b = await broker()
    const off = b.onVideoRtp(() => {}, { kind: 'recording' })
    expect(b.hasLiveDemand()).toBe(true)
    off()
  })

  it('counts a detection decode (pipeline consumer)', async () => {
    const b = await broker()
    const off = b.onEncodedData(() => {}, { kind: 'pipeline' })
    expect(b.hasLiveDemand()).toBe(true)
    off()
  })

  it('does NOT count a sentry (prestream window)', async () => {
    const b = await broker()
    const release = b.openPrestreamWindow()
    expect(b.hasLiveDemand()).toBe(false)
    release()
  })

  it('does NOT count a prestream RTSP session', async () => {
    const b = await broker()
    vi.spyOn(b.getRtspRestreamer(), 'getPrestreamSessionCount').mockReturnValue(1)
    expect(b.hasLiveDemand()).toBe(false)
  })

  it('counts a camera-reported wake hold (and only while it lasts)', async () => {
    const b = await broker()
    vi.spyOn(b.getRtspRestreamer(), 'getPrestreamSessionCount').mockReturnValue(1)
    const outcome = b.reportWakeSignal('motion', 30_000, Date.now())
    expect(outcome).not.toBe('no-consumer')
    expect(b.hasLiveDemand()).toBe(true)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
    expect(b.hasLiveDemand()).toBe(false)
  })
})
