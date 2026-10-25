import { describe, it, expect } from 'vitest'
import type { VideoFrameGenerator, VideoFrame } from '../video-frame-generator.js'

function makeFakeGen(produced: number[]): { gen: VideoFrameGenerator; producedAt: number[] } {
  const producedAt: number[] = []
  const gen: VideoFrameGenerator = {
    async *generateVideoFrames() {
      for (const t of produced) {
        producedAt.push(t)
        const image = {
          width: 4,
          height: 4,
          format: 'gray' as const,
          toBuffer: async () => new Uint8Array(16),
          close: () => {},
        }
        yield { timestamp: t, image } satisfies VideoFrame
      }
    },
  }
  return { gen, producedAt }
}

describe('VideoFrameGenerator contract', () => {
  it('is pull-driven: does not produce frame N+1 until frame N is consumed', async () => {
    const { gen, producedAt } = makeFakeGen([1, 2, 3])
    const it2 = gen.generateVideoFrames(
      { restreamUrl: 'x', deviceId: 1, codec: 'h264' },
      { fps: 4 },
    )
    const first = await it2.next()
    expect(first.value?.timestamp).toBe(1)
    expect(producedAt).toEqual([1]) // 2 and 3 NOT yet produced — back-pressure
    await it2.return?.()
    expect(producedAt).toEqual([1]) // aclose stopped production
  })
})
