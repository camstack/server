import { describe, expect, it, vi } from 'vitest'
import { LocalFrameRegistry } from '../local-frame-registry.js'
import type { FrameImage } from '../video-frame-generator.js'

function makeImage(
  width = 16,
  height = 9,
): FrameImage & {
  toBuffer: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  releaseNativeLease: ReturnType<typeof vi.fn>
} {
  return {
    width,
    height,
    format: 'rgb',
    toBuffer: vi.fn(async () => new Uint8Array(width * height * 3)),
    close: vi.fn(),
    releaseNativeLease: vi.fn(),
  }
}

describe('LocalFrameRegistry', () => {
  it('resolves independent content-sized views and releases one idempotent lease', async () => {
    const registry = new LocalFrameRegistry({
      registryId: 'test-process',
      maxFrames: 4,
      maxBytes: 10_000_000,
    })
    const image = makeImage(1920, 1080)
    const ref = registry.register(image, { timestamp: 12, capturedAt: 13 })
    expect(ref).not.toBeNull()

    const lease = registry.acquire(ref!)
    expect(lease).not.toBeNull()
    const small = await lease!.resolve({
      content: { width: 320, height: 320 },
      fit: 'contain',
      format: 'jpeg',
    })
    const large = await lease!.resolve({
      content: { width: 640, height: 640 },
      fit: 'contain',
      format: 'jpeg',
    })

    expect(small).toMatchObject({ kind: 'view', width: 320, height: 180, format: 'jpeg' })
    expect(large).toMatchObject({ kind: 'view', width: 640, height: 360, format: 'jpeg' })
    expect(image.toBuffer).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ resize: { width: 320, height: 180 }, format: 'jpeg' }),
    )
    expect(image.toBuffer).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ resize: { width: 640, height: 360 }, format: 'jpeg' }),
    )

    lease!.release('success')
    lease!.release('success')
    registry.release(ref!, 'success')
    registry.release(ref!, 'success')
    expect(image.close).toHaveBeenCalledOnce()
    expect(image.releaseNativeLease).not.toHaveBeenCalled()
  })

  it('evicts to both bounds, releases native retention, and returns a clean stale miss', async () => {
    const registry = new LocalFrameRegistry({
      registryId: 'test-process',
      maxFrames: 1,
      maxBytes: 1_000,
    })
    const first = makeImage(10, 10)
    const second = makeImage(10, 10)
    const firstRef = registry.register(first, { timestamp: 1 })
    const secondRef = registry.register(second, { timestamp: 2 })

    expect(firstRef).not.toBeNull()
    expect(secondRef).not.toBeNull()
    expect(registry.size).toBe(1)
    expect(first.close).toHaveBeenCalledOnce()
    expect(first.releaseNativeLease).toHaveBeenCalledOnce()
    expect(registry.acquire(firstRef!)).toBeNull()

    registry.release(secondRef!, 'drop')
    registry.release(secondRef!, 'drop')
    expect(second.close).toHaveBeenCalledOnce()
    expect(second.releaseNativeLease).toHaveBeenCalledOnce()
  })

  it('keeps a leased entry alive through in-flight toBuffer while evicting only owner-only frames', async () => {
    const registry = new LocalFrameRegistry({
      registryId: 'test-process',
      maxFrames: 1,
      maxBytes: 10_000_000,
    })
    let releaseToBuffer!: () => void
    const leased = makeImage(10, 10)
    leased.toBuffer.mockImplementation(
      () =>
        new Promise<Uint8Array>((resolve) => {
          releaseToBuffer = () => resolve(new Uint8Array(10 * 10 * 3))
        }),
    )
    const leasedRef = registry.register(leased, { timestamp: 1 })
    expect(leasedRef).not.toBeNull()
    const lease = registry.acquire(leasedRef!)
    expect(lease).not.toBeNull()

    const inFlight = lease!.resolve({
      content: { width: 10, height: 10 },
      fit: 'stretch',
      format: 'rgb',
    })

    const evicted = makeImage(10, 10)
    const evictedRef = registry.register(evicted, { timestamp: 2 })
    expect(evictedRef).toBeNull()
    expect(registry.size).toBe(1)
    expect(registry.estimatedBytes).toBe(10 * 10 * 3)
    expect(leased.close).not.toHaveBeenCalled()
    expect(evicted.close).toHaveBeenCalledOnce()
    expect(evicted.releaseNativeLease).toHaveBeenCalledOnce()

    releaseToBuffer()
    await expect(inFlight).resolves.toMatchObject({ kind: 'view', width: 10, height: 10 })
    expect(leased.close).not.toHaveBeenCalled()

    lease!.release('success')
    lease!.release('success')
    registry.release(leasedRef!, 'success')
    expect(leased.close).toHaveBeenCalledOnce()
  })

  it('evicts owner-only queued frames under both bounds and never aliases a new id onto a live lease', async () => {
    const registry = new LocalFrameRegistry({
      registryId: 'test-process',
      maxFrames: 2,
      maxBytes: 10 * 10 * 3 * 2,
    })
    const queued = makeImage(10, 10)
    const leased = makeImage(10, 10)
    const queuedRef = registry.register(queued, { timestamp: 1 })
    const leasedRef = registry.register(leased, { timestamp: 2 })
    const lease = registry.acquire(leasedRef!)
    expect(queuedRef).not.toBeNull()
    expect(lease).not.toBeNull()

    const incoming = makeImage(10, 10)
    const incomingRef = registry.register(incoming, { timestamp: 3 })

    expect(incomingRef).not.toBeNull()
    expect(incomingRef!.id).not.toBe(queuedRef!.id)
    expect(incomingRef!.id).not.toBe(leasedRef!.id)
    expect(registry.size).toBe(2)
    expect(registry.estimatedBytes).toBe(10 * 10 * 3 * 2)
    expect(queued.close).toHaveBeenCalledOnce()
    expect(leased.close).not.toHaveBeenCalled()
    expect(registry.acquire(queuedRef!)).toBeNull()

    const view = await lease!.resolve({
      content: { width: 10, height: 10 },
      fit: 'stretch',
      format: 'rgb',
    })
    expect(view).toMatchObject({ kind: 'view', width: 10, height: 10 })
    expect(leased.toBuffer).toHaveBeenCalledOnce()
  })

  it('rejects an over-budget frame without retaining pixels', () => {
    const registry = new LocalFrameRegistry({
      registryId: 'test-process',
      maxFrames: 1,
      maxBytes: 100,
    })
    const image = makeImage(100, 100)

    expect(registry.register(image, { timestamp: 1 })).toBeNull()
    expect(registry.size).toBe(0)
    expect(image.close).toHaveBeenCalledOnce()
    expect(image.releaseNativeLease).toHaveBeenCalledOnce()
  })

  it('tells the image when its last CONSUMER lets go of a frame a retention lease keeps (D656)', () => {
    const registry = new LocalFrameRegistry({ registryId: 'holders', maxFrames: 4 })
    const setPendingConsumer = vi.fn()
    const image = { ...makeImage(), setPendingConsumer }
    const ref = registry.register(image, { timestamp: 1 })
    if (!ref) throw new Error('expected a ref')

    const reader = registry.acquire(ref)
    const parked = registry.acquire(ref, 'retention')
    if (!reader || !parked) throw new Error('expected leases')
    registry.release(ref, 'success') // the owner (runner) is done
    expect(setPendingConsumer).not.toHaveBeenCalled() // a reader still holds it
    reader.release('success')
    expect(setPendingConsumer).toHaveBeenLastCalledWith(false)

    // A reader coming back to the parked frame is a consumer again.
    const late = registry.acquire(ref)
    if (!late) throw new Error('expected a lease')
    expect(setPendingConsumer).toHaveBeenLastCalledWith(true)
    late.release('success')
    expect(setPendingConsumer).toHaveBeenLastCalledWith(false)
    expect(setPendingConsumer).toHaveBeenCalledTimes(3)

    // The parked lease ends: the image is closed, with no further signal.
    parked.release('eviction')
    expect(image.close).toHaveBeenCalledOnce()
    expect(setPendingConsumer).toHaveBeenCalledTimes(3)
  })
})

describe('session-decode refusal is a miss, not a throw (D656)', () => {
  it('toBuffer refused after worker exit resolves as stale-ref miss', async () => {
    const { SessionDecodeReadRefusedError, TO_BUFFER_REFUSED_EXITED } = await import(
      '../session-decode-coordinator.js'
    )
    const registry = new LocalFrameRegistry({
      registryId: 'refusal-process',
      maxFrames: 2,
      maxBytes: 10_000_000,
    })
    const image = makeImage(64, 36)
    image.toBuffer = vi.fn(async () => {
      throw new SessionDecodeReadRefusedError(TO_BUFFER_REFUSED_EXITED, 3)
    })
    const ref = registry.register(image, { timestamp: 1 })!
    const lease = registry.acquire(ref)!
    const result = await lease.resolve({
      content: { width: 64, height: 36 },
      fit: 'contain',
      format: 'rgb',
    })
    expect(result).toEqual({ kind: 'miss', reason: 'stale-ref' })
    lease.release('drop')
  })
})
