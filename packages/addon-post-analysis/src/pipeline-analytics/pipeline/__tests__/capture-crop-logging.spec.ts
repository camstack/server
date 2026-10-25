import { describe, it, expect, vi } from 'vitest'
import type { FrameHandle, IScopedLogger } from '@camstack/types'
import { createCaptureCrop } from '../capture-crop.js'

/**
 * A crop miss has to say WHICH CAMERA missed.
 *
 * This line logged `meta: { nodeId }` and nothing else. The repo's rule is that
 * every log line about a device carries `tags: { deviceId }` with the numeric
 * id, and the cost of missing it here was concrete: while diagnosing camera
 * 636's phantom tracks — a brick wall persisted as a `vehicle` because the
 * confirmation gate could not fetch a crop — "how often does this miss on 636
 * versus 101?" was unanswerable from the logs.
 */
function makeLogger(): { logger: IScopedLogger; debug: ReturnType<typeof vi.fn> } {
  const debug = vi.fn()
  const logger = {
    debug,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as IScopedLogger
  return { logger, debug }
}

const HANDLE = { nodeId: 'hub', width: 640, height: 360 } as unknown as FrameHandle

describe('capture-crop miss logging', () => {
  it('tags the camera on a native miss', async () => {
    const { logger, debug } = makeLogger()
    const capture = createCaptureCrop({
      tryNativeCrop: async () => null,
      bumpCropMetric: () => {},
      logger,
    })
    const out = await capture(HANDLE, { x: 0, y: 0, w: 10, h: 10 }, 640, 360, 0.1, 320, 636)
    expect(out).toBeNull()
    expect(debug).toHaveBeenCalledTimes(1)
    expect(debug.mock.calls[0]?.[1]?.tags).toEqual({ deviceId: 636 })
  })

  it('omits the tag rather than inventing one when the caller has no device', async () => {
    // `tags: { deviceId: undefined }` would be worse than no tag: it reads as a
    // device-scoped line whose device is unknown.
    const { logger, debug } = makeLogger()
    const capture = createCaptureCrop({
      tryNativeCrop: async () => null,
      bumpCropMetric: () => {},
      logger,
    })
    await capture(HANDLE, { x: 0, y: 0, w: 10, h: 10 }, 640, 360, 0.1)
    expect(debug.mock.calls[0]?.[1]?.tags).toBeUndefined()
  })

  it('says nothing on a hit', async () => {
    const { logger, debug } = makeLogger()
    const capture = createCaptureCrop({
      tryNativeCrop: async () => Buffer.from('jpeg'),
      bumpCropMetric: () => {},
      logger,
    })
    await capture(HANDLE, { x: 0, y: 0, w: 10, h: 10 }, 640, 360, 0.1, 320, 636)
    expect(debug).not.toHaveBeenCalled()
  })
})
