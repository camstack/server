import { describe, it, expect, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import { startSessionDecodePump } from '../session-decode-pump.js'
import type { ForkedChildLike } from '../session-decode-coordinator.js'
import type { WorkerReply, WorkerRequest } from '../worker-protocol.js'
import type { VideoFrameSource } from '../video-frame-generator.js'
import { Semaphore } from '../../pipeline-runner/semaphore.js'
import { testLease } from './test-lease-knobs.js'

/**
 * P5 spawn-concurrency gate — pump-level lifecycle tests.
 *
 * These drive the REAL pump + REAL coordinator over a scripted fake child, but
 * back the `acquireSpawnSlot` dep with the REAL {@link Semaphore} the addon
 * owns, so they exercise the exact permit acquire/release contract:
 * - the fork is gated (never happens before a permit is granted),
 * - the (N+1)th fork QUEUES until an in-flight worker frees its permit,
 * - the permit is released on teardown EVEN IF no frame ever arrived,
 * - a detach WHILE QUEUED releases the (later-granted) permit and never forks.
 */

interface FakeChild {
  child: ForkedChildLike
  sent: WorkerRequest[]
  emit: (reply: WorkerReply) => void
  kill: ReturnType<typeof vi.fn>
}

function createFakeChild(): FakeChild {
  const sent: WorkerRequest[] = []
  const messageHandlers: Array<(m: unknown) => void> = []
  const kill = vi.fn()
  const child: ForkedChildLike = {
    send: (msg: WorkerRequest) => {
      sent.push(msg)
    },
    on: (ev: 'message' | 'exit', cb: (m: unknown) => void) => {
      if (ev === 'message') messageHandlers.push(cb)
    },
    kill,
  }
  return {
    child,
    sent,
    kill,
    emit: (reply: WorkerReply) => {
      for (const h of messageHandlers) h(reply)
    },
  }
}

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

const source: VideoFrameSource = { restreamUrl: 'rtsp://cam/1', deviceId: 42, codec: 'h264' }

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('session-decode spawn gate (pump lifecycle)', () => {
  it('does NOT fork the decode worker until the spawn permit is granted', async () => {
    const fake = createFakeChild()
    const fork = vi.fn(() => fake.child)
    let grant: (() => void) | undefined
    const acquireSpawnSlot = (): Promise<() => void> =>
      new Promise<() => void>((resolve) => {
        grant = () => {
          resolve(() => {})
        }
      })

    startSessionDecodePump({
      fork,
      lease: testLease,
      hwaccel: () => null,
      logger: makeLogger(),
      source,
      opts: { fps: 10, format: 'rgb' },
      acquireSpawnSlot,
      onDecodedFrame: () => {},
    })

    // Permit still pending → the coordinator's generator never advances to its
    // first pull, so the fork has NOT happened.
    await flush()
    expect(fork).not.toHaveBeenCalled()

    // Grant the permit → the pump enters the loop, which forks the worker.
    if (grant !== undefined) grant()
    await flush()
    expect(fork).toHaveBeenCalledTimes(1)
  })

  it('QUEUES the (N+1)th fork until an in-flight worker delivers its first frame', async () => {
    const gate = new Semaphore(1)
    const acquireSpawnSlot = (): Promise<() => void> => gate.acquire()

    const fake1 = createFakeChild()
    const fork1 = vi.fn(() => fake1.child)
    startSessionDecodePump({
      fork: fork1,
      lease: testLease,
      hwaccel: () => null,
      logger: makeLogger(),
      source,
      opts: { fps: 10, format: 'rgb' },
      acquireSpawnSlot,
      onDecodedFrame: () => {},
    })

    await flush()
    expect(fork1).toHaveBeenCalledTimes(1)
    expect(gate.available).toBe(0)

    // Second camera in the same burst — gate saturated, so its fork QUEUES.
    const fake2 = createFakeChild()
    const fork2 = vi.fn(() => fake2.child)
    startSessionDecodePump({
      fork: fork2,
      lease: testLease,
      hwaccel: () => null,
      logger: makeLogger(),
      source: { ...source, deviceId: 43 },
      opts: { fps: 10, format: 'rgb' },
      acquireSpawnSlot,
      onDecodedFrame: () => {},
    })

    await flush()
    expect(fork2).not.toHaveBeenCalled() // still waiting on a permit

    // Worker 1 produces its first frame → GPU context live → permit freed.
    fake1.emit({ kind: 'frame', frameId: 1, timestamp: 1, width: 4, height: 4, format: 'rgb' })
    await flush()

    // Now the queued fork proceeds.
    expect(fork2).toHaveBeenCalledTimes(1)
  })

  it('releases the permit on teardown EVEN IF no frame ever arrived', async () => {
    const gate = new Semaphore(1)
    const acquireSpawnSlot = (): Promise<() => void> => gate.acquire()

    const fake1 = createFakeChild()
    const stop1 = startSessionDecodePump({
      fork: () => fake1.child,
      lease: testLease,
      hwaccel: () => null,
      logger: makeLogger(),
      source,
      opts: { fps: 10, format: 'rgb' },
      acquireSpawnSlot,
      onDecodedFrame: () => {},
    })

    await flush()
    expect(gate.available).toBe(0)

    const fake2 = createFakeChild()
    const fork2 = vi.fn(() => fake2.child)
    startSessionDecodePump({
      fork: fork2,
      lease: testLease,
      hwaccel: () => null,
      logger: makeLogger(),
      source: { ...source, deviceId: 43 },
      opts: { fps: 10, format: 'rgb' },
      acquireSpawnSlot,
      onDecodedFrame: () => {},
    })

    await flush()
    expect(fork2).not.toHaveBeenCalled()

    // Teardown worker 1 WITHOUT it ever delivering a frame — the permit must
    // still be released (via the pump's `finally` / teardown path).
    stop1()
    await flush()
    fake1.emit({ kind: 'ended' })
    await flush()

    expect(fork2).toHaveBeenCalledTimes(1)
    // No permit leak: after fork2 delivers/tears down, the count returns.
    fake2.emit({ kind: 'frame', frameId: 1, timestamp: 1, width: 4, height: 4, format: 'rgb' })
    await flush()
    expect(gate.available).toBe(1)
  })

  it('a detach WHILE QUEUED releases the later-granted permit and never forks', async () => {
    const gate = new Semaphore(1)
    const acquireSpawnSlot = (): Promise<() => void> => gate.acquire()

    const fake1 = createFakeChild()
    const stop1 = startSessionDecodePump({
      fork: () => fake1.child,
      lease: testLease,
      hwaccel: () => null,
      logger: makeLogger(),
      source,
      opts: { fps: 10, format: 'rgb' },
      acquireSpawnSlot,
      onDecodedFrame: () => {},
    })
    await flush()
    expect(gate.available).toBe(0)

    const fake2 = createFakeChild()
    const fork2 = vi.fn(() => fake2.child)
    const stop2 = startSessionDecodePump({
      fork: fork2,
      lease: testLease,
      hwaccel: () => null,
      logger: makeLogger(),
      source: { ...source, deviceId: 43 },
      opts: { fps: 10, format: 'rgb' },
      acquireSpawnSlot,
      onDecodedFrame: () => {},
    })
    await flush()

    // Detach camera 2 while its fork is still queued (no permit yet).
    stop2()
    // Free camera 1's permit → camera 2's acquire resolves, but it is already
    // stopped → it must release the permit and NOT fork.
    stop1()
    await flush()
    fake1.emit({ kind: 'ended' })
    await flush()

    expect(fork2).not.toHaveBeenCalled()
    expect(gate.available).toBe(1) // permit returned — no leak
  })
})
