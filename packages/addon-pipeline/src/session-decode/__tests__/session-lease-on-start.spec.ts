/**
 * The native-lease knobs reach the worker on `start` — D453.
 *
 * This is the carrier the `*_SETTING` env vars used to be. It matters more than
 * a plumbing test usually does, because BOTH halves of D453 depend on it:
 *
 * - the child bundle can only stay free of `@camstack/types` (and of the
 *   ~170 ms / ~100 MB every fork paid for it) if nothing in the child resolves
 *   a knob;
 * - a worker can only be forked BEFORE its camera is known if nothing is
 *   handed to it at spawn.
 *
 * So: the knobs are read PER SESSION (a setting changed mid-life reaches the
 * next session, not the running one), and they are on the `start` message the
 * child actually receives.
 */

import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { WorkerLeaseKnobs } from '../native-lease-knobs.js'
import type { ForkedChildLike } from '../session-decode-coordinator.js'
import { createSessionDecodeCoordinator } from '../session-decode-coordinator.js'
import type { SessionHwaccelOffer } from '../session-hwaccel.js'
import type { VideoFrameSource } from '../video-frame-generator.js'
import type { WorkerRequest } from '../worker-protocol.js'
import { TEST_LEASE_KNOBS } from './test-lease-knobs.js'

function makeLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function createFakeChild(): { child: ForkedChildLike; sent: WorkerRequest[] } {
  const sent: WorkerRequest[] = []
  const child: ForkedChildLike = {
    send: (msg: WorkerRequest) => {
      sent.push(msg)
    },
    on: () => undefined,
    kill: vi.fn(),
  }
  return { child, sent }
}

const source: VideoFrameSource = { restreamUrl: 'rtsp://cam/1', deviceId: 101, codec: 'h264' }

function startMessage(sent: readonly WorkerRequest[]): Extract<WorkerRequest, { kind: 'start' }> {
  const start = sent.find((m): m is Extract<WorkerRequest, { kind: 'start' }> => m.kind === 'start')
  expect(start).toBeDefined()
  if (!start) throw new Error('no start message')
  return start
}

/** Drive one session far enough to have sent `start`, then abandon it. */
async function runOneSession(
  lease: () => WorkerLeaseKnobs,
  hwaccel: () => SessionHwaccelOffer = () => null,
): Promise<readonly WorkerRequest[]> {
  const fake = createFakeChild()
  const coordinator = createSessionDecodeCoordinator({
    fork: () => fake.child,
    lease,
    hwaccel,
    logger: makeLogger(),
  })
  const frames = coordinator.generateVideoFrames(source, { fps: 10, format: 'rgb' })
  // `next()` never settles (the fake answers no pull) and `return()` would wait
  // on it, so neither is awaited: `start` is sent synchronously ahead of the
  // first `pull`, which is exactly what this asserts about. `stop` unblocks the
  // fake's teardown path and clears the armed pull timeout.
  void frames.next()
  await Promise.resolve()
  void frames.return(undefined)
  await Promise.resolve()
  return fake.sent
}

describe('session-decode — the lease knobs travel on start', () => {
  it('puts the resolved knobs on the start message the child receives', async () => {
    const start = startMessage(await runOneSession(() => TEST_LEASE_KNOBS))
    expect(start.lease).toEqual(TEST_LEASE_KNOBS)
  })

  it('reads them PER SESSION, so an operator change reaches the next one', async () => {
    let current: WorkerLeaseKnobs = TEST_LEASE_KNOBS
    const lease = (): WorkerLeaseKnobs => current

    const first = startMessage(await runOneSession(lease))
    expect(first.lease.values.holdFrames).toBe(TEST_LEASE_KNOBS.values.holdFrames)

    current = {
      values: { ...TEST_LEASE_KNOBS.values, holdFrames: 24 },
      sources: { ...TEST_LEASE_KNOBS.sources, holdFrames: 'setting' },
    }
    const second = startMessage(await runOneSession(lease))
    expect(second.lease.values.holdFrames).toBe(24)
    expect(second.lease.sources.holdFrames).toBe('setting')
  })
})

describe('session-decode — the resolver hwaccel offer travels on start (D926)', () => {
  it('a node whose VA init failed sends an EMPTY offer, so the worker tries no vaapi/qsv', async () => {
    const start = startMessage(
      await runOneSession(
        () => TEST_LEASE_KNOBS,
        () => [],
      ),
    )
    expect(start.hwaccel).toEqual([])
  })

  it('reads the offer PER SESSION', async () => {
    let offer: SessionHwaccelOffer = ['qsv', 'vaapi']
    const first = startMessage(
      await runOneSession(
        () => TEST_LEASE_KNOBS,
        () => offer,
      ),
    )
    expect(first.hwaccel).toEqual(['qsv', 'vaapi'])
    offer = []
    const second = startMessage(
      await runOneSession(
        () => TEST_LEASE_KNOBS,
        () => offer,
      ),
    )
    expect(second.hwaccel).toEqual([])
  })
})
