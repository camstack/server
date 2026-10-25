/**
 * The clip ring is bounded by BYTES, not only by seconds.
 *
 * Its retention is configured in seconds, but what a second costs depends
 * entirely on which profile got armed. On the operator's fleet the cheap
 * profile runs at 34-118 kbps while the main stream runs at up to 11 Mbps — a
 * 25:1 ratio — so a rule arming a clip on the main stream turned a 60-second
 * retention into 82 MB on one camera, silently, in native memory. A time limit
 * cannot express that.
 */
import { describe, expect, it } from 'vitest'

import { EncodedRingBuffer } from '../stream-broker/encoded-ring-buffer.js'
import type { EncodedPacket } from '@camstack/types'

function packet(pts: number, bytes: number, keyframe = false): EncodedPacket {
  return {
    type: 'video',
    data: Buffer.alloc(bytes),
    pts,
    dts: pts,
    keyframe,
    codec: 'h264',
  } as EncodedPacket
}

describe('EncodedRingBuffer byte budget', () => {
  it('keeps the whole configured window when it fits', () => {
    const ring = new EncodedRingBuffer(60, 1_000_000)
    for (let i = 0; i < 10; i++) ring.push(packet(i * 1000, 1_000, i === 0))
    expect(ring.getPacketCount()).toBe(10)
    expect(ring.getBufferedBytes()).toBe(10_000)
    expect(ring.isClampedByBytes()).toBe(false)
  })

  // The expensive-profile case, which is the reason this exists.
  it('drops the OLDEST packets when the window costs more than its budget', () => {
    const ring = new EncodedRingBuffer(60, 5_000)
    for (let i = 0; i < 10; i++) ring.push(packet(i * 1000, 1_000))
    expect(ring.getBufferedBytes()).toBeLessThanOrEqual(5_000)
    expect(ring.isClampedByBytes()).toBe(true)
    // The pre-roll is what goes: the newest packet must survive.
    const kept = ring.getAllPackets()
    expect(kept[kept.length - 1]!.pts).toBe(9_000)
  })

  // A window cut by memory holds LESS time than configured, and a consumer
  // that believes the configured number looks for footage never kept.
  it('says WHICH limit bound it, so a short window is not mistaken for a quiet camera', () => {
    const roomy = new EncodedRingBuffer(60, 1_000_000)
    const tight = new EncodedRingBuffer(60, 2_000)
    for (let i = 0; i < 5; i++) {
      roomy.push(packet(i * 1000, 1_000))
      tight.push(packet(i * 1000, 1_000))
    }
    expect(roomy.isClampedByBytes()).toBe(false)
    expect(tight.isClampedByBytes()).toBe(true)
  })

  it('0 means unbounded — the behaviour before the budget existed', () => {
    const ring = new EncodedRingBuffer(60, 0)
    for (let i = 0; i < 50; i++) ring.push(packet(i * 1000, 10_000))
    expect(ring.getPacketCount()).toBe(50)
    expect(ring.isClampedByBytes()).toBe(false)
  })

  it('the clock still evicts when the budget is not the binding limit', () => {
    const ring = new EncodedRingBuffer(5, 10_000_000)
    for (let i = 0; i < 20; i++) ring.push(packet(i * 1000, 10))
    // 20 s of packets, 5 s retained.
    expect(ring.getBufferedDurationMs()).toBeLessThanOrEqual(5_000)
    expect(ring.isClampedByBytes()).toBe(false)
  })

  it('byte accounting survives eviction — it does not drift', () => {
    const ring = new EncodedRingBuffer(3, 1_000_000)
    for (let i = 0; i < 20; i++) ring.push(packet(i * 1000, 100))
    const counted = ring.getAllPackets().reduce((n, p) => n + p.data.length, 0)
    expect(ring.getBufferedBytes()).toBe(counted)
  })
})
