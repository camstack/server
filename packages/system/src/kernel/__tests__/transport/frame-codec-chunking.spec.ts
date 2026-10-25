import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeFrame, FrameDecoder } from '../../transport/frame-codec.js'

/**
 * Chunk-boundary contract for {@link FrameDecoder}.
 *
 * These tests were written against the ORIGINAL `Buffer.concat([this.buf,
 * chunk])`-per-chunk accumulator and confirmed green BEFORE it was replaced,
 * so they pin the behaviour that existed rather than the behaviour the
 * rewrite happens to produce. A UDS payload arrives in kernel-sized pieces;
 * every case below is something a real socket does.
 *
 * The one that matters most is the multi-megabyte frame in 64 KiB chunks —
 * that is the shape (native crops, key frames, snapshot blobs) whose
 * quadratic copying this decoder used to do on the hub's main thread.
 */

/** A deterministic PRNG so a failing split is reproducible from its seed. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0x1_0000_0000
  }
}

/** Split `buf` into pieces of exactly `size` bytes (the last may be shorter). */
function fixedSplit(buf: Buffer, size: number): readonly Buffer[] {
  const out: Buffer[] = []
  for (let i = 0; i < buf.byteLength; i += size) out.push(buf.subarray(i, i + size))
  return out
}

/** Split `buf` at `count` random offsets, mimicking arbitrary socket delivery. */
function randomSplit(buf: Buffer, count: number, rnd: () => number): readonly Buffer[] {
  const cuts = new Set<number>()
  for (let i = 0; i < count; i++) cuts.add(1 + Math.floor(rnd() * (buf.byteLength - 1)))
  const offsets = [0, ...Array.from(cuts).sort((a, b) => a - b), buf.byteLength]
  const out: Buffer[] = []
  for (let i = 0; i < offsets.length - 1; i++) {
    const start = offsets[i]
    const end = offsets[i + 1]
    if (start === undefined || end === undefined || end <= start) continue
    out.push(buf.subarray(start, end))
  }
  return out
}

/** Feed every chunk in order and return the flattened frame sequence. */
function drain(dec: FrameDecoder, chunks: readonly Buffer[]): unknown[] {
  const out: unknown[] = []
  for (const c of chunks) out.push(...dec.push(c))
  return out
}

/**
 * Reduce a frame to a compact comparable form: binary payloads become a
 * `sha`-like length+digest string so a mismatch prints a one-line diff
 * instead of a megabyte of index keys.
 */
function fingerprint(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    let hash = 2166136261
    for (const byte of value) {
      hash = Math.imul(hash ^ byte, 16777619)
    }
    return `bin:${value.byteLength}:${(hash >>> 0).toString(16)}`
  }
  if (Array.isArray(value)) return value.map(fingerprint)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fingerprint(v)]))
  }
  return value
}

/** A byte pattern that catches an off-by-one splice anywhere in the payload. */
function ramp(size: number): Uint8Array {
  const out = new Uint8Array(size)
  for (let i = 0; i < size; i++) out[i] = (i * 31 + (i >>> 8)) & 0xff
  return out
}

describe('FrameDecoder chunk boundaries', () => {
  it('holds back a frame whose 4-byte length prefix is itself split', () => {
    const buf = encodeFrame({ hello: 'world' })
    const dec = new FrameDecoder()
    // One byte at a time through the header: nothing may be emitted until the
    // whole body has arrived, and the header must be readable ACROSS chunks.
    expect(dec.push(buf.subarray(0, 1))).toEqual([])
    expect(dec.push(buf.subarray(1, 2))).toEqual([])
    expect(dec.push(buf.subarray(2, 3))).toEqual([])
    expect(dec.push(buf.subarray(3, 4))).toEqual([])
    expect(dec.push(buf.subarray(4))).toEqual([{ hello: 'world' }])
  })

  it('reassembles a 3 MiB frame delivered in 64 KiB chunks, byte-exact', () => {
    const payload = ramp(3 * 1024 * 1024)
    const buf = encodeFrame({ k: 'evt', body: payload })
    const chunks = fixedSplit(buf, 64 * 1024)
    expect(chunks.length).toBeGreaterThan(40)

    const out = drain(new FrameDecoder(), chunks)
    expect(out).toHaveLength(1)
    const frame = out[0]
    if (typeof frame !== 'object' || frame === null || !('body' in frame)) {
      throw new Error('expected a decoded frame with a body')
    }
    const { body } = frame
    if (!(body instanceof Uint8Array)) throw new Error('expected a binary body')
    expect(body.byteLength).toBe(payload.byteLength)
    expect(Buffer.compare(Buffer.from(body), Buffer.from(payload))).toBe(0)
  })

  it('emits nothing until the last byte of a multi-chunk frame arrives', () => {
    const buf = encodeFrame({ blob: ramp(200_000) })
    const chunks = fixedSplit(buf, 64 * 1024)
    const dec = new FrameDecoder()
    const last = chunks[chunks.length - 1]
    if (last === undefined) throw new Error('expected chunks')
    for (const c of chunks.slice(0, -1)) expect(dec.push(c)).toEqual([])
    expect(dec.push(last)).toHaveLength(1)
  })

  it('emits every complete frame present in a single chunk', () => {
    const buf = Buffer.concat([encodeFrame({ x: 1 }), encodeFrame({ x: 2 }), encodeFrame({ x: 3 })])
    expect(new FrameDecoder().push(buf)).toEqual([{ x: 1 }, { x: 2 }, { x: 3 }])
  })

  it('handles a chunk carrying the tail of one frame, a whole frame, and a head', () => {
    const a = encodeFrame({ n: 'a' })
    const b = encodeFrame({ n: 'b' })
    const c = encodeFrame({ n: 'c' })
    const stream = Buffer.concat([a, b, c])
    const dec = new FrameDecoder()
    // Cut mid-`a` and mid-`c`, so the middle chunk is [tail of a | all of b | head of c].
    const firstCut = a.byteLength - 2
    const secondCut = a.byteLength + b.byteLength + 2
    expect(dec.push(stream.subarray(0, firstCut))).toEqual([])
    expect(dec.push(stream.subarray(firstCut, secondCut))).toEqual([{ n: 'a' }, { n: 'b' }])
    expect(dec.push(stream.subarray(secondCut))).toEqual([{ n: 'c' }])
  })

  it('keeps a partial frame buffered across a push that emitted others', () => {
    const a = encodeFrame({ n: 'a' })
    const b = encodeFrame({ n: 'b' })
    const dec = new FrameDecoder()
    // One chunk: all of `a` plus only the first 2 bytes of `b`'s header.
    expect(dec.push(Buffer.concat([a, b.subarray(0, 2)]))).toEqual([{ n: 'a' }])
    expect(dec.push(b.subarray(2))).toEqual([{ n: 'b' }])
  })

  it('decodes a whole stream fed one byte at a time', () => {
    const stream = Buffer.concat([
      encodeFrame({ k: 'req', id: 1, body: { a: 1 } }),
      encodeFrame({ k: 'res', id: 1, ok: true, body: 'done' }),
      encodeFrame({ k: 'evt', body: [1, 2, 3] }),
    ])
    const out = drain(new FrameDecoder(), fixedSplit(stream, 1))
    expect(out).toEqual([
      { k: 'req', id: 1, body: { a: 1 } },
      { k: 'res', id: 1, ok: true, body: 'done' },
      { k: 'evt', body: [1, 2, 3] },
    ])
  })

  it('treats a zero-length push as a no-op that preserves buffered state', () => {
    const buf = encodeFrame({ z: true })
    const dec = new FrameDecoder()
    expect(dec.push(buf.subarray(0, 5))).toEqual([])
    expect(dec.push(Buffer.alloc(0))).toEqual([])
    expect(dec.push(buf.subarray(5))).toEqual([{ z: true }])
  })

  it('leaves an already-emitted binary payload intact when later chunks arrive', () => {
    // The decoder hands out views; a subsequent push must never write over
    // bytes a caller is still holding.
    const payload = ramp(150_000)
    const first = encodeFrame({ body: payload })
    const dec = new FrameDecoder()
    const [emitted] = drain(dec, fixedSplit(first, 64 * 1024))
    if (
      typeof emitted !== 'object' ||
      emitted === null ||
      !('body' in emitted) ||
      !(emitted.body instanceof Uint8Array)
    ) {
      throw new Error('expected a binary body')
    }
    const held = emitted.body
    drain(dec, fixedSplit(encodeFrame({ body: ramp(150_000).fill(0xaa) }), 64 * 1024))
    expect(Buffer.compare(Buffer.from(held), Buffer.from(payload))).toBe(0)
  })

  it('survives arbitrary random splits of a mixed-size frame stream', () => {
    const rnd = makeRandom(0xc0ffee)
    const frames: readonly unknown[] = [
      { k: 'req', id: 1, body: { small: true } },
      { k: 'evt', body: ramp(1024) },
      { k: 'res', id: 1, ok: true, body: ramp(70_000) },
      { k: 'evt', body: 'x'.repeat(300) },
      { k: 'res', id: 2, ok: true, body: ramp(5) },
    ]
    const stream = Buffer.concat(frames.map((f) => encodeFrame(f)))
    const expected = frames.map(fingerprint)
    for (let trial = 0; trial < 25; trial++) {
      const out = drain(new FrameDecoder(), randomSplit(stream, 40, rnd))
      expect(out).toHaveLength(frames.length)
      expect(out.map(fingerprint)).toEqual(expected)
    }
  })

  it('does not decode past the declared length of a frame', () => {
    // Two frames back to back where the first body is a string that also
    // looks like a valid MsgPack prefix — the decoder must stop at `len`.
    const a = encodeFrame('aaaaaaaa')
    const b = encodeFrame({ second: true })
    expect(new FrameDecoder().push(Buffer.concat([a, b]))).toEqual(['aaaaaaaa', { second: true }])
  })
})

/**
 * The DISCRIMINATING check for the O(n²) fix.
 *
 * The cases above all pass against the original `Buffer.concat([this.buf,
 * chunk])`-per-chunk decoder — that is what makes them a behaviour net rather
 * than a description of the rewrite. Nothing in them can tell the two apart,
 * so this block asserts the thing that actually changed: how many times the
 * accumulator copies. The old decoder concatenates once per socket chunk (63
 * times for a 4 MiB frame in 64 KiB pieces); the new one concatenates at most
 * once per completed frame, and not at all when a frame arrives whole.
 *
 * A wall-clock budget would be flaky on a loaded CI box. A copy count is
 * deterministic and is the invariant itself.
 */
describe('FrameDecoder copies once per frame, not once per chunk', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** Count `Buffer.concat` calls made while `fn` runs. */
  function countConcats(fn: () => void): number {
    const spy = vi.spyOn(Buffer, 'concat')
    try {
      fn()
      return spy.mock.calls.length
    } finally {
      spy.mockRestore()
    }
  }

  it('concatenates at most once for a 4 MiB frame split into 64 KiB chunks', () => {
    const buf = encodeFrame({ k: 'evt', body: ramp(4 * 1024 * 1024) })
    const chunks = fixedSplit(buf, 64 * 1024)
    expect(chunks.length).toBeGreaterThan(60) // the old decoder concatenated this many times

    const dec = new FrameDecoder()
    let emitted = 0
    const concats = countConcats(() => {
      for (const c of chunks) emitted += dec.push(c).length
    })

    expect(emitted).toBe(1) // the frame really was decoded — not "fast because it did less"
    expect(concats).toBeLessThanOrEqual(1)
  })

  it('never concatenates when whole frames arrive inside a single chunk', () => {
    const stream = Buffer.concat([
      encodeFrame({ k: 'req', id: 1 }),
      encodeFrame({ k: 'req', id: 2 }),
      encodeFrame({ k: 'evt', body: ramp(2048) }),
    ])
    const dec = new FrameDecoder()
    let emitted = 0
    const concats = countConcats(() => {
      emitted += dec.push(stream).length
    })

    expect(emitted).toBe(3)
    expect(concats).toBe(0)
  })

  it('a small frame decoded out of a large chunk does NOT pin the chunk (slab release)', () => {
    // msgpack bin fields decode as VIEWS of the decode input. When that input
    // is a subarray of a 64 KiB socket read chunk, ONE retained field pins the
    // whole chunk — measured live on hub-main as 55k pinned read chunks
    // (3.5 GB off-heap). The decoder must hand msgpack a buffer whose backing
    // store is (about) the frame, not the chunk it happened to arrive in.
    const small = encodeFrame({ k: 'evt', body: ramp(64) })
    const filler = encodeFrame({ k: 'evt', body: ramp(128 * 1024) })
    // One 64 KiB read chunk: the small frame + the head of a larger one.
    const chunk = Buffer.concat([small, filler]).subarray(0, 64 * 1024)

    const dec = new FrameDecoder()
    const frames = dec.push(Buffer.from(chunk)) // real sockets own their chunks
    expect(frames).toHaveLength(1)
    const body = (frames[0] as { body: Uint8Array }).body
    expect(Buffer.from(body)).toEqual(Buffer.from(ramp(64)))
    // The retained field's backing store must be frame-sized, not chunk-sized.
    expect(body.buffer.byteLength).toBeLessThan(small.byteLength + 4096)
  })

  it('an exact-fit reassembled frame stays zero-extra-copy (media path unchanged)', () => {
    // A frame spanning chunks is concat'd into an EXACT total-sized buffer;
    // the 4-byte header is the only waste, far under the copy threshold — so
    // the media path must keep its single-copy guarantee.
    const big = encodeFrame({ k: 'evt', body: ramp(300 * 1024) })
    const dec = new FrameDecoder()
    const frames: unknown[] = []
    for (const c of fixedSplit(big, 64 * 1024)) frames.push(...dec.push(Buffer.from(c)))
    expect(frames).toHaveLength(1)
    const body = (frames[0] as { body: Uint8Array }).body
    // Backing store === the reassembled frame (total bytes) — no second copy.
    expect(body.buffer.byteLength).toBe(big.byteLength)
  })

  it('concatenates once per frame, not once per chunk, across many frames', () => {
    // 20 frames of 160 KiB each, delivered in 64 KiB chunks: every frame
    // spans chunks, so one concat apiece is the floor — the old decoder did
    // one per chunk (~50).
    const stream = Buffer.concat(
      Array.from({ length: 20 }, () => encodeFrame({ k: 'evt', body: ramp(160 * 1024) })),
    )
    const chunks = fixedSplit(stream, 64 * 1024)
    const dec = new FrameDecoder()
    let emitted = 0
    const concats = countConcats(() => {
      for (const c of chunks) emitted += dec.push(c).length
    })

    expect(emitted).toBe(20)
    expect(chunks.length).toBeGreaterThan(45)
    expect(concats).toBeLessThanOrEqual(20)
  })
})
