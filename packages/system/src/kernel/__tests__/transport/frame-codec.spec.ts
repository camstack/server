import { describe, it, expect } from 'vitest'
import { encodeFrame, FrameDecoder } from '../../transport/frame-codec.js'

describe('frame-codec', () => {
  it('round-trips a single value', () => {
    const buf = encodeFrame({ hello: 'world', n: 42 })
    const out = new FrameDecoder().push(buf)
    expect(out).toEqual([{ hello: 'world', n: 42 }])
  })

  it('reassembles a value split across chunks', () => {
    const buf = encodeFrame({ a: 1, b: [1, 2, 3] })
    const dec = new FrameDecoder()
    expect(dec.push(buf.subarray(0, 3))).toEqual([]) // header incomplete
    expect(dec.push(buf.subarray(3))).toEqual([{ a: 1, b: [1, 2, 3] }])
  })

  it('emits multiple frames from one chunk', () => {
    const buf = Buffer.concat([encodeFrame({ x: 1 }), encodeFrame({ x: 2 })])
    expect(new FrameDecoder().push(buf)).toEqual([{ x: 1 }, { x: 2 }])
  })

  it('preserves binary (Buffer) payloads', () => {
    const buf = encodeFrame({ data: new Uint8Array([0, 1, 255]) })
    const [out] = new FrameDecoder().push(buf) as Array<{ data: Uint8Array }>
    expect(out).toBeDefined()
    if (!out) throw new Error('expected one decoded frame')
    expect(Array.from(out.data)).toEqual([0, 1, 255])
  })

  it('round-trips an undefined property as undefined, not null (void cap results)', () => {
    // A void-returning cap method resolves `undefined`. The response frame
    // carries it as `body: undefined`; it MUST decode back as undefined so
    // the hub's `z.void()` output validation passes. MsgPack nil would
    // otherwise surface as `null` and fail validation.
    const buf = encodeFrame({ k: 'res', id: 1, ok: true, body: undefined })
    const [out] = new FrameDecoder().push(buf) as Array<Record<string, unknown>>
    expect(out).toBeDefined()
    if (!out) throw new Error('expected one decoded frame')
    expect(out).toEqual({ k: 'res', id: 1, ok: true })
    expect('body' in out).toBe(false)
    expect(out.body).toBeUndefined()
  })

  it('preserves an explicit null property as null (nullable cap results)', () => {
    // A method whose output schema is `.nullable()` legitimately returns
    // null — that must NOT be swallowed. Only undefined is dropped.
    const buf = encodeFrame({ k: 'res', id: 2, ok: true, body: null })
    const [out] = new FrameDecoder().push(buf) as Array<Record<string, unknown>>
    expect(out).toBeDefined()
    if (!out) throw new Error('expected one decoded frame')
    expect(out.body).toBeNull()
    expect('body' in out).toBe(true)
  })
})
