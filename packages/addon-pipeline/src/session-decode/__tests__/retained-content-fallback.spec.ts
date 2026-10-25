import { describe, expect, it, vi } from 'vitest'
import type { FrameRef } from '@camstack/types'
import { LocalFrameRegistry } from '../local-frame-registry.js'
import type { FrameImage } from '../video-frame-generator.js'
import {
  RETAINED_FALLBACK_VIEW,
  createRetainedContentFallback,
} from '../retained-content-fallback.js'

function image(): FrameImage & { toBuffer: ReturnType<typeof vi.fn> } {
  return {
    width: 1920,
    height: 1080,
    format: 'rgb',
    toBuffer: vi.fn(async () => new Uint8Array(640 * 360 * 3)),
    close: vi.fn(),
  }
}

describe('retained content fallback', () => {
  it('requests a content-sized RGB view and never invents a foreign ref', async () => {
    const registry = new LocalFrameRegistry({
      registryId: 'fallback-process',
      maxFrames: 2,
      maxBytes: 10_000_000,
    })
    const ref = registry.register(image(), { timestamp: 4, capturedAt: 5 })!
    const fallback = createRetainedContentFallback(registry, ref)
    const view = await fallback.materialize()

    expect(RETAINED_FALLBACK_VIEW).toEqual({
      content: { width: 640, height: 640 },
      fit: 'contain',
      format: 'rgb',
    })
    expect(view).toMatchObject({
      width: 640,
      height: 360,
      format: 'rgb',
      timestamp: 4,
      capturedAt: 5,
    })
    expect(view?.data.byteLength).toBe(640 * 360 * 3)
  })

  it('misses cleanly after the local ref is released', async () => {
    const registry = new LocalFrameRegistry({
      registryId: 'fallback-process',
      maxFrames: 2,
      maxBytes: 10_000_000,
    })
    const ref = registry.register(image(), { timestamp: 4 })!
    const stale: FrameRef = { ...ref }
    registry.release(ref, 'success')

    const fallback = createRetainedContentFallback(registry, stale)
    expect(await fallback.materialize()).toBeNull()
  })

  it('returns null for a foreign registry without inventing pixels', async () => {
    const local = new LocalFrameRegistry({
      registryId: 'fallback-process',
      maxFrames: 1,
      maxBytes: 10_000_000,
    })
    const foreign = new LocalFrameRegistry({
      registryId: 'other-process',
      maxFrames: 1,
      maxBytes: 10_000_000,
    })
    const ref = foreign.register(image(), { timestamp: 4 })!
    const fallback = createRetainedContentFallback(local, ref)
    expect(await fallback.materialize()).toBeNull()
  })

  it('holds a lease only for the in-flight toBuffer and survives a saturated register', async () => {
    const registry = new LocalFrameRegistry({
      registryId: 'fallback-process',
      maxFrames: 1,
      maxBytes: 10_000_000,
    })
    let releaseToBuffer!: () => void
    const held = image()
    held.toBuffer.mockImplementation(
      () =>
        new Promise<Uint8Array>((resolve) => {
          releaseToBuffer = () => resolve(new Uint8Array(640 * 360 * 3))
        }),
    )
    const ref = registry.register(held, { timestamp: 4 })!
    const fallback = createRetainedContentFallback(registry, ref)
    const inFlight = fallback.materialize()

    const incoming = image()
    expect(registry.register(incoming, { timestamp: 5 })).toBeNull()
    expect(held.close).not.toHaveBeenCalled()
    expect(incoming.close).toHaveBeenCalledOnce()

    releaseToBuffer()
    const view = await inFlight
    expect(view?.width).toBe(640)
    expect(view?.height).toBe(360)
    expect(held.close).not.toHaveBeenCalled()

    held.toBuffer.mockImplementation(async () => new Uint8Array(640 * 360 * 3))
    const after = createRetainedContentFallback(registry, ref)
    await after.materialize()
    registry.release(ref, 'success')
    registry.release(ref, 'success')
    expect(held.close).toHaveBeenCalledOnce()
  })
})
