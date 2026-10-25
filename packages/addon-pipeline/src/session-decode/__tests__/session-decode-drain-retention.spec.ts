/**
 * D656 — a drain waits only on frames a CONSUMER is still going to read.
 *
 * After D652 shipped, `drain bound expired` fired ~80 times in 40 min on every
 * node with `pendingReads=0 pendingCrops=0` and 1–20 "unsettled" frames. Those
 * were not frames anybody was going to read before the worker died: they were
 * the on-demand JPEG fallbacks the runner parks for every frame with a
 * detection (`createOnDemandJpegFallback`), each holding a registry lease — and
 * so an open image — until post-analysis asks for it 2.2–9.9 s later or the
 * budget evicts it. Every teardown then held the node's live-worker slot for
 * the whole 1.5 s bound, for nothing.
 *
 * These drive the real pump + coordinator + registry + fallback against a
 * scripted child, in the order production runs them: the runner's result
 * callback parks the fallback, THEN the runner releases its own reference.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalFrameRegistry } from '../local-frame-registry.js'
import { createOnDemandJpegFallback } from '../on-demand-jpeg-fallback.js'
import { createRetainedContentFallback } from '../retained-content-fallback.js'
import { RetainedFrameStore } from '../retained-frame-store.js'
import {
  SESSION_DECODE_DRAIN_BOUND_MS,
  SessionDecodeReadRefusedError,
  TO_BUFFER_REFUSED_KILLED,
} from '../session-decode-coordinator.js'
import type { NativeCropRequester } from '../session-decode-pump.js'
import { withRetainedReader } from '../../pipeline-runner/retained-reader-hold.js'
import type { FrameRef } from '@camstack/types'
import { VIEW, makeLogger, scriptedChild, startAdmittingPump } from './scripted-decode-child.js'

/** What the runner does with a frame that had a detection: park it, then let go. */
function inferWithDetection(registry: LocalFrameRegistry, ref: FrameRef) {
  const fallback = createOnDemandJpegFallback(registry, ref)
  registry.release(ref, 'success')
  return fallback
}

describe('a drain waits only on frames with a pending consumer (D656)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a teardown holding ONLY retained fallbacks kills at once, and logs no WARN', async () => {
    const fake = scriptedChild(3)
    const registry = new LocalFrameRegistry({ registryId: 'd656-retained', maxFrames: 24 })
    const logger = makeLogger()
    const { admitted, teardown } = startAdmittingPump(fake, registry, logger)
    await vi.advanceTimersByTimeAsync(0)
    expect(admitted).toHaveLength(3)
    // Every frame was inferred and had a detection: parked for a late crop.
    for (const ref of admitted) inferWithDetection(registry, ref)
    expect(registry.size).toBe(3)

    teardown()
    fake.deliverPendingPull()
    await vi.advanceTimersByTimeAsync(0)

    // Nobody is going to read them before the worker dies: no drain, no wait.
    expect(fake.sent.some((m) => m.kind === 'drain')).toBe(false)
    expect(fake.kill).toHaveBeenCalledExactlyOnceWith(undefined)
    fake.exit()
    await vi.advanceTimersByTimeAsync(SESSION_DECODE_DRAIN_BOUND_MS)
    expect(fake.kill).toHaveBeenCalledTimes(1)
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('drain bound expired'),
      expect.anything(),
    )
  })

  it('a frame a consumer still holds keeps the drain open, while the retained ones do not', async () => {
    const fake = scriptedChild(3)
    const registry = new LocalFrameRegistry({ registryId: 'd656-mixed', maxFrames: 24 })
    const logger = makeLogger()
    const { admitted, teardown } = startAdmittingPump(fake, registry, logger)
    await vi.advanceTimersByTimeAsync(0)
    expect(admitted).toHaveLength(3)
    const [first, second, queued] = admitted
    if (!first || !second || !queued) throw new Error('expected three frames')
    inferWithDetection(registry, first)
    inferWithDetection(registry, second)

    // The third is still in the runner's queue when the runner detaches.
    teardown()
    fake.deliverPendingPull()
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.sent.some((m) => m.kind === 'drain')).toBe(true)
    expect(fake.kill).not.toHaveBeenCalled()

    // Inference reaches it; the worker goes the moment its consumer settles —
    // the two retained fallbacks are still open and do not hold it.
    const lease = registry.acquire(queued)
    if (!lease) throw new Error('lease gone')
    const read = lease.resolve({ content: { width: 4, height: 2 }, fit: 'contain', format: 'rgb' })
    await vi.advanceTimersByTimeAsync(0)
    fake.answerToBuffer(3)
    await expect(read).resolves.toMatchObject({ kind: 'view' })
    lease.release('success')
    registry.release(queued, 'success')
    await vi.advanceTimersByTimeAsync(0)

    expect(registry.size).toBe(2)
    expect(fake.kill).toHaveBeenCalledExactlyOnceWith(undefined)
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('drain bound expired'),
      expect.anything(),
    )
  })

  it('a consumer that never settles still hits the bound — the WARN counts it apart from the retained', async () => {
    const fake = scriptedChild(3)
    const registry = new LocalFrameRegistry({ registryId: 'd656-bound', maxFrames: 24 })
    const logger = makeLogger()
    const { admitted, teardown } = startAdmittingPump(fake, registry, logger)
    await vi.advanceTimersByTimeAsync(0)
    const [first] = admitted
    if (!first) throw new Error('expected a frame')
    inferWithDetection(registry, first)

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
        meta: expect.objectContaining({
          consumerFrames: 2,
          retainedFrames: 1,
          pendingReads: 0,
          pendingCrops: 0,
        }),
      }),
    )
  })

  it('a retained fallback whose read STARTED before the kill is a reader, and is waited for', async () => {
    const fake = scriptedChild(2)
    const registry = new LocalFrameRegistry({ registryId: 'd656-hydrate', maxFrames: 24 })
    const logger = makeLogger()
    const { admitted, teardown } = startAdmittingPump(fake, registry, logger)
    await vi.advanceTimersByTimeAsync(0)
    const [first, queued] = admitted
    if (!first || !queued) throw new Error('expected two frames')
    const fallback = inferWithDetection(registry, first)

    teardown()
    fake.deliverPendingPull()
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.sent.some((m) => m.kind === 'drain')).toBe(true)

    // Post-analysis asks for the parked frame while the drain is still open.
    const hydrated = fallback.materialize()
    await vi.advanceTimersByTimeAsync(0)
    registry.release(queued, 'drop') // the queued frame is let go…
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.kill).not.toHaveBeenCalled() // …but the read already sent holds it
    fake.answerToBuffer(1)
    await hydrated
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.kill).toHaveBeenCalledExactlyOnceWith(undefined)
  })

  it('a reader that re-acquires a PARKED frame holds the drain from its acquire, before any read is sent', async () => {
    const fake = scriptedChild(2)
    const registry = new LocalFrameRegistry({ registryId: 'd656-reacquire', maxFrames: 24 })
    const logger = makeLogger()
    const { admitted, teardown } = startAdmittingPump(fake, registry, logger)
    await vi.advanceTimersByTimeAsync(0)
    const [parked, queued] = admitted
    if (!parked || !queued) throw new Error('expected two frames')
    inferWithDetection(registry, parked)

    teardown()
    fake.deliverPendingPull()
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.sent.some((m) => m.kind === 'drain')).toBe(true)

    // A reader comes back to the parked frame; it has not asked for bytes yet.
    const lease = registry.acquire(parked)
    if (!lease) throw new Error('lease gone')
    registry.release(queued, 'drop') // the only other consumer lets go
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.kill).not.toHaveBeenCalled()

    const read = lease.resolve(VIEW)
    await vi.advanceTimersByTimeAsync(0)
    fake.answerToBuffer(1)
    await expect(read).resolves.toMatchObject({ kind: 'view' })
    lease.release('success')
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.kill).toHaveBeenCalledExactlyOnceWith(undefined)
  })

  it('a RETAINED image closing does not release the drain a consumer is still holding', async () => {
    const fake = scriptedChild(2)
    const registry = new LocalFrameRegistry({ registryId: 'd656-close-split', maxFrames: 24 })
    const logger = makeLogger()
    const { admitted, teardown } = startAdmittingPump(fake, registry, logger)
    await vi.advanceTimersByTimeAsync(0)
    const [parked, queued] = admitted
    if (!parked || !queued) throw new Error('expected two frames')
    const fallback = inferWithDetection(registry, parked)

    teardown()
    fake.deliverPendingPull()
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.sent.some((m) => m.kind === 'drain')).toBe(true)

    fallback.release?.() // the store evicts the parked frame: its image closes
    await vi.advanceTimersByTimeAsync(0)
    expect(registry.size).toBe(1)
    expect(fake.kill).not.toHaveBeenCalled() // the queued frame still holds it

    registry.release(queued, 'drop')
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.kill).toHaveBeenCalledExactlyOnceWith(undefined)
  })

  it('a native-crop MISS that falls back to the retained full frame is served before the kill', async () => {
    const fake = scriptedChild(2)
    const registry = new LocalFrameRegistry({ registryId: 'd656-two-rungs', maxFrames: 24 })
    const store = new RetainedFrameStore({ nodeId: 'n', logger: makeLogger() })
    const logger = makeLogger()
    const requesters: NativeCropRequester[] = []
    const { admitted, teardown } = startAdmittingPump(fake, registry, logger, (_frame, crop) => {
      if (crop) requesters.push(crop)
    })
    await vi.advanceTimersByTimeAsync(0)
    const [parked, queued] = admitted
    const [nativeCrop] = requesters
    if (!parked || !queued || !nativeCrop) throw new Error('expected two frames')
    const handle = store.allocateHandle(101, {
      data: Buffer.alloc(0),
      width: 4,
      height: 2,
      format: 'rgb',
      timestamp: 1,
    })
    if (!handle) throw new Error('expected a handle')
    store.rememberOnDemand(101, handle, inferWithDetection(registry, parked))

    // getNativeCrop's two rungs, asked while the queued frame keeps the session
    // alive: the native crop goes out BEFORE the teardown…
    const served = withRetainedReader(store, handle, async () => {
      const attempt = await nativeCrop({ x: 0, y: 0, w: 1, h: 1 })
      expect(attempt).toEqual({ kind: 'miss' })
      return store.cropAsync(handle, { x: 0, y: 0, w: 1, h: 1 })
    })
    await vi.advanceTimersByTimeAsync(0)
    teardown()
    fake.deliverPendingPull()
    registry.release(queued, 'drop')
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.kill).not.toHaveBeenCalled()

    // …misses, and in the SAME turn the drain has nothing else to wait on.
    const req = fake.sent.find((m) => m.kind === 'nativeCrop')
    if (!req || req.kind !== 'nativeCrop') throw new Error('expected a nativeCrop request')
    fake.reply({ kind: 'nativeCropMiss', requestId: req.requestId })
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.kill).not.toHaveBeenCalled()
    expect(fake.sent.some((m) => m.kind === 'toBuffer' && m.frameId === 1)).toBe(true)
    fake.reply({ kind: 'buffer', frameId: 1, bytes: new Uint8Array([0xff, 0xd8, 1]) })
    await expect(served).resolves.not.toBeNull()
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.kill).toHaveBeenCalledExactlyOnceWith(undefined)
  })

  it('a read asked for after the kill is refused BY NAME, and the retained fallback counts it as a miss', async () => {
    const fake = scriptedChild(1)
    const registry = new LocalFrameRegistry({ registryId: 'd656-refused', maxFrames: 24 })
    // The pump's image is private to the registry; capture it to see the
    // session's own refusal, beneath the registry's miss translation.
    const registerSpy = vi.spyOn(registry, 'register')
    const logger = makeLogger()
    const { admitted, teardown } = startAdmittingPump(fake, registry, logger)
    await vi.advanceTimersByTimeAsync(0)
    const [parked] = admitted
    if (!parked) throw new Error('expected a frame')
    // Parked, as the continuous-retain store does; nothing holds the worker.
    const parkedLease = registry.acquire(parked, 'retention')
    registry.release(parked, 'success')
    teardown()
    fake.deliverPendingPull()
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.kill).toHaveBeenCalledTimes(1)

    // The session refuses the read by name (never queued for the exit)…
    const image = registerSpy.mock.calls[0]?.[0]
    if (!image) throw new Error('expected the pump to register its frame')
    const refused = image.toBuffer({ format: 'rgb' })
    await expect(refused).rejects.toBeInstanceOf(SessionDecodeReadRefusedError)
    await expect(refused).rejects.toMatchObject({ reason: TO_BUFFER_REFUSED_KILLED })

    // …and a reader going through the registry gets that refusal as a
    // `stale-ref` miss, never a worker fault (D656, local-frame-registry).
    const direct = registry.acquire(parked)
    if (!direct) throw new Error('lease gone')
    await expect(direct.resolve(VIEW)).resolves.toEqual({ kind: 'miss', reason: 'stale-ref' })
    direct.release('error')
    expect(fake.sent.filter((m) => m.kind === 'toBuffer')).toHaveLength(0)

    await expect(createRetainedContentFallback(registry, parked).materialize()).resolves.toBeNull()
    parkedLease?.release('eviction')
  })
})
