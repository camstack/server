import { describe, it, expect } from 'vitest'
import { RingBuffer } from '../utils/ring-buffer.js'

describe('RingBuffer', () => {
  it('push and drain returns items in order', () => {
    const buf = new RingBuffer<number>(4)
    buf.push(1)
    buf.push(2)
    buf.push(3)
    expect(buf.drain(10)).toEqual([1, 2, 3])
  })

  it('drain empties the buffer', () => {
    const buf = new RingBuffer<number>(4)
    buf.push(1)
    buf.push(2)
    buf.drain(10)
    expect(buf.drain(10)).toEqual([])
  })

  it('drain respects maxCount', () => {
    const buf = new RingBuffer<number>(4)
    buf.push(1)
    buf.push(2)
    buf.push(3)
    expect(buf.drain(2)).toEqual([1, 2])
    expect(buf.drain(10)).toEqual([3])
  })

  it('overwrites oldest when full', () => {
    const buf = new RingBuffer<number>(3)
    buf.push(1)
    buf.push(2)
    buf.push(3)
    buf.push(4) // overwrites 1
    expect(buf.drain(10)).toEqual([2, 3, 4])
  })

  it('size returns current count', () => {
    const buf = new RingBuffer<number>(4)
    expect(buf.size).toBe(0)
    buf.push(1)
    expect(buf.size).toBe(1)
    buf.drain(1)
    expect(buf.size).toBe(0)
  })
})
