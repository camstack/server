import type { DecodedAudioChunk } from '@camstack/types'
import { describe, expect, it } from 'vitest'

import { AudioChunkPlane } from '../stream-broker/audio-chunk-plane.js'

/**
 * Unit tests for the decoded audio-chunk plane (Phase 5 / D9) — the
 * serialisable, poll-based replacement for `StreamBroker.onDecodedAudioChunk`.
 *
 * The plane keeps a per-subscription bounded FIFO queue: a consumer
 * `subscribe`s, the broker `fanout`s decoded chunks, the consumer drains them
 * in arrival order via `pull`, and `unsubscribe`s on teardown. Audio wants
 * FIFO/no-drop — a gap is audible and breaks an analysis window — so the
 * tests assert arrival order is preserved and overflow drops the OLDEST.
 */

function makeChunk(timestamp: number): DecodedAudioChunk {
  // 4 bytes — one Float32 sample. Real chunks are a few KB; size is irrelevant
  // to the plane, which never inspects the payload.
  return {
    data: Buffer.from([timestamp & 0xff, 0, 0, 0]),
    sampleRate: 16_000,
    channels: 1,
    timestamp,
  }
}

describe('AudioChunkPlane', () => {
  it('delivers fanned-out chunks to a subscriber in FIFO arrival order', () => {
    const plane = new AudioChunkPlane()
    const { subscriptionId } = plane.subscribe({ tag: 'audio-analyzer' })

    plane.fanout(makeChunk(1))
    plane.fanout(makeChunk(2))
    plane.fanout(makeChunk(3))

    const drained = plane.pull(subscriptionId, 8)
    expect(drained.map((c) => c.timestamp)).toEqual([1, 2, 3])
    // The queue is now empty — a second drain yields nothing.
    expect(plane.pull(subscriptionId, 8)).toEqual([])
  })

  it('caps a drain at maxCount and keeps the remainder for the next pull', () => {
    const plane = new AudioChunkPlane()
    const { subscriptionId } = plane.subscribe()

    for (let i = 1; i <= 5; i += 1) plane.fanout(makeChunk(i))

    expect(plane.pull(subscriptionId, 2).map((c) => c.timestamp)).toEqual([1, 2])
    expect(plane.pull(subscriptionId, 2).map((c) => c.timestamp)).toEqual([3, 4])
    expect(plane.pull(subscriptionId, 2).map((c) => c.timestamp)).toEqual([5])
  })

  it('fans one chunk out to every active subscription independently', () => {
    const plane = new AudioChunkPlane()
    const a = plane.subscribe({ tag: 'a' })
    const b = plane.subscribe({ tag: 'b' })

    plane.fanout(makeChunk(10))

    expect(plane.pull(a.subscriptionId, 8).map((c) => c.timestamp)).toEqual([10])
    // Draining `a` does not consume `b`'s copy.
    expect(plane.pull(b.subscriptionId, 8).map((c) => c.timestamp)).toEqual([10])
  })

  it('drops the OLDEST chunk when a stalled consumer overflows the queue', () => {
    const plane = new AudioChunkPlane()
    const { subscriptionId } = plane.subscribe()

    // The queue capacity is 64; push 70 without draining → the first 6 are
    // dropped, the newest 64 survive in FIFO order.
    for (let i = 1; i <= 70; i += 1) plane.fanout(makeChunk(i))

    const drained = plane.pull(subscriptionId, 100)
    expect(drained).toHaveLength(64)
    expect(drained[0]?.timestamp).toBe(7)
    expect(drained[drained.length - 1]?.timestamp).toBe(70)
  })

  it('an unknown / released subscription id drains empty', () => {
    const plane = new AudioChunkPlane()
    const { subscriptionId } = plane.subscribe()

    expect(plane.unsubscribe(subscriptionId)).toBe(true)
    // A released subscription is unknown — pull is a safe empty no-op.
    expect(plane.pull(subscriptionId, 8)).toEqual([])
    expect(plane.unsubscribe(subscriptionId)).toBe(false)
    expect(plane.pull('never-existed', 8)).toEqual([])
  })

  it('tracks subscriber count and chunk-delivery diagnostics', () => {
    const plane = new AudioChunkPlane()
    expect(plane.subscriberCount).toBe(0)

    const { subscriptionId } = plane.subscribe({ tag: 'audio-analyzer' })
    expect(plane.subscriberCount).toBe(1)

    plane.fanout(makeChunk(1))
    plane.fanout(makeChunk(2))
    plane.pull(subscriptionId, 8)

    const [info] = plane.listSubscribers()
    expect(info?.tag).toBe('audio-analyzer')
    expect(info?.chunksDelivered).toBe(2)

    plane.unsubscribe(subscriptionId)
    expect(plane.subscriberCount).toBe(0)
  })

  it('killByTag force-releases every matching subscription', () => {
    const plane = new AudioChunkPlane()
    plane.subscribe({ tag: 'audio-analyzer' })
    plane.subscribe({ tag: 'audio-analyzer' })
    plane.subscribe({ tag: 'other' })

    expect(plane.killByTag('audio-analyzer')).toBe(2)
    expect(plane.subscriberCount).toBe(1)
    expect(plane.listSubscribers()[0]?.tag).toBe('other')
  })

  it('dispose clears every subscription', () => {
    const plane = new AudioChunkPlane()
    plane.subscribe()
    plane.subscribe()
    plane.dispose()
    expect(plane.subscriberCount).toBe(0)
  })
})
