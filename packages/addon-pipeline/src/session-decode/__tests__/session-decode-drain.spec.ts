/**
 * D652 — a planned teardown DRAINS before it kills.
 *
 * A lazy `frameRef` is a zero-copy reference into the decode worker: its
 * pixels exist only while that worker process does. The runner used to kill
 * its own worker in the same turn it detached, so every frame still queued or
 * in flight at that moment failed as `worker exited before toBuffer reply` /
 * `worker already exited` — 4 h of live logs had ZERO unexpected worker exits
 * and every one of those failures came from a `stopRequested` teardown.
 *
 * These tests drive the real pump + coordinator + registry against a fake
 * child, so the chain under test is exactly the production one:
 * teardown → iterator.return() → coordinator finally → drain → kill.
 */
import type { IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalFrameRegistry } from '../local-frame-registry.js'
import {
  NATIVE_CROP_REFUSED_DRAINING,
  SESSION_DECODE_DRAIN_BOUND_MS,
  createSessionDecodeCoordinator,
} from '../session-decode-coordinator.js'
import { startSessionDecodePump } from '../session-decode-pump.js'
import {
  VIEW,
  makeLogger,
  scriptedChild,
  source,
  startAdmittingPump,
} from './scripted-decode-child.js'
import { testLease } from './test-lease-knobs.js'

describe('session-decode teardown drains before it kills (D652)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('3 admitted lazy frames all materialise after teardown; the kill waits for them', async () => {
    const fake = scriptedChild(3)
    const registry = new LocalFrameRegistry({ registryId: 'drain', maxFrames: 24 })
    const logger = makeLogger()
    const { admitted, teardown } = startAdmittingPump(fake, registry, logger)
    await vi.advanceTimersByTimeAsync(0)
    expect(admitted).toHaveLength(3)

    // The runner detaches while all three are still queued.
    teardown()
    fake.deliverPendingPull()
    await vi.advanceTimersByTimeAsync(0)

    // The worker was told to stop DECODING, not to die.
    expect(fake.sent.some((m) => m.kind === 'drain')).toBe(true)
    expect(fake.sent.some((m) => m.kind === 'stop')).toBe(false)
    expect(fake.kill).not.toHaveBeenCalled()

    // Inference now reaches each queued frame, the way the executor does.
    const reads = admitted.map(async (ref) => {
      const lease = registry.acquire(ref)
      if (!lease) throw new Error('lease gone')
      const view = await lease.resolve(VIEW)
      lease.release('success')
      registry.release(ref, 'success')
      return view
    })
    await vi.advanceTimersByTimeAsync(0)
    for (const frameId of [1, 2, 3]) fake.answerToBuffer(frameId)
    const views = await Promise.all(reads)
    expect(views.map((v) => v.kind)).toEqual(['view', 'view', 'view'])

    // Only once the last admitted frame let go does the worker go.
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.sent.some((m) => m.kind === 'stop')).toBe(true)
    expect(fake.kill).toHaveBeenCalledTimes(1)
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('drain bound'),
      expect.anything(),
    )
  })

  it('a frame still held when the bound expires is LOGGED with its count and deviceId, then killed', async () => {
    const fake = scriptedChild(2)
    const registry = new LocalFrameRegistry({ registryId: 'drain-bound', maxFrames: 24 })
    const logger = makeLogger()
    const { admitted, teardown } = startAdmittingPump(fake, registry, logger)
    await vi.advanceTimersByTimeAsync(0)
    expect(admitted).toHaveLength(2)

    teardown()
    fake.deliverPendingPull()
    await vi.advanceTimersByTimeAsync(SESSION_DECODE_DRAIN_BOUND_MS - 1)
    expect(fake.kill).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(fake.kill).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('drain bound expired'),
      expect.objectContaining({
        tags: { deviceId: 101 },
        meta: expect.objectContaining({ consumerFrames: 2, pendingReads: 0 }),
      }),
    )
  })

  it("an 'immediate' teardown keeps the kill-now path", async () => {
    const fake = scriptedChild(2)
    const registry = new LocalFrameRegistry({ registryId: 'drain-now', maxFrames: 24 })
    const logger = makeLogger()
    const { admitted, teardown } = startAdmittingPump(fake, registry, logger)
    await vi.advanceTimersByTimeAsync(0)
    expect(admitted).toHaveLength(2)

    teardown('immediate')
    fake.deliverPendingPull()
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.sent.some((m) => m.kind === 'drain')).toBe(false)
    // SIGKILL, not SIGTERM: since the child gained a SIGTERM handler (D652) a
    // worker blocked in a native call (a VAAPI hang) never runs it, and the
    // only thing that ended it was a fallback timer the exiting parent does
    // not wait for. On shutdown that worker was orphaned with its GPU pool.
    expect(fake.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
  })

  it("a second teardown saying 'immediate' DURING a drain escalates to SIGKILL and disarms the bound", async () => {
    const fake = scriptedChild(2)
    const registry = new LocalFrameRegistry({ registryId: 'drain-escalate', maxFrames: 24 })
    const logger = makeLogger()
    const { admitted, teardown } = startAdmittingPump(fake, registry, logger)
    await vi.advanceTimersByTimeAsync(0)
    expect(admitted).toHaveLength(2)

    teardown('drain')
    fake.deliverPendingPull()
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.sent.some((m) => m.kind === 'drain')).toBe(true)
    expect(fake.kill).not.toHaveBeenCalled() // frames still held: draining

    // Addon shutdown lands while the drain is in progress. The runner exits
    // right after; a drain it does not wait for is an orphaned worker.
    teardown('immediate')
    expect(fake.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    await vi.advanceTimersByTimeAsync(SESSION_DECODE_DRAIN_BOUND_MS + 10)
    expect(fake.kill).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalledWith(
      expect.stringContaining('drain bound expired'),
      expect.anything(),
    )
  })

  it('a session holding nothing is killed at once — the drain costs an idle teardown nothing', async () => {
    const fake = scriptedChild(1)
    const logger = makeLogger()
    const coordinator = createSessionDecodeCoordinator({
      fork: () => fake.child,
      lease: testLease,
      hwaccel: () => null,
      logger,
    })
    const it2 = coordinator.generateVideoFrames(source, { fps: 10 })
    const first = await it2.next()
    if (first.done) throw new Error('expected a frame')
    first.value.image.close()
    await it2.return()
    expect(fake.sent.some((m) => m.kind === 'drain')).toBe(false)
    // The drain path's kill is SIGTERM: the child flushes its last lines first.
    expect(fake.kill).toHaveBeenCalledExactlyOnceWith(undefined)
  })

  it('a worker that dies mid-drain settles the drain instead of arming a kill for a dead child', async () => {
    const fake = scriptedChild(1)
    const registry = new LocalFrameRegistry({ registryId: 'drain-death', maxFrames: 24 })
    const logger = makeLogger()
    const { admitted, teardown } = startAdmittingPump(fake, registry, logger)
    await vi.advanceTimersByTimeAsync(0)
    expect(admitted).toHaveLength(1)
    teardown()
    fake.deliverPendingPull()
    await vi.advanceTimersByTimeAsync(0)
    fake.exit()
    await vi.advanceTimersByTimeAsync(SESSION_DECODE_DRAIN_BOUND_MS)
    expect(fake.kill).not.toHaveBeenCalled()
    // …and the frames the drain was waiting for, which died with it, are named.
    expect(logger.warn).toHaveBeenCalledWith(
      'session-decode worker exited unexpectedly while draining',
      expect.objectContaining({
        tags: { deviceId: 101 },
        meta: expect.objectContaining({ consumerFrames: 1 }),
      }),
    )
  })
})

describe('session-decode drain — the remaining gates (D652 fix round 1)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Pull one frame through a bare coordinator. */
  async function oneFrame(fake: ReturnType<typeof scriptedChild>, logger: IScopedLogger) {
    const exits: number[] = []
    const coordinator = createSessionDecodeCoordinator({
      fork: () => fake.child,
      lease: testLease,
      hwaccel: () => null,
      logger,
      onWorkerExit: () => exits.push(1),
    })
    const it2 = coordinator.generateVideoFrames(source, { fps: 10 })
    const first = await it2.next()
    if (first.done) throw new Error('expected a frame')
    return { it2, image: first.value.image, exits }
  }

  it('a READ still waiting on the worker keeps the drain open on its own', async () => {
    const fake = scriptedChild(1)
    const { it2, image } = await oneFrame(fake, makeLogger())
    const read = image.toBuffer()
    // The consumer let go of the image, but its read is still in flight.
    image.close()
    const returned = it2.return()
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.sent.some((m) => m.kind === 'drain')).toBe(true)
    expect(fake.kill).not.toHaveBeenCalled()

    fake.answerToBuffer(1)
    await expect(read).resolves.toEqual(new Uint8Array([1]))
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.kill).toHaveBeenCalledTimes(1)
    await returned
  })

  it('a native crop already REQUESTED keeps the drain open until it is answered (M1)', async () => {
    const fake = scriptedChild(1)
    const { it2, image } = await oneFrame(fake, makeLogger())
    const crop = image.nativeCrop?.({ x: 0, y: 0, w: 1, h: 1 })
    image.close()
    const returned = it2.return()
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.kill).not.toHaveBeenCalled()

    const req = fake.sent.find((m) => m.kind === 'nativeCrop')
    if (!req || req.kind !== 'nativeCrop') throw new Error('expected a nativeCrop request')
    fake.reply({ kind: 'nativeCropMiss', requestId: req.requestId })
    await expect(crop).resolves.toEqual({ kind: 'miss' })
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.kill).toHaveBeenCalledTimes(1)
    await returned
  })

  it('a worker that reported a FATAL error is killed at once, never drained (M6)', async () => {
    const fake = scriptedChild(1)
    const { it2, image } = await oneFrame(fake, makeLogger())
    // The frame is still open — an ordinary teardown would drain for it.
    expect(image.width).toBe(4)
    const next = it2.next()
    await vi.advanceTimersByTimeAsync(0)
    fake.reply({ kind: 'error', message: 'decode loop crashed' })
    await expect(next).rejects.toThrow('decode loop crashed')
    expect(fake.sent.some((m) => m.kind === 'drain')).toBe(false)
    expect(fake.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
  })

  it('onWorkerExit fires once, on the real exit — never on the teardown request (I1)', async () => {
    const fake = scriptedChild(1)
    const { it2, image, exits } = await oneFrame(fake, makeLogger())
    image.close()
    await it2.return()
    expect(fake.kill).toHaveBeenCalledTimes(1)
    expect(exits).toEqual([])
    fake.exit()
    fake.exit()
    expect(exits).toEqual([1])
  })

  it('the pump reports its worker gone at exit, or at its own end when it never forked', async () => {
    const fake = scriptedChild(1)
    const onWorkerGone = vi.fn()
    const registry = new LocalFrameRegistry({ registryId: 'gone', maxFrames: 24 })
    const teardown = startSessionDecodePump({
      fork: () => fake.child,
      lease: testLease,
      hwaccel: () => null,
      logger: makeLogger(),
      source,
      opts: { fps: 10, format: 'rgb' },
      frameRegistry: registry,
      onFrameRef: () => false,
      onDecodedFrame: () => undefined,
      onWorkerGone,
    })
    await vi.advanceTimersByTimeAsync(0)
    teardown()
    fake.deliverPendingPull()
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.kill).toHaveBeenCalled()
    expect(onWorkerGone).not.toHaveBeenCalled()
    fake.exit()
    expect(onWorkerGone).toHaveBeenCalledTimes(1)

    // Torn down while still queued for a spawn permit: nothing was forked.
    const never = vi.fn()
    let grant!: (release: () => void) => void
    const stop = startSessionDecodePump({
      fork: () => fake.child,
      lease: testLease,
      hwaccel: () => null,
      logger: makeLogger(),
      source,
      opts: { fps: 10, format: 'rgb' },
      onDecodedFrame: () => undefined,
      acquireSpawnSlot: () => new Promise((resolve) => (grant = resolve)),
      onWorkerGone: never,
    })
    stop()
    grant(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(never).toHaveBeenCalledTimes(1)
  })

  it('a crop requested AFTER the teardown is refused with a name, never sent (M-B)', async () => {
    const fake = scriptedChild(1)
    const { it2, image } = await oneFrame(fake, makeLogger())
    const read = image.toBuffer() // keeps the drain open
    const returned = it2.return()
    await vi.advanceTimersByTimeAsync(0)
    const late = await image.nativeCrop?.({ x: 0, y: 0, w: 1, h: 1 })
    expect(late).toEqual({ kind: 'miss', workerReason: NATIVE_CROP_REFUSED_DRAINING })
    expect(fake.sent.some((m) => m.kind === 'nativeCrop')).toBe(false)
    fake.answerToBuffer(1)
    await read
    image.close()
    await vi.advanceTimersByTimeAsync(0)
    await returned
  })
})
