import { describe, expect, it, vi } from 'vitest'

import { StreamBroker } from '../stream-broker.js'
import type { SentryFrame } from '../sentry-pump.js'

const FRAME: SentryFrame = {
  annexB: Buffer.from([0, 0, 0, 1, 0x26, 0x01]),
  codec: 'h265',
}

function realPacket() {
  const now = Date.now()
  return {
    type: 'video' as const,
    codec: 'h265' as const,
    data: Buffer.from([1, 2, 3]),
    pts: now,
    dts: now,
    keyframe: true,
  }
}

function makeBroker(onRealMediaStarted: () => void): StreamBroker {
  const broker = new StreamBroker('640/native:main')
  broker.setPrestreamProvider({ prepare: async () => FRAME, onRealMediaStarted })
  broker.setSourceProvider(() => ({
    type: 'rfc4571',
    url: 'lazy:rfc4571:native%3Amain',
    videoCodec: 'h265',
  }))
  return broker
}

describe('the sentry refreshes its picture from the live window', () => {
  it('tells the manager when REAL media starts', () => {
    const onRealMediaStarted = vi.fn()
    const broker = makeBroker(onRealMediaStarted)
    broker.pushEncodedPacket(realPacket())
    expect(onRealMediaStarted).toHaveBeenCalledTimes(1)
    broker.stop()
  })

  it('does NOT fire for a picture the broker drew itself', () => {
    // A synthetic frame is the sentry's own output. Treating it as media
    // would ask the camera for a snapshot of a photograph — and would do it on
    // a sleeping camera, which is the one thing this whole path exists to
    // avoid.
    const onRealMediaStarted = vi.fn()
    const broker = makeBroker(onRealMediaStarted)
    broker.pushEncodedPacket({ ...realPacket(), isPlaceholder: true })
    expect(onRealMediaStarted).not.toHaveBeenCalled()
    broker.stop()
  })

  it('fires ONCE per wake, not per packet', () => {
    // It is on the per-packet path. A capture per packet would be a capture per
    // frame of a live stream.
    const onRealMediaStarted = vi.fn()
    const broker = makeBroker(onRealMediaStarted)
    for (let i = 0; i < 25; i += 1) broker.pushEncodedPacket(realPacket())
    expect(onRealMediaStarted).toHaveBeenCalledTimes(1)
    broker.stop()
  })

  it('a hook that throws does not take the packet with it', () => {
    // It runs inside `pushEncodedPacket`. An exception here would kill the very
    // packet that woke it — the media path must not be able to fail because a
    // snapshot refresh did.
    const broker = makeBroker(() => {
      throw new Error('boom')
    })
    expect(() => broker.pushEncodedPacket(realPacket())).not.toThrow()
    broker.stop()
  })
})
