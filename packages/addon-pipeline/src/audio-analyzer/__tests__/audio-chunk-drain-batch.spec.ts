/**
 * D465 — a pull cadence is bounded by the DRAIN BATCH and the producer's chunk
 * cadence, never by the boundary it crosses.
 *
 * D461 set `REMOTE_POLL_INTERVAL_MS = 500` reasoning "one poll per chunk",
 * because `AudioRtpDecoder` buffers native G.711 into ~0.5 s chunks. The AAC
 * path does not: `AudioCodecSession` emits one chunk per decoded codec frame,
 * ~42 ms on this fleet, deliberately (the accumulator was removed to give
 * WebRTC sub-100 ms latency). 500 ms of a ~42 ms producer is ~12 chunks and
 * `PULL_MAX_COUNT` was 8 — so a remote AAC camera fell 4 chunks further behind
 * every poll, filled the 64-deep FIFO in ~15 s, and then lost audio for as long
 * as it was dispatched. Silently: `RingBuffer.push` overwrites the oldest entry
 * and says nothing.
 *
 * The rule that makes the cadence safe for any producer: a pull that comes back
 * FULL is not a drain, it is a backlog — pull again immediately, under a bound.
 */
import type { AddonApi, DecodedAudioChunkWire, IScopedLogger } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PULL_MAX_COUNT, startAudioChunkPoller } from '../audio-chunk-poller.js'

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

function chunk(index: number): DecodedAudioChunkWire {
  return {
    data: new Uint8Array(4),
    sampleRate: 16000,
    channels: 1,
    timestamp: 1_700_000_000_000 + index,
  } as unknown as DecodedAudioChunkWire
}

interface Harness {
  readonly api: AddonApi
  readonly pullAudioChunks: ReturnType<typeof vi.fn>
  readonly queue: DecodedAudioChunkWire[]
}

/** A broker holding `backlog` chunks, drained `maxCount` at a time. */
function makeApi(backlog: number): Harness {
  const queue = Array.from({ length: backlog }, (_, i) => chunk(i))
  const pullAudioChunks = vi
    .fn()
    .mockImplementation(async (input: { maxCount: number }) => queue.splice(0, input.maxCount))
  const api = {
    streamBroker: {
      subscribeAudioChunks: { mutate: vi.fn().mockResolvedValue({ subscriptionId: 'sub-1' }) },
      pullAudioChunks: { query: pullAudioChunks },
      unsubscribeAudioChunks: { mutate: vi.fn().mockResolvedValue(undefined) },
    },
  } as unknown as AddonApi
  return { api, pullAudioChunks, queue }
}

describe('audio-chunk drain batch (D465)', () => {
  const teardowns: Array<() => void> = []
  afterEach(() => {
    for (const t of teardowns.splice(0)) t()
  })

  it('covers the slowest cadence the boundary can choose against a ~42 ms producer', () => {
    // REMOTE_POLL_INTERVAL_MS is 500 ms; an AAC session produces one chunk per
    // ~42 ms. One poll must be able to carry a whole interval's production or
    // the queue only ever grows.
    const producedPerRemoteInterval = 500 / 42
    expect(PULL_MAX_COUNT).toBeGreaterThanOrEqual(Math.ceil(producedPerRemoteInterval))
  })

  it('pulls again immediately while the batch comes back full', async () => {
    // Three full batches of backlog. A poller that waited a full interval
    // between them would need three intervals to catch up and would never
    // catch up at all against a live producer.
    const h = makeApi(PULL_MAX_COUNT * 3)
    const seen: DecodedAudioChunkWire[] = []

    teardowns.push(
      startAudioChunkPoller({
        api: h.api,
        brokerId: '104/main',
        tag: 'audio-analyzer',
        ownerNodeId: 'hub',
        // A deliberately huge interval: anything the poller delivers inside
        // the assertion window came from an immediate continuation, not a tick.
        pollIntervalMs: 60_000,
        onChunk: async (c) => {
          seen.push(c)
        },
        logger: mockLogger(),
      }),
    )

    await vi.waitFor(() => expect(seen.length).toBe(PULL_MAX_COUNT * 3), { timeout: 2_000 })
    expect(h.queue).toHaveLength(0)
  })

  it('stops continuing once a batch comes back short', async () => {
    const h = makeApi(PULL_MAX_COUNT + 1)
    const seen: DecodedAudioChunkWire[] = []

    teardowns.push(
      startAudioChunkPoller({
        api: h.api,
        brokerId: '104/main',
        tag: 'audio-analyzer',
        ownerNodeId: 'hub',
        pollIntervalMs: 60_000,
        onChunk: async (c) => {
          seen.push(c)
        },
        logger: mockLogger(),
      }),
    )

    await vi.waitFor(() => expect(seen.length).toBe(PULL_MAX_COUNT + 1), { timeout: 2_000 })
    // One full batch, one short batch, then it waits for the next tick.
    await new Promise((r) => setTimeout(r, 50))
    expect(h.pullAudioChunks.mock.calls.length).toBe(2)
  })

  it('NAMES the backlog rather than absorbing it silently', async () => {
    const logger = mockLogger()
    const h = makeApi(PULL_MAX_COUNT * 2)

    teardowns.push(
      startAudioChunkPoller({
        api: h.api,
        brokerId: '104/main',
        tag: 'audio-analyzer',
        ownerNodeId: 'hub',
        pollIntervalMs: 60_000,
        onChunk: vi.fn(),
        logger,
      }),
    )

    await vi.waitFor(() => expect(h.queue).toHaveLength(0), { timeout: 2_000 })

    const warned = (logger.warn as ReturnType<typeof vi.fn>).mock.calls
    expect(warned.some(([msg]) => String(msg).toLowerCase().includes('backlog'))).toBe(true)
  })
})
