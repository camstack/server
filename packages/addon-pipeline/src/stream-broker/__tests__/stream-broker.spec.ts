import type { EncodedPacket, IScopedLogger, StreamSource } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StreamBroker } from '../stream-broker/stream-broker'

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

function createTestSource(overrides?: Partial<StreamSource>): StreamSource {
  return {
    type: 'rtsp',
    url: 'rtsp://localhost/stream',
    videoCodec: 'h264',
    audioCodec: 'aac',
    ...overrides,
  }
}

function createTestPacket(overrides?: Partial<EncodedPacket>): EncodedPacket {
  return {
    type: 'video',
    data: Buffer.from('test'),
    pts: 0,
    dts: 0,
    keyframe: true,
    codec: 'h264',
    ...overrides,
  }
}

describe('StreamBroker', () => {
  let broker: StreamBroker
  let logger: IScopedLogger

  beforeEach(() => {
    vi.clearAllMocks()
    logger = createMockLogger()
    broker = new StreamBroker('cam-1', logger)
  })

  afterEach(async () => {
    // Ensure cleanup
    if (broker.status !== 'stopped') {
      await broker.stop()
    }
  })

  it('starts in idle status', () => {
    expect(broker.status).toBe('idle')
    expect(broker.deviceId).toBe('cam-1')
  })

  it('transitions to streaming after start with non-RTSP source', async () => {
    await broker.start(createTestSource({ type: 'tcp-raw' }))
    expect(broker.status).toBe('streaming')
  })

  it('manages encoded data subscribers', () => {
    const cb1 = vi.fn()
    const cb2 = vi.fn()

    const unsub1 = broker.onEncodedData(cb1)
    const unsub2 = broker.onEncodedData(cb2)

    const stats = broker.getStats()
    expect(stats.encodedSubscribers).toBe(2)

    unsub1()
    const statsAfter = broker.getStats()
    expect(statsAfter.encodedSubscribers).toBe(1)

    unsub2()
    expect(broker.getStats().encodedSubscribers).toBe(0)
  })

  it('stops cleanly', async () => {
    await broker.start(createTestSource({ type: 'tcp-raw' }))
    broker.onEncodedData(vi.fn())

    await broker.stop()

    expect(broker.status).toBe('stopped')
    expect(broker.getStats().encodedSubscribers).toBe(0)
  })

  it('pushEncodedPacket forwards to encoded callbacks', async () => {
    await broker.start(createTestSource({ type: 'tcp-raw' }))

    const cb = vi.fn()
    broker.onEncodedData(cb)

    const packet = createTestPacket()
    broker.pushEncodedPacket(packet)

    expect(cb).toHaveBeenCalledWith(packet)
  })

  it('returns stats', async () => {
    await broker.start(createTestSource({ type: 'tcp-raw' }))

    const stats = broker.getStats()
    expect(stats.status).toBe('streaming')
    expect(stats.encodedSubscribers).toBe(0)
    expect(stats.uptimeMs).toBeGreaterThanOrEqual(0)
  })

  // D762: the broker decodes nothing — decoding runs in the per-session decode
  // workers. The fields its removed frame-handle plane fed read 0 / null on
  // every live camera, so they are gone rather than reported as measurements.
  it('reports no decode rate, decoded subscribers or decoder node', async () => {
    await broker.start(createTestSource({ type: 'tcp-raw' }))
    broker.onEncodedData(vi.fn())

    const keys = Object.keys(broker.getStats())
    expect(keys).not.toContain('decodeFps')
    expect(keys).not.toContain('decodedSubscribers')
    expect(keys).not.toContain('decoderNodeId')
    expect(Object.keys(broker.listClients())).not.toContain('decoded')
  })

  it('manages audio chunk subscribers (Phase 5 / D9 plane)', async () => {
    const { subscriptionId } = broker.subscribeAudioChunks({ tag: 'audio-analyzer' })
    expect(typeof subscriptionId).toBe('string')
    // No chunks decoded yet → an empty drain.
    expect(broker.pullAudioChunks(subscriptionId, 8)).toEqual([])
    expect(broker.unsubscribeAudioChunks(subscriptionId)).toBe(true)
    // A second unsubscribe of the same id is a no-op.
    expect(broker.unsubscribeAudioChunks(subscriptionId)).toBe(false)
  })

  // Regression: audio subscribers must count as broker demand. Before
  // the fix, a camera with audio analysis enabled but no decoded-video
  // consumer (motion-wasm off + motion phase idle) would suspend the
  // RTSP broker between motion bursts and stop delivering audio chunks.
  // The user-visible symptom was a stale audioMetrics chip in the UI.
  //
  // The audio subscriber is attached BEFORE the dial, and the control case
  // below dials the same source with nothing attached. That pairing is what
  // makes the assertion load-bearing: `rtsp` is a lazy-dial source, so a broker
  // with no demand registers idle at `start()`. This test used to read the
  // demand off a bare `new StreamBroker(...)` being warm, which it was only
  // because the prebuffer defaulted ON (D381 turned that default off) — so it
  // would have passed with audio demand entirely unwired.
  it('keeps an RTSP broker alive when only an audio subscriber is attached', async () => {
    const { subscriptionId } = broker.subscribeAudioChunks({ tag: 'audio-analyzer' })
    await broker.start(createTestSource({ type: 'rtsp' }))
    // Audio subscriber attached → the lazy-dial source is dialed and stays awake.
    expect(broker.suspended).toBe(false)
    broker.unsubscribeAudioChunks(subscriptionId)
  })

  it('…and the same RTSP source registers idle with NO subscriber at all', async () => {
    // The control for the test above: nothing counts this broker as demanded,
    // so the dial is deferred. Without this, "stays awake" would be free.
    await broker.start(createTestSource({ type: 'rtsp' }))
    expect(broker.suspended).toBe(true)
  })

  describe('subscriber attribution', () => {
    it('records the kind/label on encoded subscriptions and surfaces it via listClients', () => {
      const cb = vi.fn()
      broker.onEncodedData(cb, { kind: 'alexa', label: 'alexa cam-1 sess-xyz', sessionId: 'xyz' })

      const clients = broker.listClients()
      expect(clients.encoded).toHaveLength(1)
      const entry = clients.encoded[0]!
      expect(entry.channel).toBe('annexb')
      expect(entry.attribution.kind).toBe('alexa')
      expect(entry.attribution.label).toBe('alexa cam-1 sess-xyz')
      expect(entry.attribution.sessionId).toBe('xyz')
      expect(entry.packetsDelivered).toBe(0)
    })

    it('records the kind on RTP subscriptions on a distinct channel', () => {
      const cb = vi.fn()
      broker.onVideoRtp(cb, { kind: 'webrtc-browser', label: 'safari Andrea' })

      const clients = broker.listClients()
      expect(clients.encoded).toHaveLength(1)
      const entry = clients.encoded[0]!
      expect(entry.channel).toBe('rtp')
      expect(entry.attribution.kind).toBe('webrtc-browser')
    })

    it('defaults to "unknown" attribution when the caller omits it', () => {
      broker.onEncodedData(vi.fn())
      const entry = broker.listClients().encoded[0]!
      expect(entry.attribution.kind).toBe('unknown')
    })

    it('removes the subscriber from listClients when its unsubscribe fires', () => {
      // Isolate real-subscriber lifecycle from the prebuffer warm-hold hint,
      // which surfaces a synthetic entry once the real subscriber leaves.
      broker.setPreBufferEnabled(false)
      const unsub = broker.onEncodedData(vi.fn(), { kind: 'homekit' })
      expect(broker.listClients().encoded).toHaveLength(1)
      unsub()
      expect(broker.listClients().encoded).toHaveLength(0)
    })

    it('increments packetsDelivered on each fanout call', () => {
      const cb = vi.fn()
      broker.onEncodedData(cb, { kind: 'homekit' })

      broker.pushEncodedPacket(createTestPacket())
      broker.pushEncodedPacket(createTestPacket())
      broker.pushEncodedPacket(createTestPacket())

      expect(broker.listClients().encoded[0]!.packetsDelivered).toBe(3)
    })

    it('rolls encoded + RTP counts into stats.encodedSubscribers', () => {
      broker.onEncodedData(vi.fn(), { kind: 'webrtc-browser' })
      broker.onEncodedData(vi.fn(), { kind: 'alexa' })
      broker.onVideoRtp(vi.fn(), { kind: 'webrtc-browser' })

      expect(broker.getStats().encodedSubscribers).toBe(3)
    })
  })

  describe('placeholder reasons', () => {
    it('exposes setPlaceholderReason as a public API', () => {
      // Sanity check — the broker accepts every documented PlaceholderKind
      // without throwing, including the wake-up reason wired via
      // EventCategory.BatteryOnWakeStarted.
      expect(() => broker.setPlaceholderReason('reconnecting')).not.toThrow()
      expect(() => broker.setPlaceholderReason('sleeping')).not.toThrow()
      expect(() => broker.setPlaceholderReason('waking')).not.toThrow()
      expect(() => broker.setPlaceholderReason('offline')).not.toThrow()
      expect(() => broker.setPlaceholderReason('disabled')).not.toThrow()
    })
  })
})
