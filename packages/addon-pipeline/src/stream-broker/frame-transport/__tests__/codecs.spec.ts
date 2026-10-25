import { describe, it, expect } from 'vitest'
import type { DecodedFrame } from '@camstack/types'
import { LengthPrefixCodec } from '../codecs/length-prefix-codec.js'
import {
  decodedFrameCodec,
  encodeDecodedFrame,
  decodeDecodedFrame,
} from '../codecs/decoded-frame-codec.js'

describe('LengthPrefixCodec', () => {
  const codec = new LengthPrefixCodec<string>({
    serialize: (msg) => Buffer.from(msg, 'utf-8'),
    deserialize: (bytes) => Buffer.from(bytes).toString('utf-8'),
  })

  it('round-trips a single message', () => {
    const bytes = codec.encode('hello')
    const decoder = codec.createDecoder()
    const out = decoder.push(bytes)
    expect(out).toEqual(['hello'])
  })

  it('emits multiple messages when chunks contain several frames', () => {
    const a = codec.encode('one')
    const b = codec.encode('two')
    const c = codec.encode('three')
    const joined = Buffer.concat([a, b, c])
    const decoder = codec.createDecoder()
    expect(decoder.push(joined)).toEqual(['one', 'two', 'three'])
  })

  it('buffers across partial chunks', () => {
    const bytes = codec.encode('partial')
    // Split mid-payload.
    const half = Math.floor(bytes.length / 2)
    const first = bytes.subarray(0, half)
    const second = bytes.subarray(half)
    const decoder = codec.createDecoder()
    expect(decoder.push(first)).toEqual([])
    expect(decoder.push(second)).toEqual(['partial'])
  })

  it('handles split inside the length prefix', () => {
    const bytes = codec.encode('abc')
    // Split with 1 byte of prefix arriving first (less than the 4-byte prefix).
    const decoder = codec.createDecoder()
    expect(decoder.push(bytes.subarray(0, 1))).toEqual([])
    expect(decoder.push(bytes.subarray(1, 3))).toEqual([])
    expect(decoder.push(bytes.subarray(3))).toEqual(['abc'])
  })

  it('handles empty payloads', () => {
    const bytes = codec.encode('')
    const decoder = codec.createDecoder()
    expect(decoder.push(bytes)).toEqual([''])
  })

  it('resets decoder state', () => {
    const bytes = codec.encode('partial-then-reset')
    const decoder = codec.createDecoder()
    decoder.push(bytes.subarray(0, 5))
    decoder.reset()
    // After reset, feeding the full bytes again should decode cleanly.
    expect(decoder.push(bytes)).toEqual(['partial-then-reset'])
  })
})

describe('decodedFrameCodec', () => {
  const sampleFrame: DecodedFrame = {
    data: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    width: 640,
    height: 480,
    format: 'jpeg',
    timestamp: 1_700_000_000_000,
  }

  it('round-trips a DecodedFrame via encode/decode', () => {
    const bytes = encodeDecodedFrame(sampleFrame)
    const out = decodeDecodedFrame(bytes)
    expect(out.width).toBe(sampleFrame.width)
    expect(out.height).toBe(sampleFrame.height)
    expect(out.format).toBe(sampleFrame.format)
    expect(out.timestamp).toBe(sampleFrame.timestamp)
    expect(Buffer.from(out.data).equals(sampleFrame.data)).toBe(true)
  })

  it('round-trips through the full length-prefix codec', () => {
    const encoded = decodedFrameCodec.encode(sampleFrame)
    const decoder = decodedFrameCodec.createDecoder()
    const [out] = decoder.push(encoded)
    expect(out).toBeDefined()
    expect(out?.width).toBe(sampleFrame.width)
    expect(out?.format).toBe(sampleFrame.format)
    expect(out?.timestamp).toBe(sampleFrame.timestamp)
    expect(out?.data.length).toBe(sampleFrame.data.length)
  })

  it('supports all known formats', () => {
    for (const format of ['jpeg', 'rgb', 'bgr', 'yuv420', 'gray'] as const) {
      const frame: DecodedFrame = { ...sampleFrame, format }
      const bytes = encodeDecodedFrame(frame)
      const out = decodeDecodedFrame(bytes)
      expect(out.format).toBe(format)
    }
  })

  it('preserves large payloads', () => {
    const bigData = Buffer.alloc(256 * 1024, 0xab)
    const frame: DecodedFrame = { ...sampleFrame, data: bigData }
    const encoded = decodedFrameCodec.encode(frame)
    const decoder = decodedFrameCodec.createDecoder()
    const [out] = decoder.push(encoded)
    expect(out?.data.length).toBe(bigData.length)
    expect(Buffer.from(out!.data).equals(bigData)).toBe(true)
  })

  it('throws on short payloads', () => {
    expect(() => decodeDecodedFrame(new Uint8Array(10))).toThrow(/too short/)
  })
})
