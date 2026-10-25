import { describe, it, expect, beforeEach, vi } from 'vitest'
import { StreamBroker } from '../stream-broker/stream-broker'
import type { BrokerConsumerAttribution, IScopedLogger } from '@camstack/types'

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

describe('StreamBroker.updateConsumerAttributionBySession', () => {
  let broker: StreamBroker

  beforeEach(() => {
    vi.clearAllMocks()
    broker = new StreamBroker('cam-1', createMockLogger())
  })

  function attribution(sessionId: string): BrokerConsumerAttribution {
    return { kind: 'webrtc-browser', sessionId }
  }

  it('tags BOTH the audio (annexb) and video (rtp) rows of a matching session', () => {
    broker.onEncodedData(vi.fn(), { ...attribution('sess-A'), media: 'audio' })
    broker.onVideoRtp(vi.fn(), { ...attribution('sess-A'), media: 'video' })

    const matched = broker.updateConsumerAttributionBySession('sess-A', {
      remoteAddr: '203.0.113.5:51000',
    })

    expect(matched).toBe(true)
    const rows = broker.listClients().encoded
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.attribution.remoteAddr === '203.0.113.5:51000')).toBe(true)
    // Existing fields are preserved across the merge.
    expect(rows.map((r) => r.attribution.media).toSorted()).toEqual(['audio', 'video'])
  })

  it('returns false and tags nothing when no entry matches the sessionId', () => {
    broker.onEncodedData(vi.fn(), attribution('sess-A'))

    const matched = broker.updateConsumerAttributionBySession('sess-OTHER', {
      remoteAddr: '203.0.113.9:40000',
    })

    expect(matched).toBe(false)
    expect(broker.listClients().encoded[0]?.attribution.remoteAddr).toBeUndefined()
  })

  it('builds a NEW attribution object — does not mutate the prior one', () => {
    const original = attribution('sess-A')
    broker.onEncodedData(vi.fn(), original)

    broker.updateConsumerAttributionBySession('sess-A', { userAgent: 'Mozilla/5.0' })

    // The caller-supplied object is untouched.
    expect(original.userAgent).toBeUndefined()
    // The stored entry carries the patch.
    expect(broker.listClients().encoded[0]?.attribution.userAgent).toBe('Mozilla/5.0')
  })

  it('leaves non-matching sessions untouched while tagging the matching one', () => {
    broker.onEncodedData(vi.fn(), attribution('sess-A'))
    broker.onEncodedData(vi.fn(), attribution('sess-B'))

    broker.updateConsumerAttributionBySession('sess-A', { remoteAddr: '198.51.100.7:5000' })

    const rows = broker.listClients().encoded
    const a = rows.find((r) => r.attribution.sessionId === 'sess-A')
    const b = rows.find((r) => r.attribution.sessionId === 'sess-B')
    expect(a?.attribution.remoteAddr).toBe('198.51.100.7:5000')
    expect(b?.attribution.remoteAddr).toBeUndefined()
  })
})

/**
 * The prebuffer HOLD, as a session (D381).
 *
 * It used to be a synthetic hint with a fixed id, SUPPRESSED whenever any real
 * encoded subscriber existed — "the warmth is already explained". Measured on
 * the live hub 2026-09-07 that gate was a lie in both directions: cameras with
 * zero encoded subscribers and one real RTSP session had the prebuffer named as
 * the holder of a stream something else was holding, and a camera the prebuffer
 * really was holding alongside an encoded consumer showed no prebuffer row at
 * all. The hold is a real object now, per-broker id, listed WHENEVER it is open.
 */
describe('StreamBroker prebuffer hold', () => {
  const BROKER_ID = 'cam-ph'
  const HOLD_ID = `prebuffer:${BROKER_ID}`
  let broker: StreamBroker

  beforeEach(() => {
    vi.clearAllMocks()
    broker = new StreamBroker(BROKER_ID, createMockLogger())
  })

  it('lists the hold, identified by this broker, when warm with no real subscriber', () => {
    broker.setPreBufferEnabled(true)

    const clients = broker.listClients()
    const hold = clients.encoded.find((c) => c.id === HOLD_ID)

    expect(hold).toBeDefined()
    expect(hold?.attribution.kind).toBe('warmup')
    // User-Agent label mirrors the recorder's chip so operators can answer
    // "who is keeping cam X warm?".
    expect(hold?.attribution.userAgent).toBe('prebuffer')
    // The hold is a holder, not a consumer being sent packets: it stays out of
    // `encodedSubscribers`.
    expect(clients.encodedSubscribers).toBe(0)
  })

  it('lists no hold when the prebuffer is off', () => {
    broker.setPreBufferEnabled(false)

    expect(broker.listClients().encoded).toHaveLength(0)
  })

  it('lists the hold BESIDE a real encoded subscriber, never instead of it', () => {
    broker.setPreBufferEnabled(true)
    broker.onEncodedData(vi.fn(), { kind: 'webrtc-browser', sessionId: 's1' })

    const clients = broker.listClients()
    // Both holders are named: the subscriber explains its own demand, and the
    // prebuffer is holding this stream whether or not anything else is.
    expect(clients.encoded.find((c) => c.id === HOLD_ID)).toBeDefined()
    expect(clients.encoded.find((c) => c.attribution.sessionId === 's1')).toBeDefined()
    expect(clients.encoded).toHaveLength(2)
    // …and only the real one counts as a subscriber.
    expect(clients.encodedSubscribers).toBe(1)
  })

  it('releases the hold when the prebuffer is turned off', () => {
    broker.setPreBufferEnabled(true)
    broker.setPreBufferEnabled(false)

    expect(broker.listClients().encoded.find((c) => c.id === HOLD_ID)).toBeUndefined()
  })

  it('keeps the ORIGINAL start time when an open hold is re-armed', () => {
    broker.setPreBufferEnabled(true)
    const since = broker.listClients().encoded.find((c) => c.id === HOLD_ID)?.subscribedAt
    expect(since).toBeDefined()

    // Re-applying the same settings must read as "held warm since X", not as
    // "the settings were re-applied just now".
    broker.setPreBufferEnabled(true)
    expect(broker.listClients().encoded.find((c) => c.id === HOLD_ID)?.subscribedAt).toBe(since)
  })
})
