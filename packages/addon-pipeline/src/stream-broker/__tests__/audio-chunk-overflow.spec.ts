/**
 * D465 — the audio-chunk FIFO overflow is NAMED.
 *
 * `AUDIO_QUEUE_CAPACITY` is 64 and `RingBuffer.push` overwrites the oldest
 * entry when full. Every docblock on the path calls that "a bounded safety
 * valve, not the steady-state behaviour" — and not one line is written when the
 * valve opens. So a consumer polling too slowly for its producer (the case
 * D465 found: a remote AAC camera at a 500 ms cadence against a ~42 ms chunk)
 * loses audio permanently and the hub says nothing. That is the branch that
 * DROPS work silently which CLAUDE.md forbids, and the reason the 3-hour media
 * blackout produced no line.
 */
import type { DecodedAudioChunk, IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'

import { AUDIO_QUEUE_CAPACITY, AudioChunkPlane } from '../stream-broker/audio-chunk-plane.js'

function mockLogger(): IScopedLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) {
      return this
    }),
    withTags: vi.fn(function (this: unknown) {
      return this
    }),
  } as unknown as IScopedLogger
}

function chunk(i: number): DecodedAudioChunk {
  return {
    data: Buffer.alloc(4),
    sampleRate: 16000,
    channels: 1,
    timestamp: 1_700_000_000_000 + i,
  }
}

function warnMessages(logger: IScopedLogger): string[] {
  return (logger.warn as ReturnType<typeof vi.fn>).mock.calls.map(([msg]) => String(msg))
}

describe('AudioChunkPlane overflow is named (D465)', () => {
  it('says nothing while the queue has room', () => {
    const logger = mockLogger()
    const plane = new AudioChunkPlane(logger)
    plane.subscribe({ tag: 'audio-analyzer' })

    for (let i = 0; i < AUDIO_QUEUE_CAPACITY; i++) plane.fanout(chunk(i))

    expect(warnMessages(logger).filter((m) => m.includes('OVERFLOW'))).toHaveLength(0)
  })

  it('NAMES the first chunk it overwrites, with the subscription and the tag', () => {
    const logger = mockLogger()
    const plane = new AudioChunkPlane(logger)
    const { subscriptionId } = plane.subscribe({ tag: 'audio-analyzer' })

    for (let i = 0; i < AUDIO_QUEUE_CAPACITY + 1; i++) plane.fanout(chunk(i))

    const overflow = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.filter(([msg]) =>
      String(msg).includes('OVERFLOW'),
    )
    expect(overflow).toHaveLength(1)
    const meta = (overflow[0]![1] as { meta: Record<string, unknown> }).meta
    expect(meta['subscriptionId']).toBe(subscriptionId)
    expect(meta['tag']).toBe('audio-analyzer')
    expect(meta['capacity']).toBe(AUDIO_QUEUE_CAPACITY)
  })

  it('throttles the line but keeps counting what was lost', () => {
    const logger = mockLogger()
    const plane = new AudioChunkPlane(logger)
    const { subscriptionId } = plane.subscribe({ tag: 'audio-analyzer' })

    // 200 chunks past capacity: one line, not 200 — a per-chunk warn on this
    // path is ~25/s per camera of synchronous winston writes on the broker's
    // event loop, which is what the pullPcm warn coalescing exists for.
    for (let i = 0; i < AUDIO_QUEUE_CAPACITY + 200; i++) plane.fanout(chunk(i))

    const overflow = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.filter(([msg]) =>
      String(msg).includes('OVERFLOW'),
    )
    expect(overflow).toHaveLength(1)

    // And the count is still true: draining shows the queue holds exactly the
    // NEWEST capacity chunks, so the loss is derivable, not guessed.
    const drained = plane.pull(subscriptionId, 1_000)
    expect(drained).toHaveLength(AUDIO_QUEUE_CAPACITY)
  })
})
