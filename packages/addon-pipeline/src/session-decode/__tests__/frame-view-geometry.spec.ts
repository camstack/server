import { describe, expect, it } from 'vitest'
import { invertViewBbox, resolveFrameViewGeometry } from '../frame-view-geometry.js'

describe('frame view geometry', () => {
  it('contains a 16:9 source in a square model box without pre-letterbox padding', () => {
    const geometry = resolveFrameViewGeometry(1920, 1080, {
      content: { width: 320, height: 320 },
      fit: 'contain',
      format: 'jpeg',
    })

    expect(geometry.output).toEqual({ width: 320, height: 180 })
    expect(geometry.sourceCrop).toEqual({ left: 0, top: 0, width: 1920, height: 1080 })
  })

  it('stretches a source crop and maps a bbox back into source pixels', () => {
    const geometry = resolveFrameViewGeometry(1920, 1080, {
      crop: { left: 480, top: 270, width: 960, height: 540 },
      content: { width: 300, height: 300 },
      fit: 'stretch',
      format: 'rgb',
    })

    expect(geometry.output).toEqual({ width: 300, height: 300 })
    expect(invertViewBbox({ x: 75, y: 75, w: 150, h: 150 }, geometry)).toEqual({
      x: 720,
      y: 405,
      w: 480,
      h: 270,
    })
  })
})
