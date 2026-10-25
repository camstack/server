import { describe, expect, it, vi } from 'vitest'
import { LocalFrameRegistry } from '../../session-decode/local-frame-registry.js'
import type { FrameImage } from '../../session-decode/video-frame-generator.js'
import { LocalFrameRefMissError, createRootFrameViewResolver } from '../frame-ref-view-provider.js'

function image(): FrameImage {
  return {
    width: 1920,
    height: 1080,
    format: 'rgb',
    toBuffer: vi.fn(async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9])),
    close: vi.fn(),
  }
}

describe('frameRef root view provider', () => {
  it('materializes heterogeneous roots only after their models are known', async () => {
    const registry = new LocalFrameRegistry({
      registryId: 'provider-process',
      maxFrames: 2,
      maxBytes: 10_000_000,
    })
    const ref = registry.register(image(), { timestamp: 1 })!
    const resolver = createRootFrameViewResolver(registry, ref)

    const root320 = await resolver({
      modelId: 'yolo-320',
      definition: {
        models: [
          {
            id: 'yolo-320',
            inputSize: { width: 320, height: 320 },
            preprocessMode: 'letterbox',
          },
        ],
      },
    })
    const root640 = await resolver({
      modelId: 'yolo-640',
      definition: {
        models: [
          {
            id: 'yolo-640',
            inputSize: { width: 640, height: 640 },
            preprocessMode: 'letterbox',
          },
        ],
      },
    })

    expect(root320).toMatchObject({ width: 320, height: 180, format: 'jpeg' })
    expect(root640).toMatchObject({ width: 640, height: 360, format: 'jpeg' })
    expect(root320.geometry.output).not.toEqual(root640.geometry.output)

    resolver.release('success')
    registry.release(ref, 'success')
  })

  it('reports a stale local ref as an explicit miss and never substitutes another frame', async () => {
    const registry = new LocalFrameRegistry({
      registryId: 'provider-process',
      maxFrames: 1,
      maxBytes: 10_000_000,
    })
    const ref = registry.register(image(), { timestamp: 1 })!
    registry.release(ref, 'drop')

    expect(() => createRootFrameViewResolver(registry, ref)).toThrow(LocalFrameRefMissError)
  })
})
