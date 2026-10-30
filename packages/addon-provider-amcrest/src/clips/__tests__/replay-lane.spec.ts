/**
 * The replay lane as a QUEUE: one replay per camera, and a still that finds it
 * held waits its turn instead of being refused after two seconds and retried
 * by a tile (2026-09-25, 3836: seventeen `replay-busy` in six hours, each one a
 * tile coming back into the same chain).
 */

import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'

import { createReplayLane, type ReplayLease } from '../replay-lane.js'

const DEVICE_ID = 3836

function makeLogger(): IScopedLogger {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  } as unknown as IScopedLogger
  return logger
}

function release(lease: ReplayLease): void {
  if (lease.kind !== 'held') throw new Error(`expected a held lease, got ${lease.kind}`)
  lease.release()
}

/** Settle every pending microtask, so "still waiting" is a fact, not a race. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('the replay lane — stills wait their turn', () => {
  it('serves queued stills one at a time, in the order they asked', async () => {
    const lane = createReplayLane({ logger: makeLogger(), waitMs: 5 })
    const first = await lane.acquire(DEVICE_ID, 'still')
    const order: string[] = []
    const second = lane.acquire(DEVICE_ID, 'still').then((l) => {
      order.push('second')
      return l
    })
    const third = lane.acquire(DEVICE_ID, 'still').then((l) => {
      order.push('third')
      return l
    })
    // Far past the stream wait: a still is NOT refused for having waited.
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
    expect(order).toEqual([])

    release(first)
    const secondLease = await second
    expect(secondLease.kind).toBe('held')
    await flush()
    expect(order).toEqual(['second'])

    release(secondLease)
    expect((await third).kind).toBe('held')
    expect(order).toEqual(['second', 'third'])
  })

  it('refuses a still by name once the queue for that camera is full', async () => {
    const lane = createReplayLane({ logger: makeLogger(), waitMs: 5, maxPending: 2 })
    await lane.acquire(DEVICE_ID, 'still')
    void lane.acquire(DEVICE_ID, 'still')
    void lane.acquire(DEVICE_ID, 'still')
    const overflow = await lane.acquire(DEVICE_ID, 'still')
    expect(overflow.kind).toBe('busy')
    if (overflow.kind !== 'busy') throw new Error('unreachable')
    expect(overflow.detail).toMatch(/queue-full/)
    expect(overflow.detail).toMatch(/2/)
  })

  it('lets a caller that went away leave the queue, and never hands it the slot', async () => {
    const lane = createReplayLane({ logger: makeLogger(), waitMs: 5, maxPending: 1 })
    const first = await lane.acquire(DEVICE_ID, 'still')
    const gone = new AbortController()
    const abandoned = lane.acquire(DEVICE_ID, 'still', undefined, gone.signal)
    gone.abort()
    expect((await abandoned).kind).toBe('abandoned')

    // Its place in the queue is free again.
    const next = lane.acquire(DEVICE_ID, 'still')
    release(first)
    expect((await next).kind).toBe('held')
  })

  it('answers an ask whose caller is already gone without queueing it', async () => {
    const lane = createReplayLane({ logger: makeLogger(), waitMs: 5 })
    await lane.acquire(DEVICE_ID, 'still')
    const gone = new AbortController()
    gone.abort()
    expect((await lane.acquire(DEVICE_ID, 'still', undefined, gone.signal)).kind).toBe('abandoned')
  })

  it('puts a playback ahead of every queued still', async () => {
    const lane = createReplayLane({ logger: makeLogger(), waitMs: 200 })
    let yielded = 0
    const holder = await lane.acquire(DEVICE_ID, 'still', () => {
      yielded += 1
    })
    const queuedStill = lane.acquire(DEVICE_ID, 'still')
    const stream = lane.acquire(DEVICE_ID, 'stream')
    expect(yielded).toBe(1)
    release(holder)
    const streamLease = await stream
    expect(streamLease.kind).toBe('held')
    await flush()
    expect(lane.held(DEVICE_ID)).toBe(true)

    release(streamLease)
    expect((await queuedStill).kind).toBe('held')
  })

  it('still bounds a PLAYBACK behind a playback — that would be a hostage', async () => {
    const lane = createReplayLane({ logger: makeLogger(), waitMs: 10 })
    await lane.acquire(DEVICE_ID, 'stream')
    const second = await lane.acquire(DEVICE_ID, 'stream')
    expect(second.kind).toBe('busy')
  })

  it('a timed-out playback leaves the queue, so the next still is served', async () => {
    const lane = createReplayLane({ logger: makeLogger(), waitMs: 10 })
    const holder = await lane.acquire(DEVICE_ID, 'stream')
    expect((await lane.acquire(DEVICE_ID, 'stream')).kind).toBe('busy')
    const still = lane.acquire(DEVICE_ID, 'still')
    release(holder)
    expect((await still).kind).toBe('held')
  })
})

describe('the replay lane — review round 1', () => {
  it('a playback is never refused for a queue full of stills: it evicts and goes first', async () => {
    const lane = createReplayLane({ logger: makeLogger(), waitMs: 200, maxPending: 8 })
    let yielded = 0
    const holder = await lane.acquire(DEVICE_ID, 'still', () => {
      yielded += 1
    })
    const stills = Array.from({ length: 8 }, () => lane.acquire(DEVICE_ID, 'still'))
    const stream = lane.acquire(DEVICE_ID, 'stream')
    expect(yielded).toBe(1)
    release(holder)
    expect((await stream).kind).toBe('held')
    void stills
  })

  it('hands the slot over synchronously: an ask in the release gap cannot take it too', async () => {
    const lane = createReplayLane({ logger: makeLogger(), waitMs: 5 })
    const first = await lane.acquire(DEVICE_ID, 'still')
    const queued = lane.acquire(DEVICE_ID, 'still')
    release(first)
    // Same tick as the release: the slot already belongs to the queued ask.
    expect(lane.held(DEVICE_ID)).toBe(true)
    let jumperSettled = false
    const jumper = lane.acquire(DEVICE_ID, 'still').then((l) => {
      jumperSettled = true
      return l
    })
    const queuedLease = await queued
    expect(queuedLease.kind).toBe('held')
    await flush()
    expect(jumperSettled).toBe(false)
    release(queuedLease)
    expect((await jumper).kind).toBe('held')
  })

  it('a holder that yields SYNCHRONOUSLY hands the slot to the playback that asked', async () => {
    const lane = createReplayLane({ logger: makeLogger(), waitMs: 50 })
    let holderLease: ReplayLease | null = null
    holderLease = await lane.acquire(DEVICE_ID, 'still', () => {
      if (holderLease !== null) release(holderLease)
    })
    const queuedStill = lane.acquire(DEVICE_ID, 'still')
    const stream = await lane.acquire(DEVICE_ID, 'stream')
    expect(stream.kind).toBe('held')
    release(stream)
    expect((await queuedStill).kind).toBe('held')
  })
})
