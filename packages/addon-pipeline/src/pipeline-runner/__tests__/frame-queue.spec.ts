import { describe, it, expect, beforeEach, vi } from 'vitest'
import { FrameQueue, ownFrame } from '../frame-queue.js'
import type { DecodedFrame } from '@camstack/types'

function makeFrame(timestamp: number): DecodedFrame {
  return {
    data: Buffer.alloc(4),
    width: 640,
    height: 480,
    format: 'jpeg',
    timestamp,
  }
}

describe('FrameQueue (latest-only buffer)', () => {
  let queue: FrameQueue

  beforeEach(() => {
    queue = new FrameQueue(3, ownFrame)
  })

  it('starts empty with size 0', () => {
    expect(queue.size).toBe(0)
  })

  it('returns undefined when dequeuing from empty queue', () => {
    expect(queue.dequeue()).toBeUndefined()
  })

  it('keeps only the latest frame, dropping older ones', () => {
    const f1 = makeFrame(1)
    const f2 = makeFrame(2)
    const f3 = makeFrame(3)

    queue.enqueue(f1)
    queue.enqueue(f2)
    queue.enqueue(f3)

    // The queue keeps only the latest frame. Per the D9 Task 7b copy-on-retain
    // contract `enqueue` copies the (possibly borrowed shm scratch) pixels into
    // queue-owned storage, so the dequeued frame is a distinct object with
    // equal metadata — not the same reference passed to `enqueue`.
    const dequeued = queue.dequeue()
    expect(dequeued).not.toBeUndefined()
    expect(dequeued?.timestamp).toBe(3)
    expect(dequeued?.width).toBe(f3.width)
    expect(dequeued?.height).toBe(f3.height)
    expect(dequeued?.format).toBe(f3.format)
    expect(queue.dequeue()).toBeUndefined()
  })

  it('copies pixels into queue-owned storage at enqueue (copy-on-retain)', () => {
    // D9 Task 7b: a frame's `data` may be a borrowed shm scratch buffer valid
    // only until the reader's next read. `enqueue` must detach a copy so the
    // queued frame survives any later read overwriting the source buffer.
    const borrowed = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd])
    const frame: DecodedFrame = {
      data: borrowed,
      width: 8,
      height: 8,
      format: 'gray',
      timestamp: 1,
    }
    queue.enqueue(frame)

    // Simulate the reader recycling its scratch buffer in place.
    borrowed.fill(0x00)

    const dequeued = queue.dequeue()
    expect(dequeued?.data.equals(Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]))).toBe(true)
    // The queue-owned copy is a distinct buffer, not the borrowed source.
    expect(dequeued?.data).not.toBe(borrowed)
  })

  it('counts dropped frames when overwritten', () => {
    queue.enqueue(makeFrame(1))
    expect(queue.droppedFrames).toBe(0)

    queue.enqueue(makeFrame(2))
    expect(queue.droppedFrames).toBe(1)

    queue.enqueue(makeFrame(3))
    expect(queue.droppedFrames).toBe(2)
  })

  it('size is 1 after enqueue, 0 after dequeue', () => {
    queue.enqueue(makeFrame(1))
    expect(queue.size).toBe(1)

    queue.dequeue()
    expect(queue.size).toBe(0)
  })

  it('clear empties the buffer but preserves dropped count', () => {
    queue.enqueue(makeFrame(1))
    queue.enqueue(makeFrame(2)) // drops frame 1
    queue.clear()

    expect(queue.size).toBe(0)
    expect(queue.droppedFrames).toBe(1)
    expect(queue.dequeue()).toBeUndefined()
  })

  it('disposes overwritten and detached items but transfers dequeued ownership', () => {
    const dispose = vi.fn()
    const owned = new FrameQueue<DecodedFrame>(1, ownFrame, dispose)
    owned.enqueue(makeFrame(1))
    owned.enqueue(makeFrame(2))
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(dispose.mock.calls[0]?.[0].timestamp).toBe(1)

    const dequeued = owned.dequeue()
    expect(dequeued?.timestamp).toBe(2)
    expect(dispose).toHaveBeenCalledTimes(1)

    owned.enqueue(makeFrame(3))
    owned.clear()
    expect(dispose).toHaveBeenCalledTimes(2)
    expect(dispose.mock.calls[1]?.[0].timestamp).toBe(3)
  })

  it('exposes the configured maxSize', () => {
    expect(queue.maxSize).toBe(3)
  })
})
