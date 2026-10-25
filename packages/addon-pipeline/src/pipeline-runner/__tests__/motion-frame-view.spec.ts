import { describe, expect, it, vi } from 'vitest'
import { LocalFrameRegistry } from '../../session-decode/local-frame-registry.js'
import type { FrameImage } from '../../session-decode/video-frame-generator.js'
import { MOTION_FRAME_VIEW, resolveMotionFrameView } from '../motion-frame-view.js'

function image(
  width = 1920,
  height = 1080,
): FrameImage & {
  toBuffer: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  releaseNativeLease: ReturnType<typeof vi.fn>
} {
  return {
    width,
    height,
    format: 'rgb',
    toBuffer: vi.fn(async () => new Uint8Array(width * height)),
    close: vi.fn(),
    releaseNativeLease: vi.fn(),
  }
}

describe('resolveMotionFrameView', () => {
  it('requests the gray contain view through a lease and releases even on drop', async () => {
    const registry = new LocalFrameRegistry({
      registryId: 'motion-process',
      maxFrames: 1,
      maxBytes: 10_000_000,
    })
    const frame = image()
    const ref = registry.register(frame, { timestamp: 9 })!
    const view = await resolveMotionFrameView(registry, ref)

    expect(MOTION_FRAME_VIEW).toEqual({
      content: { width: 320, height: 320 },
      fit: 'contain',
      format: 'gray',
    })
    expect(view).toMatchObject({ kind: 'view', width: 320, height: 180, format: 'gray' })
    expect(frame.toBuffer).toHaveBeenCalledOnce()
    registry.release(ref, 'success')
    expect(frame.close).toHaveBeenCalledOnce()
  })

  it('holds the lease for a deferred resolve so a saturated register cannot close the image', async () => {
    const registry = new LocalFrameRegistry({
      registryId: 'motion-process',
      maxFrames: 1,
      maxBytes: 10_000_000,
    })
    let releaseToBuffer!: () => void
    const held = image(64, 36)
    held.toBuffer.mockImplementation(
      () =>
        new Promise<Uint8Array>((resolve) => {
          releaseToBuffer = () => resolve(new Uint8Array(32 * 18))
        }),
    )
    const ref = registry.register(held, { timestamp: 1 })!
    const inFlight = resolveMotionFrameView(registry, ref)

    const incoming = image(64, 36)
    expect(registry.register(incoming, { timestamp: 2 })).toBeNull()
    expect(held.close).not.toHaveBeenCalled()
    expect(incoming.close).toHaveBeenCalledOnce()

    releaseToBuffer()
    await expect(inFlight).resolves.toMatchObject({ kind: 'view', width: 320, height: 180 })
    expect(held.close).not.toHaveBeenCalled()

    held.toBuffer.mockImplementation(async () => new Uint8Array(32 * 18))
    await resolveMotionFrameView(registry, ref)
    registry.release(ref, 'drop')
    registry.release(ref, 'drop')
    expect(held.close).toHaveBeenCalledOnce()
  })

  it('returns an explicit miss for stale and foreign refs without aliasing', async () => {
    const registry = new LocalFrameRegistry({
      registryId: 'motion-process',
      maxFrames: 1,
      maxBytes: 10_000_000,
    })
    const other = new LocalFrameRegistry({
      registryId: 'other-process',
      maxFrames: 1,
      maxBytes: 10_000_000,
    })
    const ref = registry.register(image(), { timestamp: 1 })!
    registry.release(ref, 'success')

    expect(await resolveMotionFrameView(registry, ref)).toEqual({
      kind: 'miss',
      reason: 'stale-ref',
    })
    expect(await resolveMotionFrameView(other, ref)).toEqual({
      kind: 'miss',
      reason: 'foreign-registry',
    })
  })
})
