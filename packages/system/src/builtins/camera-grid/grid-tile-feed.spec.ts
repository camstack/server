/**
 * One source's decoded tiles, of which only the LATEST is ever wanted.
 *
 * This is where a compositor differs from a filter graph, and where the tile
 * gap actually dies. ffmpeg's `overlay` consumes one frame per input per output
 * frame, so an input that got ahead stays ahead for ever. A canvas asks a
 * different question — "what does this camera look like NOW" — so everything
 * behind the newest frame is not a backlog to work through, it is history, and
 * the right thing to do with it is drop it.
 *
 * Dropping is also the only bound on memory here. A decoder child that outruns
 * the output tick, or a tick that stalls, would otherwise grow a queue of raw
 * frames — 345 KB each at 640x360 — with nothing to stop it.
 */
import { describe, expect, it } from 'vitest'
import { GridTileFeed } from './grid-tile-feed.js'

const FRAME = 6 // yuv420p 2x2

function frame(fill: number): Buffer {
  return Buffer.alloc(FRAME, fill)
}

describe('GridTileFeed', () => {
  it('has nothing until a WHOLE frame has arrived', () => {
    const feed = new GridTileFeed(FRAME)
    expect(feed.latest()).toBeNull()
    feed.push(Buffer.alloc(FRAME - 1, 7))
    expect(feed.latest()).toBeNull()
    feed.push(Buffer.alloc(1, 7))
    expect(feed.latest()).toEqual(frame(7))
  })

  it('reassembles a frame split across arbitrary chunks', () => {
    const feed = new GridTileFeed(FRAME)
    feed.push(Buffer.from([1, 2]))
    feed.push(Buffer.from([3]))
    feed.push(Buffer.from([4, 5, 6]))
    expect(feed.latest()).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]))
  })

  it('keeps only the NEWEST frame when several arrive in one chunk', () => {
    const feed = new GridTileFeed(FRAME)
    feed.push(Buffer.concat([frame(1), frame(2), frame(3)]))
    expect(feed.latest()).toEqual(frame(3))
  })

  it('holds the last frame between ticks — a tile does not blink because nothing arrived', () => {
    const feed = new GridTileFeed(FRAME)
    feed.push(frame(9))
    expect(feed.latest()).toEqual(frame(9))
    expect(feed.latest()).toEqual(frame(9))
  })

  it('reports whether anything NEW arrived, so a tick can skip an unchanged canvas', () => {
    const feed = new GridTileFeed(FRAME)
    expect(feed.hasFresh()).toBe(false)
    feed.push(frame(1))
    expect(feed.hasFresh()).toBe(true)
    feed.latest()
    expect(feed.hasFresh()).toBe(false)
    feed.push(frame(2))
    expect(feed.hasFresh()).toBe(true)
  })

  it('never holds more than one frame plus a partial one', () => {
    const feed = new GridTileFeed(FRAME)
    for (let i = 0; i < 100; i += 1) feed.push(frame(i))
    feed.push(Buffer.from([1, 2]))
    expect(feed.bufferedBytes()).toBeLessThanOrEqual(FRAME + 2)
  })
})
