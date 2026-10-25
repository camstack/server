/**
 * Owner-node pin coverage for `startAudioChunkPoller` (Task 2 of the
 * cluster-owner source-acquisition slice). Camera-source acquisition moves to
 * the cluster owner (`clusterRoles.ingestNode`); the audio chunk poller is
 * the in-process consumer of the broker's `subscribeAudioChunks` /
 * `pullAudioChunks` / `unsubscribeAudioChunks` plane and must pin all three
 * calls to `ownerNodeId` so they land on the node that actually owns the
 * broker once acquisition is no longer node-local by default. Mirrors the
 * fake-api + `toHaveBeenCalledWith(..., nodePin(...))` pattern from
 * `packages/addon-pipeline/src/pipeline-runner/__tests__/session-decode-acquire.spec.ts`.
 */
import type { AddonApi, IScopedLogger } from '@camstack/types'
import { nodePin } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { startAudioChunkPoller } from '../audio-chunk-poller.js'

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

interface FakeApi {
  api: AddonApi
  subscribeAudioChunks: ReturnType<typeof vi.fn>
  pullAudioChunks: ReturnType<typeof vi.fn>
  unsubscribeAudioChunks: ReturnType<typeof vi.fn>
}

function makeFakeApi(): FakeApi {
  const subscribeAudioChunks = vi.fn().mockResolvedValue({ subscriptionId: 'sub-1' })
  const pullAudioChunks = vi.fn().mockResolvedValue([])
  const unsubscribeAudioChunks = vi.fn().mockResolvedValue(undefined)
  const api = {
    streamBroker: {
      subscribeAudioChunks: { mutate: subscribeAudioChunks },
      pullAudioChunks: { query: pullAudioChunks },
      unsubscribeAudioChunks: { mutate: unsubscribeAudioChunks },
    },
  } as unknown as AddonApi
  return { api, subscribeAudioChunks, pullAudioChunks, unsubscribeAudioChunks }
}

describe('startAudioChunkPoller (owner-node pin threading)', () => {
  const teardowns: Array<() => void> = []

  afterEach(() => {
    for (const teardown of teardowns.splice(0)) teardown()
  })

  it('pins all three streamBroker calls to the owner node when ownerNodeId is set', async () => {
    const fake = makeFakeApi()
    const pin = nodePin('owner-x')

    const teardown = startAudioChunkPoller({
      api: fake.api,
      brokerId: '104/main',
      tag: 'audio-analyzer',
      ownerNodeId: 'owner-x',
      onChunk: vi.fn(),
      logger: mockLogger(),
    })
    teardowns.push(teardown)

    await vi.waitFor(() => expect(fake.pullAudioChunks).toHaveBeenCalled())

    expect(fake.subscribeAudioChunks).toHaveBeenCalledWith(
      { brokerId: '104/main', tag: 'audio-analyzer' },
      pin,
    )
    expect(fake.pullAudioChunks).toHaveBeenCalledWith(
      { subscriptionId: 'sub-1', maxCount: 32 },
      pin,
    )

    teardown()
    expect(fake.unsubscribeAudioChunks).toHaveBeenCalledWith({ subscriptionId: 'sub-1' }, pin)
  })

  it("defaults to 'hub' -> nodePin('hub'), a no-op pin matching today's unpinned hub-targeting behavior", async () => {
    const fake = makeFakeApi()
    const pin = nodePin('hub')

    const teardown = startAudioChunkPoller({
      api: fake.api,
      brokerId: '104/main',
      tag: 'audio-analyzer',
      ownerNodeId: 'hub',
      onChunk: vi.fn(),
      logger: mockLogger(),
    })
    teardowns.push(teardown)

    await vi.waitFor(() => expect(fake.pullAudioChunks).toHaveBeenCalled())

    expect(fake.subscribeAudioChunks).toHaveBeenCalledWith(
      { brokerId: '104/main', tag: 'audio-analyzer' },
      pin,
    )
    expect(fake.pullAudioChunks).toHaveBeenCalledWith(
      { subscriptionId: 'sub-1', maxCount: 32 },
      pin,
    )

    teardown()
    expect(fake.unsubscribeAudioChunks).toHaveBeenCalledWith({ subscriptionId: 'sub-1' }, pin)
  })
})

describe('accept declaration (D455)', () => {
  const teardowns: Array<() => void> = []

  afterEach(() => {
    for (const teardown of teardowns.splice(0)) teardown()
  })

  it('carries the consumer accepted formats on subscribe', async () => {
    const fake = makeFakeApi()

    const teardown = startAudioChunkPoller({
      api: fake.api,
      brokerId: '104/main',
      tag: 'audio-analyzer',
      ownerNodeId: 'hub',
      accept: ['pcmu', 'pcma'],
      onChunk: vi.fn(),
      logger: mockLogger(),
    })
    teardowns.push(teardown)

    await vi.waitFor(() => expect(fake.pullAudioChunks).toHaveBeenCalled())
    expect(fake.subscribeAudioChunks).toHaveBeenCalledWith(
      { brokerId: '104/main', tag: 'audio-analyzer', accept: ['pcmu', 'pcma'] },
      nodePin('hub'),
    )
  })

  it('omits the field entirely when the consumer declared nothing', async () => {
    const fake = makeFakeApi()

    const teardown = startAudioChunkPoller({
      api: fake.api,
      brokerId: '104/main',
      tag: 'audio-analyzer',
      ownerNodeId: 'hub',
      onChunk: vi.fn(),
      logger: mockLogger(),
    })
    teardowns.push(teardown)

    await vi.waitFor(() => expect(fake.pullAudioChunks).toHaveBeenCalled())
    // Absent, not `accept: undefined` — the broker reads presence, and an
    // explicit undefined is a different thing to a peer that inspects keys.
    expect(fake.subscribeAudioChunks.mock.calls[0]![0]).toEqual({
      brokerId: '104/main',
      tag: 'audio-analyzer',
    })
  })

  it('re-declares on the recovery re-subscribe — a leg must not silently revert to 4x', async () => {
    const fake = makeFakeApi()
    // First poll fails: the poller tears the subscription down and opens a
    // fresh one. That path builds its subscribe input separately, so it is
    // exactly where an `accept` gets dropped and nothing looks wrong: the
    // audio keeps flowing, at four bytes per sample, forever.
    fake.pullAudioChunks
      .mockRejectedValueOnce(new Error('broker went away'))
      .mockRejectedValueOnce(new Error('broker went away'))

    const teardown = startAudioChunkPoller({
      api: fake.api,
      brokerId: '104/main',
      tag: 'audio-analyzer',
      ownerNodeId: 'hub',
      accept: ['pcmu', 'pcma'],
      onChunk: vi.fn(),
      logger: mockLogger(),
    })
    teardowns.push(teardown)

    await vi.waitFor(() => expect(fake.subscribeAudioChunks.mock.calls.length).toBeGreaterThan(1))
    for (const call of fake.subscribeAudioChunks.mock.calls) {
      expect(call[0]).toMatchObject({ accept: ['pcmu', 'pcma'] })
    }
  })
})

describe('subscribe-retry backoff escalation (disabled-camera churn, 2026-07-23)', () => {
  const teardowns: Array<() => void> = []

  afterEach(() => {
    for (const teardown of teardowns.splice(0)) teardown()
    vi.useRealTimers()
  })

  it('escalates from the 5s fast ceiling to the 60s slow loop on persistent failure', async () => {
    vi.useFakeTimers()
    const fake = makeFakeApi()
    fake.subscribeAudioChunks.mockRejectedValue(new Error('broker refused (device disabled)'))

    const teardown = startAudioChunkPoller({
      api: fake.api,
      brokerId: '614/sub',
      tag: 'audio-analyzer',
      ownerNodeId: 'hub',
      onChunk: vi.fn(),
      logger: mockLogger(),
    })
    teardowns.push(teardown)

    // Burn through the fast phase: 250ms→5s doubling + 5s retries up to the
    // escalation attempt (~1 min of virtual time covers all 15 fast attempts).
    await vi.advanceTimersByTimeAsync(70_000)
    const attemptsAfterFastPhase = fake.subscribeAudioChunks.mock.calls.length
    expect(attemptsAfterFastPhase).toBeGreaterThanOrEqual(15)

    // Slow phase: over the next 5 virtual minutes the 60s ceiling allows at
    // most ~6 further attempts; the old 5s ceiling would have made ~60.
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    const slowPhaseAttempts = fake.subscribeAudioChunks.mock.calls.length - attemptsAfterFastPhase
    expect(slowPhaseAttempts).toBeGreaterThanOrEqual(3) // still retrying — auto-recovery stays alive
    expect(slowPhaseAttempts).toBeLessThanOrEqual(8)
  })

  it('says ONCE, at a level the hub writes, that the broker is persistently absent', async () => {
    vi.useFakeTimers()
    const fake = makeFakeApi()
    fake.subscribeAudioChunks.mockRejectedValue(new Error('broker refused (device disabled)'))
    const logger = mockLogger()

    const teardown = startAudioChunkPoller({
      api: fake.api,
      brokerId: '614/sub',
      tag: 'audio-analyzer',
      ownerNodeId: 'hub',
      onChunk: vi.fn(),
      logger,
    })
    teardowns.push(teardown)

    await vi.advanceTimersByTimeAsync(70_000)

    // Everything between the first attempt and the escalation is at `debug`,
    // which the hub does not write (D438). Before D461 that left a camera
    // whose audio never attached with one WARN at t+0 and nothing after — and
    // now that the poller lives in another process, with the watchdog's tap
    // moved off the chunk, this line is the only thing between "no audio" and
    // a permanent silent gap (D427).
    const warns = logger.warn as unknown as ReturnType<typeof vi.fn>
    const persistent = warns.mock.calls.filter((c: readonly unknown[]) =>
      String(c[0]).includes('broker still absent'),
    )
    expect(persistent).toHaveLength(1)

    // Six more minutes of the slow loop must not turn it into a log flood.
    await vi.advanceTimersByTimeAsync(6 * 60_000)
    const after = warns.mock.calls.filter((c: readonly unknown[]) =>
      String(c[0]).includes('broker still absent'),
    )
    expect(after).toHaveLength(1)
  })
})
