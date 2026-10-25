/**
 * The output owns the clock. That is the whole design.
 *
 * `overlay` asks "which frame of input 1 pairs with frame k of input 0", and
 * gets it wrong for ever when they started at different moments. A compositor
 * asks "what does each camera look like NOW", every tick, and the answer cannot
 * drift apart because there is nothing to pair.
 *
 * The second property matters as much: a tile with no frame yet is BLACK, not a
 * reason to wait. The picture exists from the first tick, and cells fill in as
 * their sources arrive — instead of the whole grid waiting for the slowest
 * source's first key frame, which is what the ~9 s cold start was.
 */
import { describe, expect, it } from 'vitest'
import { GridCompositor } from './grid-compositor.js'
import { yuv420pSize } from './grid-canvas.js'

const CANVAS = { width: 4, height: 4 }

function tilePlan() {
  return {
    canvas: CANVAS,
    tiles: [
      {
        id: 'cell-0',
        deviceId: 1,
        size: { width: 2, height: 4 },
        origin: { x: 0, y: 0 },
        frameBytes: yuv420pSize(2, 4),
        filter: '',
      },
      {
        id: 'cell-1',
        deviceId: 2,
        size: { width: 2, height: 4 },
        origin: { x: 2, y: 0 },
        frameBytes: yuv420pSize(2, 4),
        filter: '',
      },
    ],
  }
}

function harness() {
  const written: Buffer[] = []
  const compositor = new GridCompositor({
    plan: tilePlan(),
    // No seed: these tests are about the composition itself, and a black start
    // is exactly what a composition with no seed to paint must still do.
    seed: null,
    write: (frame) => {
      written.push(Buffer.from(frame))
      return true
    },
  })
  return { compositor, written }
}

describe('GridCompositor', () => {
  it('emits from the FIRST tick, with unfilled cells black', () => {
    const { compositor, written } = harness()
    compositor.tick()
    expect(written).toHaveLength(1)
    const luma = written[0]?.subarray(0, 16)
    expect(luma?.every((b) => b === 0)).toBe(true)
  })

  it('shows a source as soon as it arrives, without waiting for the other', () => {
    const { compositor, written } = harness()
    compositor.onTile('cell-0', Buffer.alloc(yuv420pSize(2, 4), 200))
    compositor.tick()
    const luma = [...(written[0]?.subarray(0, 4) ?? [])]
    // Left half is the arrived source, right half still black.
    expect(luma).toEqual([200, 200, 0, 0])
  })

  it('HOLDS the last frame of a source that stops — a tile must not blink', () => {
    const { compositor, written } = harness()
    compositor.onTile('cell-0', Buffer.alloc(yuv420pSize(2, 4), 200))
    compositor.tick()
    compositor.tick()
    expect([...(written[1]?.subarray(0, 4) ?? [])]).toEqual([200, 200, 0, 0])
  })

  it('takes the NEWEST frame of a source that outran the tick', () => {
    const { compositor, written } = harness()
    compositor.onTile('cell-0', Buffer.alloc(yuv420pSize(2, 4), 10))
    compositor.onTile('cell-0', Buffer.alloc(yuv420pSize(2, 4), 20))
    compositor.tick()
    expect(written[0]?.[0]).toBe(20)
  })

  it('ignores a tile it has no rectangle for, rather than throwing on the tick path', () => {
    const { compositor, written } = harness()
    compositor.onTile('nope', Buffer.alloc(8, 1))
    compositor.tick()
    expect(written).toHaveLength(1)
  })

  it('stops emitting once closed — a dead child must not keep a timer alive', () => {
    const { compositor, written } = harness()
    compositor.close()
    compositor.tick()
    expect(written).toHaveLength(0)
  })

  it('reports back-pressure so the caller can stop pushing', () => {
    const written: Buffer[] = []
    const compositor = new GridCompositor({
      plan: tilePlan(),
      seed: null,
      write: (frame) => {
        written.push(Buffer.from(frame))
        return false
      },
    })
    expect(compositor.tick()).toBe(false)
  })
})

describe('a tile whose decoder is replaced', () => {
  it('forgets the HALF frame, because raw video has no framing to re-sync on', () => {
    const { compositor, written } = harness()
    const half = yuv420pSize(2, 4) / 2
    compositor.onTile('cell-0', Buffer.alloc(half, 7))
    // The decoder died here. Its bytes must not be completed by the next one's.
    compositor.resetTile('cell-0')
    compositor.onTile('cell-0', Buffer.alloc(yuv420pSize(2, 4), 200))
    compositor.tick()
    expect([...(written[0]?.subarray(0, 4) ?? [])]).toEqual([200, 200, 0, 0])
  })

  it('KEEPS the last whole frame, so the cell freezes rather than blinking', () => {
    const { compositor, written } = harness()
    compositor.onTile('cell-0', Buffer.alloc(yuv420pSize(2, 4), 90))
    compositor.resetTile('cell-0')
    compositor.tick()
    expect([...(written[0]?.subarray(0, 4) ?? [])]).toEqual([90, 90, 0, 0])
  })

  it('ignores a reset for a tile it does not have', () => {
    const { compositor } = harness()
    expect(() => {
      compositor.resetTile('nope')
    }).not.toThrow()
  })
})
