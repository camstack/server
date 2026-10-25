/**
 * The composed picture as a buffer we own, instead of a filter graph ffmpeg
 * drives.
 *
 * This is what makes the tile gap zero. `overlay` pairs its inputs BY PTS, and
 * ffmpeg gives each input pts 0 at ITS OWN first frame, so two sources that
 * joined at different moments compose different moments for the life of the
 * child — measured at 4-5 s, drifting with the sources' key-frame phases, and
 * unreachable from any flag (with `-copyts` both restreams still report
 * `pts_time:0`, so there is no common timeline to align against).
 *
 * A canvas has no pairing to get wrong. Whatever frame arrived last from a
 * source is what its rectangle holds when the output tick fires, and the output
 * has its own clock.
 *
 * yuv420p, because that is the one pixel format every consumer of a CamStack
 * profile reads, and because a plane copy is a strided memcpy — no arithmetic
 * per pixel. Its chroma planes are half resolution in both axes, which is why
 * every rectangle here must be EVEN: an odd origin would land a tile's chroma
 * half a sample off its luma, and the tile would be tinted rather than broken,
 * which is worse.
 */
import { describe, expect, it } from 'vitest'
import { GridCanvas, evenDown, yuv420pSize } from './grid-canvas.js'

describe('yuv420pSize', () => {
  it('is luma plus two quarter-sized chroma planes', () => {
    expect(yuv420pSize(4, 2)).toBe(4 * 2 + 2 * (2 * 1))
    expect(yuv420pSize(1920, 1080)).toBe((1920 * 1080 * 3) / 2)
  })
})

describe('evenDown', () => {
  it('rounds DOWN to even, so a tile never claims a sample it was not given', () => {
    expect(evenDown(7)).toBe(6)
    expect(evenDown(8)).toBe(8)
    expect(evenDown(1)).toBe(0)
  })
})

describe('GridCanvas', () => {
  it('starts as legible black, not as uninitialised memory', () => {
    const canvas = new GridCanvas(4, 2)
    const buf = canvas.buffer
    // Y = 0 (black), U/V = 128 (neutral). Garbage here is coloured noise on
    // every cell nobody has filled yet.
    expect(buf.subarray(0, 8).every((b) => b === 0)).toBe(true)
    expect(buf.subarray(8).every((b) => b === 128)).toBe(true)
  })

  it('copies a tile to its origin, in all three planes', () => {
    const canvas = new GridCanvas(4, 4)
    const tile = Buffer.alloc(yuv420pSize(2, 2))
    tile.fill(200, 0, 4) // luma
    tile.fill(50, 4, 5) // U
    tile.fill(60, 5, 6) // V
    canvas.blit(tile, { width: 2, height: 2 }, { x: 2, y: 2 })

    const buf = canvas.buffer
    // Luma row 2 is [0,0,200,200]; row 0 untouched.
    expect([...buf.subarray(8, 12)]).toEqual([0, 0, 200, 200])
    expect([...buf.subarray(0, 4)]).toEqual([0, 0, 0, 0])
    // Chroma planes are 2x2; the tile's single sample lands at (1,1).
    const uStart = 16
    expect([...buf.subarray(uStart, uStart + 4)]).toEqual([128, 128, 128, 50])
  })

  it('REFUSES a tile that would not fit rather than writing past the plane', () => {
    const canvas = new GridCanvas(4, 4)
    const tile = Buffer.alloc(yuv420pSize(4, 4))
    expect(canvas.blit(tile, { width: 4, height: 4 }, { x: 2, y: 0 })).toBe(false)
    expect(canvas.blit(tile, { width: 4, height: 4 }, { x: 0, y: 0 })).toBe(true)
  })

  it('REFUSES a tile whose buffer is the wrong size — a short frame is not a frame', () => {
    const canvas = new GridCanvas(4, 4)
    expect(canvas.blit(Buffer.alloc(3), { width: 2, height: 2 }, { x: 0, y: 0 })).toBe(false)
  })

  it('REFUSES an odd origin — a half-sample chroma offset tints a tile silently', () => {
    const canvas = new GridCanvas(4, 4)
    const tile = Buffer.alloc(yuv420pSize(2, 2))
    expect(canvas.blit(tile, { width: 2, height: 2 }, { x: 1, y: 0 })).toBe(false)
  })
})
