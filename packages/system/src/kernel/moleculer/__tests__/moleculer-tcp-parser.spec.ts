/**
 * Moleculer's TCP packet parser, as this repository SHIPS it.
 *
 * ## Why a spec over `node_modules`
 *
 * Nothing in `packages/system` owns this file — it is `moleculer`'s, it is
 * bundled verbatim into `@camstack/system/dist/index.js`, and the only way this
 * repository changes it is `patches/moleculer+0.15.0.patch` applied by
 * `patch-package` on `postinstall`. A spec over our own re-implementation would
 * pass while the bundle stayed quadratic, so this one requires the installed
 * file: it is red unless the patch is on disk and applied.
 *
 * ## What it is guarding, measured on the live hub 2026-09-11
 *
 * Upstream `_write` copies the whole partial remainder TWICE per chunk —
 * `Buffer.concat([this.buf, chunk])` on the way in and `Buffer.from(packet)` on
 * the way out — so reassembling one M-byte message from c-byte chunks copies
 * ~M²/c bytes. On hub-main that turned **8.0 MB/s of socket reads into 537 MB/s
 * of external allocation** (`Parser._write` is 98.8 % of every Buffer.concat
 * above 64 kB, sampled in-process), and V8 answers external-memory pressure
 * with a FULL mark-compact: 1.39 major GCs per second against a 602 MB live
 * set, i.e. the four V8 platform workers at 107 % CPU — 70 % of the process.
 *
 * The live set is not what costs: D444 cut it from 2 491 MB to 714 MB and the
 * GC share did not move. The allocation rate is, and this file is where it is.
 */
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)
type ParserCtor = new (options: unknown, maxPacketSize?: number) => ParserLike
/**
 * The shape the parser presents. Declared here because the module is untyped
 * CommonJS: the `as ParserCtor` below is the one documented type boundary in
 * this file, and everything downstream of it is typed.
 */
interface ParserLike {
  write(chunk: Buffer): boolean
  on(event: 'data', listener: (type: unknown, payload: Buffer) => void): ParserLike
  on(event: 'error', listener: (err: Error) => void): ParserLike
  /**
   * Upstream's pending remainder, kept for the unpatched shape.
   *
   * The patched parser (D457) keeps a LIST — `bufs` + `bufLen` — never
   * concatenated until a packet completes. This interface used to name `buf`
   * and a `chunks` that does not exist on either side, so the one assertion
   * that reads the pending state could only ever find `null`: it looked like a
   * guard on the patch and was a guard on nothing.
   */
  readonly buf?: Buffer | null
  readonly bufs?: readonly Buffer[]
  readonly bufLen?: number
}
// moleculer's `exports` map hides its `src/`, and the bundler reaches it by
// path, not by subpath — so this spec reaches it the same way the build does.
const PARSER_PATH = path.join(
  path.dirname(require_.resolve('moleculer')),
  'src/transporters/tcp/parser.js',
)
const Parser = require_(PARSER_PATH) as ParserCtor

interface CopyCensus {
  readonly bytes: () => number
  readonly restore: () => void
}

/**
 * Count every byte the parser COPIES, the same way it was counted on the hub:
 * by wrapping the two allocators `_write` can reach. A byte count is the only
 * honest measure here — wall time on a loaded CI box says nothing, and the
 * defect is quadratic in copied bytes, not in calls.
 */
function censusCopies(): CopyCensus {
  const realConcat = Buffer.concat
  const realFrom = Buffer.from
  let bytes = 0
  Buffer.concat = (list, total) => {
    let n = total
    if (typeof n !== 'number') {
      n = 0
      for (const b of list) n += b.length
    }
    bytes += n
    return realConcat(list, total)
  }
  // Documented type boundary: `Buffer.from` is overloaded many ways and a
  // delegating arrow cannot restate every overload. The proxy counts only the
  // single-Uint8Array form — the one `_write` reaches — and forwards the rest
  // untouched, so no signature is restated and nothing is asserted away.
  Buffer.from = new Proxy(realFrom, {
    apply(target, thisArg, args: readonly unknown[]): unknown {
      const first = args[0]
      if (args.length === 1 && first instanceof Uint8Array) bytes += first.length
      return Reflect.apply(target, thisArg, args)
    },
  })
  return {
    bytes: (): number => bytes,
    restore: (): void => {
      Buffer.concat = realConcat
      Buffer.from = realFrom
    },
  }
}

/** One packet on the wire, in moleculer's framing: crc, int32 length, type. */
function framePacket(type: number, payload: Buffer): Buffer {
  const length = payload.length + 6
  const packet = Buffer.allocUnsafe(length)
  packet.writeInt32BE(length, 1)
  packet.writeUInt8(type, 5)
  packet.writeUInt8(
    packet.readUInt8(1) ^
      packet.readUInt8(2) ^
      packet.readUInt8(3) ^
      packet.readUInt8(4) ^
      packet.readUInt8(5),
    0,
  )
  payload.copy(packet, 6)
  return packet
}

function chunksOf(buffer: Buffer, size: number): readonly Buffer[] {
  const out: Buffer[] = []
  for (let i = 0; i < buffer.length; i += size)
    out.push(buffer.subarray(i, Math.min(i + size, buffer.length)))
  return out
}

interface Received {
  readonly type: unknown
  readonly payload: Buffer
}

function feed(parser: ParserLike, chunks: readonly Buffer[]): readonly Received[] {
  const got: Received[] = []
  parser.on('data', (type: unknown, payload: Buffer): void => {
    got.push({ type, payload: Buffer.from(payload) })
  })
  for (const c of chunks) parser.write(c)
  return got
}

let census: CopyCensus | null = null
afterEach(() => {
  census?.restore()
  census = null
})

const PACKET_TYPE_REQUEST = 5

describe('the shipped moleculer TCP parser', () => {
  it('reassembles one message split across many chunks, whatever the chunk size', () => {
    const payload = Buffer.alloc(70_000, 0xab)
    const framed = framePacket(PACKET_TYPE_REQUEST, payload)
    for (const size of [1, 5, 6, 7, 1024, 8192, 65_536]) {
      const got = feed(new Parser(null), chunksOf(framed, size))
      expect(got.length, `chunk size ${size}`).toBe(1)
      expect(got[0]?.payload.equals(payload), `chunk size ${size}`).toBe(true)
    }
  })

  it('delivers several messages that arrive inside one chunk, in order', () => {
    const a = framePacket(PACKET_TYPE_REQUEST, Buffer.from('alpha'))
    const b = framePacket(PACKET_TYPE_REQUEST, Buffer.from('beta'))
    const c = framePacket(PACKET_TYPE_REQUEST, Buffer.from('gamma'))
    const got = feed(new Parser(null), [Buffer.concat([a, b, c])])
    expect(got.map((r) => r.payload.toString())).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('delivers a message whose 6-byte header is itself split across chunks', () => {
    const framed = framePacket(PACKET_TYPE_REQUEST, Buffer.from('split-header'))
    const got = feed(new Parser(null), [
      framed.subarray(0, 2),
      framed.subarray(2, 4),
      framed.subarray(4),
    ])
    expect(got.map((r) => r.payload.toString())).toEqual(['split-header'])
  })

  it('copies a bounded multiple of the message — not a multiple of its CHUNK COUNT', () => {
    // 4 MiB in 8 KiB chunks = 512 chunks. Upstream copies ~M²/c ≈ 1 GiB here;
    // a linear reassembly copies the message about once.
    const payload = Buffer.alloc(4 * 1024 * 1024, 0x5a)
    const framed = framePacket(PACKET_TYPE_REQUEST, payload)
    const chunks = chunksOf(framed, 8192)
    census = censusCopies()
    const got = feed(new Parser(null), chunks)
    const copied = census.bytes()
    expect(got.length).toBe(1)
    expect(got[0]?.payload.length).toBe(payload.length)
    // Three times the message is generous for a linear parser and two orders of
    // magnitude under the quadratic one; the bound must not be a ratio of the
    // chunk count, or it would move with the test's own chunk size.
    expect(copied).toBeLessThanOrEqual(framed.length * 3)
  })

  it('does not get cheaper per byte as the chunks get smaller — the copy cost is linear in BYTES', () => {
    const payload = Buffer.alloc(1024 * 1024, 0x31)
    const framed = framePacket(PACKET_TYPE_REQUEST, payload)
    const measure = (chunkSize: number): number => {
      const c = censusCopies()
      try {
        feed(new Parser(null), chunksOf(framed, chunkSize))
        return c.bytes()
      } finally {
        c.restore()
      }
    }
    const coarse = measure(65_536)
    const fine = measure(4096)
    // 16x more chunks. Quadratic gives ~16x more copying; linear gives ~the
    // same. Anything under 4x is unambiguously not quadratic.
    expect(fine).toBeLessThanOrEqual(coarse * 4)
  })

  it('still refuses a packet whose CRC does not match, and one over maxPacketSize', async () => {
    const refusalOf = async (parser: ParserLike, chunk: Buffer): Promise<string> => {
      let seen: Error | null = null
      parser.on('error', (err: Error): void => {
        seen = err
      })
      parser.write(chunk)
      // `_write` reports through its callback; Writable emits on a later tick.
      await new Promise<void>((resolve) => setImmediate(resolve))
      return String(seen)
    }

    const framed = framePacket(PACKET_TYPE_REQUEST, Buffer.from('corrupt'))
    const corrupted = Buffer.from(framed)
    corrupted.writeUInt8(corrupted.readUInt8(0) ^ 0xff, 0)
    expect(await refusalOf(new Parser(null), corrupted)).toContain('Invalid packet CRC')

    const big = framePacket(PACKET_TYPE_REQUEST, Buffer.alloc(4096, 1))
    expect(await refusalOf(new Parser(null, 1024), big)).toContain('maxPacketSize')
  })

  it('does not leave a small trailing remainder pinning a large backing store', () => {
    // A 2 MiB message followed by 3 bytes of the next one. If the remainder is
    // kept as a view into the 2 MiB buffer, those 3 bytes hold 2 MiB alive for
    // as long as the peer stays quiet — which on this cluster is the ordinary
    // case between two cross-node calls.
    const framed = framePacket(PACKET_TYPE_REQUEST, Buffer.alloc(2 * 1024 * 1024, 7))
    const next = framePacket(PACKET_TYPE_REQUEST, Buffer.from('next'))
    const parser = new Parser(null)
    const wire = Buffer.concat([framed, next.subarray(0, 3)])
    const got = feed(parser, [wire])
    expect(got.length).toBe(1)
    // D457 replaced the parser's single `buf` with a LIST of pending chunks
    // (`bufs` + `bufLen`) that is never concatenated until a packet completes —
    // that is the whole quadratic fix. This assertion still read `buf` /
    // `chunks`, fields the patched parser does not have, so it could only ever
    // fail: a guard that names the pre-patch shape is not guarding the patch.
    const pending = parser.bufs?.[0] ?? parser.buf ?? null
    expect(pending, 'the parser kept no trailing remainder at all').not.toBeNull()
    expect(parser.bufLen ?? pending?.length).toBe(3)
    expect(pending?.length).toBe(3)
    // What the remainder must NOT do is stay a view into the 2 MiB it arrived
    // in — that is the whole defect, and it is a statement about identity, not
    // about a number.
    expect(pending?.buffer).not.toBe(wire.buffer)
    // Where the copy LANDS is Node's Buffer pool, and the pool's size is an
    // ambient fact about the running Node, not about this parser: 8 KiB up to
    // v24.18.x and 64 KiB from v24.19.0. Spelling `65_536` here made the
    // assertion `expected 65536 to be less than 65536` on the CI runner
    // (v24.19.0) while it stayed green on a developer Mac (v24.17.0). Name the
    // fact instead of spelling it — D551.
    expect(pending?.buffer.byteLength ?? 0).toBeLessThanOrEqual(Buffer.poolSize)
  })
})
