import { describe, expect, it } from 'vitest'
import {
  encodeFrame,
  encodeFrameHead,
  FrameDecoder,
  packPayload,
  PAYLOAD_KEY,
  unpackPayload,
} from '../../transport/frame-codec.js'

/**
 * The raw-forward wire shape: a frame whose opaque payload is the contiguous
 * TAIL of the msgpack envelope, so a router can read the envelope and write
 * the tail through without a decode or an encode of what it carries.
 *
 * The contract pinned here is that the result is ORDINARY msgpack — a peer
 * that knows nothing about payloads decodes `{ ...frame, pl: <bin> }` — and
 * that the head never contains a copy of the payload bytes.
 */
describe('encodeFrameHead — a payload rides as the frame’s last key', () => {
  const payload = Buffer.from('0123456789abcdef'.repeat(64)) // 1 KiB, non-trivial bytes

  it('decodes to the envelope plus a `pl` bin holding exactly the payload bytes', () => {
    const frame = { k: 'req', id: 7, body: { kind: 'cap-call-out', capName: 'x' } }
    const head = encodeFrameHead(frame, payload)
    const decoder = new FrameDecoder()
    const frames = decoder.push(Buffer.concat([head, payload]))
    expect(frames).toHaveLength(1)
    const got = frames[0] as { k: string; id: number; body: unknown; pl: Uint8Array }
    expect(got.k).toBe('req')
    expect(got.id).toBe(7)
    expect(got.body).toEqual({ kind: 'cap-call-out', capName: 'x' })
    expect(Buffer.from(got.pl).equals(payload)).toBe(true)
    expect(Object.keys(got).sort()).toEqual(['body', 'id', 'k', PAYLOAD_KEY].sort())
  })

  it('declares a length that covers head and tail, and the head holds no payload byte', () => {
    const frame = { k: 'res', id: 1, ok: true, body: null }
    const head = encodeFrameHead(frame, payload)
    expect(head.readUInt32BE(0)).toBe(head.byteLength - 4 + payload.byteLength)
    // A 1 KiB payload cannot hide inside a head this small.
    expect(head.byteLength).toBeLessThan(64)
  })

  it('handles every envelope size a Frame can have, including an omitted undefined body', () => {
    const cases: Record<string, unknown>[] = [
      { k: 'evt' },
      { k: 'req', id: 1 }, // `body: undefined` is dropped by ignoreUndefined
      { k: 'req', id: 1, body: undefined },
      { k: 'res', id: 2, ok: true, body: 'x' },
      { k: 'res', id: 3, ok: false, err: 'boom', body: 1 },
    ]
    for (const frame of cases) {
      const head = encodeFrameHead(frame, payload)
      const frames = new FrameDecoder().push(Buffer.concat([head, payload]))
      expect(frames).toHaveLength(1)
      const got = frames[0] as Record<string, unknown>
      expect(Buffer.from(got[PAYLOAD_KEY] as Uint8Array).equals(payload)).toBe(true)
      const { [PAYLOAD_KEY]: _pl, ...rest } = got
      const plain = new FrameDecoder().push(encodeFrame(frame))[0]
      expect(rest).toEqual(plain)
    }
  })

  it('survives arbitrary socket chunking of head and tail together', () => {
    const frame = { k: 'req', id: 9, body: { a: 1 } }
    const bytes = Buffer.concat([encodeFrameHead(frame, payload), payload])
    for (const size of [1, 3, 7, 64, 1000]) {
      const decoder = new FrameDecoder()
      const out: unknown[] = []
      for (let i = 0; i < bytes.byteLength; i += size) {
        out.push(...decoder.push(bytes.subarray(i, i + size)))
      }
      expect(out).toHaveLength(1)
      expect(Buffer.from((out[0] as { pl: Uint8Array }).pl).equals(payload)).toBe(true)
    }
  })

  it('refuses an envelope that is not a small map (the patch would corrupt it)', () => {
    const wide: Record<string, number> = {}
    for (let i = 0; i < 16; i += 1) wide[`k${i}`] = i
    expect(() => encodeFrameHead(wide, payload)).toThrow(/fixmap/)
    expect(() => encodeFrameHead([1, 2] as unknown as Record<string, unknown>, payload)).toThrow(
      /fixmap/,
    )
  })

  it('accepts an empty payload', () => {
    const frame = { k: 'req', id: 1, body: 'x' }
    const head = encodeFrameHead(frame, new Uint8Array(0))
    const got = new FrameDecoder().push(head)[0] as { pl: Uint8Array }
    expect(got.pl.byteLength).toBe(0)
  })
})

describe('packPayload / unpackPayload — the value codec both ends of a payload share', () => {
  it('round-trips an object graph with a binary field and preserves undefined vs null', () => {
    const value = { a: 1, b: null, c: undefined, d: new Uint8Array([1, 2, 3]), e: [1, 'x'] }
    const got = unpackPayload(packPayload(value)) as Record<string, unknown>
    expect(got.a).toBe(1)
    expect(got.b).toBeNull()
    expect('c' in got).toBe(false)
    expect(Buffer.from(got.d as Uint8Array).equals(Buffer.from([1, 2, 3]))).toBe(true)
    expect(got.e).toEqual([1, 'x'])
  })

  it('round-trips a bare binary value without copying it into a wrapper', () => {
    const bytes = new Uint8Array(13_500).fill(7)
    const got = unpackPayload(packPayload(bytes)) as Uint8Array
    expect(got.byteLength).toBe(13_500)
    expect(got[13_499]).toBe(7)
  })
})
