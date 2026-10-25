/**
 * The MESH plane's packet reassembly — Moleculer's TCP transporter `Parser`.
 *
 * This is the only place in the repo that tests code we do not own. It is
 * here because `patches/moleculer+<version>.patch` changes that code, and the
 * parser is **bundled** into `@camstack/system/dist/index.js` rather than
 * resolved at runtime on the hub — so the patch is not a development
 * convenience, it is part of the shipped artifact and it must have a guard
 * that goes red when it is missing.
 *
 * What it guards, and why (D457):
 *  - the accumulator does NOT re-copy the pending remainder per chunk. The
 *    shipped implementation did `Buffer.concat([this.buf, chunk])` AND
 *    `Buffer.from(packet)` once per partial chunk, which is quadratic in the
 *    chunk count of a large cross-node message. Measured at **20.8 % of
 *    hub-main's busy main thread** (D456) and reproduced in
 *    `scripts/bench-moleculer-tcp-parser.mts`, where halving the chunk size
 *    doubles the time.
 *  - and it still parses exactly what it parsed before. A faster parser that
 *    parses less is the failure this file exists to catch, so every framing
 *    case the original handled is asserted alongside the copy accounting.
 *
 * The copy accounting is deliberately STRUCTURAL rather than timed: a
 * threshold on a duration is a flaky guard, and `Buffer.concat` call count is
 * the property the fix is actually about.
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)

/**
 * `moleculer`'s `exports` map does not expose `./src/**`, so the parser is
 * reached by path off the package's resolved main — the same file the bundler
 * inlines into `dist/index.js`.
 */
const PARSER_PATH = join(
  dirname(require.resolve('moleculer')),
  'src',
  'transporters',
  'tcp',
  'parser.js',
)

interface ParserLike {
  write(chunk: Buffer): void
  on(event: string, handler: (type: string, msg: Buffer) => void): void
  once(event: string, handler: (err: Error) => void): void
}

interface ParserCtor {
  new (options: Record<string, unknown>, maxPacketSize: number): ParserLike
}

const Parser = require(PARSER_PATH) as ParserCtor

const { resolvePacketType } = require(
  join(dirname(require.resolve('moleculer')), 'src', 'transporters', 'tcp', 'constants.js'),
) as { resolvePacketType: (byte: number) => string }

/** Moleculer TCP framing: CRC byte, 4-byte BE total length, type byte, payload. */
const HEADER_BYTES = 6

/** An arbitrary REAL type byte; the name it resolves to is asserted, never assumed. */
const TYPE_BYTE = 5

/**
 * A `Writable` reports a `cb(err)` on the next tick, not inside `write()`.
 * Every error assertion here waits for it — a synchronous `expect` on the
 * error array passes vacuously whether the parser refused or accepted.
 */
const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function buildPacket(payload: Buffer, typeByte: number = TYPE_BYTE): Buffer {
  const total = HEADER_BYTES + payload.length
  const packet = Buffer.allocUnsafe(total)
  packet.writeInt32BE(total, 1)
  packet[5] = typeByte
  packet[0] = packet[1]! ^ packet[2]! ^ packet[3]! ^ packet[4]! ^ packet[5]!
  payload.copy(packet, HEADER_BYTES)
  return packet
}

function chunksOf(buf: Buffer, chunkBytes: number): Buffer[] {
  const out: Buffer[] = []
  for (let off = 0; off < buf.length; off += chunkBytes) {
    // A copy per chunk, which is what a socket hands over — never a view that
    // aliases a neighbour.
    out.push(Buffer.from(buf.subarray(off, Math.min(off + chunkBytes, buf.length))))
  }
  return out
}

interface Collected {
  readonly parser: ParserLike
  readonly messages: Buffer[]
  readonly types: string[]
  readonly errors: Error[]
}

function collect(maxPacketSize = 0): Collected {
  const messages: Buffer[] = []
  const types: string[] = []
  const errors: Error[] = []
  const parser = new Parser({}, maxPacketSize)
  parser.on('data', (type, msg) => {
    types.push(type)
    messages.push(Buffer.from(msg))
  })
  parser.on('error', (err) => {
    errors.push(err as unknown as Error)
  })
  return { parser, messages, types, errors }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('mesh TCP parser — framing is unchanged', () => {
  it('parses three packets delivered in one chunk', () => {
    const c = collect()
    const payloads = [Buffer.from('alpha'), Buffer.from('beta'), Buffer.from('gamma-gamma')]
    c.parser.write(Buffer.concat(payloads.map((p) => buildPacket(p))))

    expect(c.messages.map((m) => m.toString())).toEqual(['alpha', 'beta', 'gamma-gamma'])
    expect(c.errors).toEqual([])
  })

  it('parses a packet whose 6-byte header straddles two chunks', () => {
    const c = collect()
    const packet = buildPacket(Buffer.from('straddled'))
    // 3 bytes is less than the header — the parser cannot even read the length.
    c.parser.write(packet.subarray(0, 3))
    expect(c.messages).toEqual([])
    c.parser.write(packet.subarray(3))

    expect(c.messages.map((m) => m.toString())).toEqual(['straddled'])
    expect(c.errors).toEqual([])
  })

  it('reassembles one packet delivered in many chunks, byte for byte', () => {
    const c = collect()
    const payload = Buffer.alloc(40_000)
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251
    for (const chunk of chunksOf(buildPacket(payload), 1024)) c.parser.write(chunk)

    expect(c.messages).toHaveLength(1)
    expect(c.messages[0]!.equals(payload)).toBe(true)
    expect(c.types[0]).toBe(resolvePacketType(TYPE_BYTE))
  })

  it('keeps a trailing partial and completes it from the next chunk', () => {
    const c = collect()
    const first = buildPacket(Buffer.from('first'))
    const second = buildPacket(Buffer.from('second'))
    const stream = Buffer.concat([first, second])
    // Cut mid-way through the SECOND packet's payload.
    const cut = first.length + HEADER_BYTES + 2
    c.parser.write(stream.subarray(0, cut))
    expect(c.messages.map((m) => m.toString())).toEqual(['first'])
    c.parser.write(stream.subarray(cut))

    expect(c.messages.map((m) => m.toString())).toEqual(['first', 'second'])
  })

  it('reports a bad CRC as an error, not as a message', async () => {
    const c = collect()
    const packet = buildPacket(Buffer.from('corrupt'))
    packet[0] = packet[0]! ^ 0xff
    c.parser.write(packet)
    await nextTick()

    expect(c.messages).toEqual([])
    expect(c.errors).toHaveLength(1)
    expect(c.errors[0]!.message).toContain('Invalid packet CRC')
  })

  it('refuses accumulated bytes past maxPacketSize', async () => {
    const c = collect(1024)
    // 2 KiB of pending bytes, declared as one packet larger than the limit.
    const packet = buildPacket(Buffer.alloc(2048))
    c.parser.write(packet)
    await nextTick()

    expect(c.messages).toEqual([])
    expect(c.errors).toHaveLength(1)
    expect(c.errors[0]!.message).toContain('maxPacketSize')
  })

  it('measures maxPacketSize against the ACCUMULATED bytes, not the declared length', async () => {
    // Two packets of 600 B each, delivered together, under a 1 KiB limit.
    // Neither DECLARES more than the limit; together they exceed it, and the
    // implementation this replaces refused — it compared the pending buffer's
    // length. Pinned because it is the one rule an accumulator rewrite is most
    // likely to "clean up" into something quieter.
    const c = collect(1024)
    const a = buildPacket(Buffer.alloc(600 - HEADER_BYTES))
    const b = buildPacket(Buffer.alloc(600 - HEADER_BYTES))
    c.parser.write(Buffer.concat([a, b]))
    await nextTick()

    expect(c.errors).toHaveLength(1)
    expect(c.errors[0]!.message).toContain('maxPacketSize')
  })
})

describe('mesh TCP parser — the accumulator is not quadratic', () => {
  it('concatenates a many-chunk packet ONCE, not once per chunk', () => {
    const concat = vi.spyOn(Buffer, 'concat')
    const c = collect()
    const payload = Buffer.alloc(4 * 1024 * 1024)
    const chunks = chunksOf(buildPacket(payload), 64 * 1024)
    expect(chunks.length).toBeGreaterThan(60)

    for (const chunk of chunks) c.parser.write(chunk)

    expect(c.messages).toHaveLength(1)
    expect(c.messages[0]!.length).toBe(payload.length)

    // The shipped accumulator concatenated on every chunk that left a partial:
    // 64 calls, ~132 MiB of copying for a 4 MiB message. One concat per
    // COMPLETED packet is the whole fix; the bound is generous so a future
    // implementation that flattens twice is still accepted, while a per-chunk
    // one is not.
    expect(concat.mock.calls.length).toBeLessThanOrEqual(2)
    const bytesConcatenated = concat.mock.calls.reduce<number>((sum, [list]) => {
      for (const b of list as readonly Uint8Array[]) sum += b.length
      return sum
    }, 0)
    expect(bytesConcatenated).toBeLessThanOrEqual(2 * (payload.length + HEADER_BYTES))
  })

  it('does not copy the pending remainder while a packet is still incomplete', () => {
    const c = collect()
    const payload = Buffer.alloc(300_000)
    const chunks = chunksOf(buildPacket(payload), 8192)
    // Everything but the last chunk: the packet is never completable, so a
    // correct accumulator does no copying at all here.
    const concat = vi.spyOn(Buffer, 'concat')
    for (const chunk of chunks.slice(0, -1)) c.parser.write(chunk)

    expect(c.messages).toEqual([])
    expect(concat.mock.calls.length).toBe(0)
  })
})
