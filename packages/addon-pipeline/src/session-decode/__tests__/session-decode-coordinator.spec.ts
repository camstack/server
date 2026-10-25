import type { IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSessionDecodeCoordinator,
  type ForkedChildLike,
} from '../session-decode-coordinator.js'
import type { VideoFrameSource } from '../video-frame-generator.js'
import type { WorkerReply, WorkerRequest } from '../worker-protocol.js'
import { testLease } from './test-lease-knobs.js'

/**
 * Fake `ForkedChildLike` — records every `WorkerRequest` sent to it and lets
 * the test script `WorkerReply` messages back on demand (`emit`). No real
 * `child_process` involved; this is what Task 4's real fork() will produce.
 */
function createFakeChild(): {
  child: ForkedChildLike
  sent: WorkerRequest[]
  emit: (reply: WorkerReply) => void
  emitExit: () => void
  kill: ReturnType<typeof vi.fn>
} {
  const sent: WorkerRequest[] = []
  const messageHandlers: Array<(m: unknown) => void> = []
  const exitHandlers: Array<() => void> = []
  const kill = vi.fn()

  const child: ForkedChildLike = {
    send: (msg: WorkerRequest) => {
      sent.push(msg)
    },
    on: (ev: 'message' | 'exit', cb: ((m: unknown) => void) | (() => void)) => {
      if (ev === 'message') messageHandlers.push(cb as (m: unknown) => void)
      else exitHandlers.push(cb as () => void)
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
    emitExit: () => {
      for (const h of exitHandlers) h()
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

const source: VideoFrameSource = { restreamUrl: 'rtsp://cam/1', deviceId: 1, codec: 'h264' }

describe('createSessionDecodeCoordinator', () => {
  let fake: ReturnType<typeof createFakeChild>
  let logger: IScopedLogger

  beforeEach(() => {
    fake = createFakeChild()
    logger = makeLogger()
  })

  it('yields one VideoFrame whose toBuffer() resolves the scripted bytes, then it.return() sends stop and kills the child', async () => {
    const coordinator = createSessionDecodeCoordinator({
      fork: () => fake.child,
      lease: testLease,
      hwaccel: () => null,
      logger,
    })

    const it2 = coordinator.generateVideoFrames(source, { fps: 10 })
    const nextPromise = it2.next()

    // Wait a microtask turn for `start` + first `pull` to be sent.
    await Promise.resolve()
    await Promise.resolve()
    expect(fake.sent.some((m) => m.kind === 'start')).toBe(true)
    expect(fake.sent.some((m) => m.kind === 'pull')).toBe(true)

    fake.emit({ kind: 'frame', frameId: 7, timestamp: 123, width: 4, height: 4, format: 'gray' })

    const result = await nextPromise
    expect(result.done).toBe(false)
    const frame = result.value
    if (!frame) throw new Error('expected a frame')
    expect(frame.timestamp).toBe(123)
    expect(frame.image.width).toBe(4)
    expect(frame.image.height).toBe(4)
    expect(frame.image.format).toBe('gray')

    const bufferPromise = frame.image.toBuffer()
    await Promise.resolve()
    await Promise.resolve()
    const toBufferReq = fake.sent.find((m) => m.kind === 'toBuffer')
    expect(toBufferReq).toBeDefined()
    if (!toBufferReq || toBufferReq.kind !== 'toBuffer')
      throw new Error('expected toBuffer request')
    expect(toBufferReq.frameId).toBe(7)

    const scriptedBytes = new Uint8Array([1, 2, 3, 4])
    fake.emit({ kind: 'buffer', frameId: 7, bytes: scriptedBytes })
    const bytes = await bufferPromise
    expect(bytes).toBe(scriptedBytes)
    // The consumer is done with the frame. A frame still OPEN at teardown is
    // drained before the kill (D652) — see `session-decode-drain.spec.ts`.
    frame.image.close()

    // Tear down via it.return() — must send `stop` and kill() the child.
    await it2.return()
    expect(fake.sent.some((m) => m.kind === 'stop')).toBe(true)
    expect(fake.kill).toHaveBeenCalled()
  })

  it('drops a late buffer reply for a stale/already-superseded frameId without crashing', async () => {
    const coordinator = createSessionDecodeCoordinator({
      fork: () => fake.child,
      lease: testLease,
      hwaccel: () => null,
      logger,
    })
    const it2 = coordinator.generateVideoFrames(source, {})
    const first = it2.next()
    await Promise.resolve()
    await Promise.resolve()
    fake.emit({ kind: 'frame', frameId: 1, timestamp: 1, width: 2, height: 2, format: 'gray' })
    await first

    // A buffer reply for an id nobody asked for (or already superseded) must
    // be dropped silently, not thrown/unhandled.
    expect(() =>
      fake.emit({ kind: 'buffer', frameId: 999, bytes: new Uint8Array(0) }),
    ).not.toThrow()

    await it2.return()
  })

  it('rejects the in-flight next() with the worker error, sends stop, and kills the child', async () => {
    const coordinator = createSessionDecodeCoordinator({
      fork: () => fake.child,
      lease: testLease,
      hwaccel: () => null,
      logger,
    })
    const it2 = coordinator.generateVideoFrames(source, {})
    const nextPromise = it2.next()
    await Promise.resolve()
    await Promise.resolve()
    expect(fake.sent.some((m) => m.kind === 'pull')).toBe(true)

    fake.emit({ kind: 'error', message: 'decode-loop crashed' })

    await expect(nextPromise).rejects.toThrow(
      'session-decode-coordinator: worker error — decode-loop crashed',
    )

    // The generator's `finally` must still run teardown on this abrupt exit path.
    expect(fake.sent.some((m) => m.kind === 'stop')).toBe(true)
    expect(fake.kill).toHaveBeenCalled()
  })

  it('a toBuffer miss (error with frameId) rejects only that frame, not the session', async () => {
    const fakeChild = createFakeChild()
    const coord = createSessionDecodeCoordinator({
      fork: () => fakeChild.child,
      lease: testLease,
      hwaccel: () => null,
      logger,
    })
    const it2 = coord.generateVideoFrames(source, { fps: 4, format: 'gray' })

    const first = it2.next() // sends start + pull
    await Promise.resolve()
    await Promise.resolve()
    fakeChild.emit({
      kind: 'frame',
      frameId: 1,
      timestamp: 10,
      width: 4,
      height: 4,
      format: 'gray',
    })
    const frame1 = (await first).value // resolves the pull
    if (!frame1) throw new Error('expected a frame')
    const bufP = frame1.image.toBuffer() // sends toBuffer(1)
    await Promise.resolve()
    await Promise.resolve()
    fakeChild.emit({ kind: 'error', message: 'stale', frameId: 1 })
    await expect(bufP).rejects.toThrow(/stale/) // only THIS frame fails

    const secondP = it2.next() // sends pull again — session alive
    await Promise.resolve()
    await Promise.resolve()
    fakeChild.emit({
      kind: 'frame',
      frameId: 2,
      timestamp: 20,
      width: 4,
      height: 4,
      format: 'gray',
    })
    const frame2 = (await secondP).value
    if (!frame2) throw new Error('expected a second frame')
    expect(frame2.timestamp).toBe(20) // session survived the miss

    await it2.return()
  })

  it('keeps an outstanding pull alive when a toBuffer error for a different in-flight frame arrives', async () => {
    const fakeChild = createFakeChild()
    const coord = createSessionDecodeCoordinator({
      fork: () => fakeChild.child,
      lease: testLease,
      hwaccel: () => null,
      logger,
    })
    const it2 = coord.generateVideoFrames(source, { fps: 4, format: 'gray' })

    const first = it2.next() // sends start + pull
    await Promise.resolve()
    await Promise.resolve()
    fakeChild.emit({
      kind: 'frame',
      frameId: 1,
      timestamp: 10,
      width: 4,
      height: 4,
      format: 'gray',
    })
    const frame1 = (await first).value
    if (!frame1) throw new Error('expected a frame')

    // Queue the frameId-1 toBuffer waiter — do NOT resolve it yet.
    const bufP = frame1.image.toBuffer()
    await Promise.resolve()
    await Promise.resolve()

    // Send a second `pull` WHILE the toBuffer(1) waiter is still outstanding
    // — this is the interleaving old/new behavior diverge on: `pendingPull`
    // is now set at the moment the frameId-bearing error arrives below.
    const secondP = it2.next()
    await Promise.resolve()
    await Promise.resolve()
    expect(fakeChild.sent.filter((m) => m.kind === 'pull')).toHaveLength(2)

    fakeChild.emit({ kind: 'error', message: 'stale', frameId: 1 })

    // Only the frameId-1 toBuffer waiter fails.
    await expect(bufP).rejects.toThrow(/stale/)

    // The outstanding pull must NOT have been rejected — the session survives.
    fakeChild.emit({
      kind: 'frame',
      frameId: 2,
      timestamp: 20,
      width: 4,
      height: 4,
      format: 'gray',
    })
    const result = await secondP
    expect(result.value?.timestamp).toBe(20)

    await it2.return()
  })

  it('an error WITHOUT frameId still ends the generator', async () => {
    const fakeChild = createFakeChild()
    const coord = createSessionDecodeCoordinator({
      fork: () => fakeChild.child,
      lease: testLease,
      hwaccel: () => null,
      logger,
    })
    const it2 = coord.generateVideoFrames(source, { fps: 4, format: 'gray' })
    const p = it2.next() // pull outstanding
    await Promise.resolve()
    await Promise.resolve()
    fakeChild.emit({ kind: 'error', message: 'decode crashed' })
    await expect(p).rejects.toThrow(/decode crashed/)
  })
})

describe('createSessionDecodeCoordinator — pull-liveness timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('ends the generator and tears the child down if it never replies to the first pull', async () => {
    const fake = createFakeChild()
    const logger = makeLogger()
    const coordinator = createSessionDecodeCoordinator({
      fork: () => fake.child,
      lease: testLease,
      hwaccel: () => null,
      logger,
    })
    const it2 = coordinator.generateVideoFrames(source, {})
    const first = it2.next()
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.sent.some((m) => m.kind === 'pull')).toBe(true)

    // Child never replies — advance past the cold-start CEILING (45s), not the
    // 20s report interval: before the first frame the 20s deadline only reports
    // and re-arms (see `DEFAULT_FIRST_FRAME_MAX_WAIT_MS`).
    await vi.advanceTimersByTimeAsync(45_000)

    const result = await first
    expect(result.done).toBe(true)
    expect(fake.sent.some((m) => m.kind === 'stop')).toBe(true)
    expect(fake.kill).toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('gave up waiting for the first decodable frame'),
      expect.anything(),
    )
  })

  it('ends the generator and tears the child down if a subsequent pull goes silent after the first frame', async () => {
    const fake = createFakeChild()
    const logger = makeLogger()
    const coordinator = createSessionDecodeCoordinator({
      fork: () => fake.child,
      lease: testLease,
      hwaccel: () => null,
      logger,
    })
    const it2 = coordinator.generateVideoFrames(source, {})
    const first = it2.next()
    await vi.advanceTimersByTimeAsync(0)
    fake.emit({ kind: 'frame', frameId: 1, timestamp: 1, width: 2, height: 2, format: 'gray' })
    const firstFrame = await first
    // Consumed and let go — an open frame would be drained first (D652).
    firstFrame.value?.image.close()

    const second = it2.next()
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.sent.filter((m) => m.kind === 'pull')).toHaveLength(2)

    // Child goes silent — advance past the default frameTimeoutMs (10s), not
    // the (longer) firstFrameTimeoutMs, since a frame has already arrived.
    await vi.advanceTimersByTimeAsync(10_000)

    const result = await second
    expect(result.done).toBe(true)
    expect(fake.sent.some((m) => m.kind === 'stop')).toBe(true)
    expect(fake.kill).toHaveBeenCalled()
  })
})

describe('createSessionDecodeCoordinator — SIGKILL fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('arms a 1s SIGKILL fallback if the child does not exit after kill(), and clears it if exit fires first', async () => {
    const fake = createFakeChild()
    const logger = makeLogger()
    const coordinator = createSessionDecodeCoordinator({
      fork: () => fake.child,
      lease: testLease,
      hwaccel: () => null,
      logger,
    })
    const it2 = coordinator.generateVideoFrames(source, {})
    const first = it2.next()
    await vi.advanceTimersByTimeAsync(0)
    fake.emit({ kind: 'frame', frameId: 1, timestamp: 1, width: 2, height: 2, format: 'gray' })
    const firstFrame = await first
    // Nothing held, so no drain: the kill path under test starts at once (D652).
    firstFrame.value?.image.close()

    const returnPromise = it2.return()
    await vi.advanceTimersByTimeAsync(0)

    // kill() was called once (plain signal) — the fake child does not
    // actually exit, so the 1s fallback should fire and call kill('SIGKILL').
    expect(fake.kill).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fake.kill).toHaveBeenCalledTimes(2)
    expect(fake.kill).toHaveBeenLastCalledWith('SIGKILL')

    await returnPromise
  })

  it('does NOT fire the SIGKILL fallback if the child exits before the 1s window', async () => {
    const fake = createFakeChild()
    const logger = makeLogger()
    const coordinator = createSessionDecodeCoordinator({
      fork: () => fake.child,
      lease: testLease,
      hwaccel: () => null,
      logger,
    })
    const it2 = coordinator.generateVideoFrames(source, {})
    const first = it2.next()
    await vi.advanceTimersByTimeAsync(0)
    fake.emit({ kind: 'frame', frameId: 1, timestamp: 1, width: 2, height: 2, format: 'gray' })
    const firstFrame = await first
    // Nothing held, so no drain: the kill path under test starts at once (D652).
    firstFrame.value?.image.close()

    const returnPromise = it2.return()
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.kill).toHaveBeenCalledTimes(1)

    // Child exits promptly (well before the 1s fallback).
    fake.emitExit()
    await vi.advanceTimersByTimeAsync(1000)
    expect(fake.kill).toHaveBeenCalledTimes(1) // fallback never fired

    await returnPromise
  })
})

/**
 * The FIRST decodable frame of a dial is not a fixed cost — it is bounded by
 * the stream's IDR interval plus every GOP the decoder has to discard. Measured
 * on device 108 (2560x1440 h264, 8.0 s IDR interval, bitstream damage): the
 * time from dial to first decoded frame over the broker's own muted restream
 * was 1.8 / 6.5 / 7.0 / 7.2 / 9.2 / 10.0 / 10.8 / 12.9 / 14.9 / 20.0 / 30.3 /
 * >40 s across 12 trials, against a healthy 587's 2.0 s ± 0.02.
 *
 * The single 20 s deadline therefore expired on ~25% of that camera's dials and
 * the recovery RE-DIALED, throwing the accumulated wait away and re-paying the
 * RTSP setup + probe from zero; two expiries inside 60 s then DETACHED the
 * camera. That loop cost 108 25.9% of its assigned decode airtime in one day.
 * So the first-frame wait is bounded by a CEILING, not by one deadline, and the
 * worker keeps the outstanding `pull` latched across the re-arm.
 */
describe('createSessionDecodeCoordinator — first-frame wait ceiling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps waiting past the first-frame deadline while under the ceiling, and yields the late frame', async () => {
    const fake = createFakeChild()
    const logger = makeLogger()
    const coordinator = createSessionDecodeCoordinator({
      fork: () => fake.child,
      lease: testLease,
      hwaccel: () => null,
      logger,
    })
    const it2 = coordinator.generateVideoFrames(source, {})
    const first = it2.next()
    await vi.advanceTimersByTimeAsync(0)

    // The 20 s deadline expires — but the ceiling (45 s) has not.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(fake.sent.some((m) => m.kind === 'stop')).toBe(false)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('still waiting for its first decodable frame'),
      expect.objectContaining({ tags: { deviceId: source.deviceId } }),
    )

    // The worker latches the outstanding pull, so a frame decoded at 30 s is
    // delivered against the SAME pull — no re-pull, no re-dial.
    expect(fake.sent.filter((m) => m.kind === 'pull')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(10_000)
    fake.emit({ kind: 'frame', frameId: 7, timestamp: 30, width: 4, height: 2, format: 'rgb' })
    const result = await first
    expect(result.done).toBe(false)
    expect(result.value?.timestamp).toBe(30)

    await it2.return()
  })

  it('gives up at the ceiling and names the camera and the reason', async () => {
    const fake = createFakeChild()
    const logger = makeLogger()
    const coordinator = createSessionDecodeCoordinator({
      fork: () => fake.child,
      lease: testLease,
      hwaccel: () => null,
      logger,
    })
    const it2 = coordinator.generateVideoFrames(source, {})
    const first = it2.next()
    await vi.advanceTimersByTimeAsync(0)

    await vi.advanceTimersByTimeAsync(45_000)

    const result = await first
    expect(result.done).toBe(true)
    expect(fake.sent.some((m) => m.kind === 'stop')).toBe(true)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('gave up waiting for the first decodable frame'),
      expect.objectContaining({
        tags: { deviceId: source.deviceId },
        meta: expect.objectContaining({ reason: 'no-first-frame', waitedMs: 45_000 }),
      }),
    )
  })

  it('a stall AFTER the first frame still ends on the steady-state deadline — the ceiling is cold-start only', async () => {
    const fake = createFakeChild()
    const logger = makeLogger()
    const coordinator = createSessionDecodeCoordinator({
      fork: () => fake.child,
      lease: testLease,
      hwaccel: () => null,
      logger,
    })
    const it2 = coordinator.generateVideoFrames(source, {})
    const first = it2.next()
    await vi.advanceTimersByTimeAsync(0)
    fake.emit({ kind: 'frame', frameId: 1, timestamp: 1, width: 2, height: 2, format: 'rgb' })
    await first

    const second = it2.next()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10_000)

    const result = await second
    expect(result.done).toBe(true)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('gave up waiting for the next frame'),
      expect.objectContaining({
        tags: { deviceId: source.deviceId },
        meta: expect.objectContaining({ reason: 'stalled-after-first-frame' }),
      }),
    )
  })
})
