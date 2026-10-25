#!/usr/bin/env tsx
/**
 * Moleculer TCP `Parser._write` — the quadratic accumulator on the MESH plane.
 *
 * Why this exists: a 50 s V8 CPU profile of hub-main (2026-09-11, D456) put
 * **20.8 % of the busy main thread** in one `_write` — Moleculer's TCP
 * transporter `Parser`, reached through `Readable.pipe`. It accumulates a
 * partial packet with `Buffer.concat([this.buf, chunk])` AND then re-copies
 * the whole remainder with `Buffer.from(packet)`, once per socket chunk that
 * leaves a partial. Claimed quadratic in the chunk count; this harness is the
 * experiment that decides it, because the claim came from a profile rather
 * than from a measurement of the shape itself.
 *
 * What it runs:
 *   - `LegacyParser` — a VERBATIM copy of `moleculer/src/transporters/tcp/parser.js`
 *     as shipped in 0.14.x, kept here and nowhere else so the A/B is against
 *     real code rather than a description of it.
 *   - the LIVE `moleculer` parser out of `node_modules` — i.e. the patched one
 *     once `patches/moleculer+*.patch` is applied. If the patch is missing the
 *     two columns are identical, which is itself the reading.
 *   - a FLOOR that does nothing but allocate and hand over the same chunks,
 *     so "how much of this is the harness" is answered rather than assumed.
 *
 * Method (a benchmark written in a hurry lies):
 *   - best-of-N per cell, not a single pass;
 *   - the two implementations ALTERNATE per iteration, so a warm-up or a GC
 *     cycle cannot land on one of them systematically;
 *   - identical byte streams, and the emitted message count is compared — a
 *     number that got faster by parsing less is caught, not reported.
 *
 * The quadratic prediction, stated before the run: for a message of M bytes in
 * chunks of c, copy volume is ~M²/c. So with M fixed, HALVING c must DOUBLE
 * the time. A flat row disproves the claim.
 *
 * Usage:
 *   npx tsx scripts/bench-moleculer-tcp-parser.mts [best-of=7]
 *
 * Exit 0 on success, 1 if the parsers disagree on what they parsed.
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'

const require = createRequire(import.meta.url)

/**
 * `moleculer`'s `exports` map does not expose `./src/**`, so the parser is
 * reached by path off the package's resolved main. This is the SAME file the
 * bundler inlines into `@camstack/system/dist/index.js` — the parser is not a
 * runtime dependency on the hub, it is bundled — so patching it here patches
 * what ships.
 */
const MOLECULER_ROOT = dirname(require.resolve('moleculer'))
const PARSER_PATH = join(MOLECULER_ROOT, 'src', 'transporters', 'tcp', 'parser.js')

interface ParserLike {
  write(chunk: Buffer): void
  on(event: string, handler: (...args: unknown[]) => void): void
}

interface ParserCtor {
  new (options: Record<string, unknown>, maxPacketSize: number): ParserLike
}

const LiveParser = require(PARSER_PATH) as ParserCtor

/**
 * The ORIGINAL `_write`, preserved verbatim. Extends the live class so only
 * the accumulator differs — `resolvePacketType`, the CRC and the event shape
 * are shared with the implementation under test.
 */
class LegacyParser extends (LiveParser as unknown as new (
  options: Record<string, unknown>,
  maxPacketSize: number,
) => {
  maxPacketSize: number
  buf: Buffer | null
  emit(event: string, ...args: unknown[]): boolean
}) {
  _write(chunk: Buffer, _encoding: string, cb: (err?: Error) => void): void {
    let packet = chunk
    if (this.buf && this.buf.length > 0) {
      packet = Buffer.concat([this.buf, chunk])
      this.buf = null
    }

    while (packet.length > 0) {
      if (packet.length < 6) {
        this.buf = Buffer.from(packet)
        return cb()
      }

      if (this.maxPacketSize && packet.length > this.maxPacketSize) {
        return cb(new Error(`Incoming packet is larger than the 'maxPacketSize' limit!`))
      }

      const crc = packet[1]! ^ packet[2]! ^ packet[3]! ^ packet[4]! ^ packet[5]!
      if (crc !== packet[0]) return cb(new Error(`Invalid packet CRC! ${crc}`))

      const length = packet.readInt32BE(1)

      if (packet.length >= length) {
        const msg = packet.slice(6, length)
        this.emit('data', 'REQ', msg)
        packet = packet.slice(length)
      } else {
        this.buf = Buffer.from(packet)
        return cb()
      }
    }
    cb()
  }
}

/** One Moleculer TCP frame: 1 CRC byte, 4-byte BE length, 1 type byte, payload. */
function buildPacket(payloadBytes: number): Buffer {
  const length = 6 + payloadBytes
  const packet = Buffer.allocUnsafe(length)
  packet.writeInt32BE(length, 1)
  packet[5] = 5 // an arbitrary valid type byte
  packet[0] = packet[1]! ^ packet[2]! ^ packet[3]! ^ packet[4]! ^ packet[5]!
  packet.fill(0x42, 6)
  return packet
}

function chunksOf(packet: Buffer, chunkBytes: number): Buffer[] {
  const out: Buffer[] = []
  for (let off = 0; off < packet.length; off += chunkBytes) {
    // A copy, so the parser never gets a view that aliases another chunk —
    // this is what a socket hands over.
    out.push(Buffer.from(packet.subarray(off, Math.min(off + chunkBytes, packet.length))))
  }
  return out
}

interface Run {
  readonly ms: number
  readonly messages: number
}

function runParser(Ctor: ParserCtor, chunks: readonly Buffer[]): Run {
  const parser = new Ctor({}, 0)
  let messages = 0
  parser.on('data', () => {
    messages += 1
  })
  const t0 = performance.now()
  for (const chunk of chunks) parser.write(chunk)
  const ms = performance.now() - t0
  return { ms, messages }
}

/** Floor: the same chunks, handed to a sink that only retains them. */
function runFloor(chunks: readonly Buffer[]): Run {
  const held: Buffer[] = []
  const t0 = performance.now()
  for (const chunk of chunks) held.push(chunk)
  const ms = performance.now() - t0
  if (held.length === 0) throw new Error('unreachable')
  return { ms, messages: 0 }
}

function main(): void {
  const bestOf = Number(process.argv[2] ?? 7)
  const payloadMib = 4
  const payloadBytes = payloadMib * 1024 * 1024
  const packet = buildPacket(payloadBytes)
  const chunkSizes = [65536, 32768, 16384, 8192, 4096]

  process.stdout.write(
    `moleculer TCP Parser — one ${payloadMib} MiB packet, best-of-${bestOf}, alternating order\n\n`,
  )
  process.stdout.write(
    `${'chunk'.padStart(8)} ${'N'.padStart(6)} ${'legacy ms'.padStart(11)} ${'live ms'.padStart(10)} ${'floor ms'.padStart(9)} ${'ratio'.padStart(7)}\n`,
  )

  let previousLegacy: number | null = null
  let disagreed = false

  for (const chunkBytes of chunkSizes) {
    const chunks = chunksOf(packet, chunkBytes)
    let bestLegacy = Number.POSITIVE_INFINITY
    let bestLive = Number.POSITIVE_INFINITY
    let bestFloor = Number.POSITIVE_INFINITY
    let legacyMessages = -1
    let liveMessages = -1

    for (let i = 0; i < bestOf; i += 1) {
      // Alternate which implementation goes first on every iteration.
      const legacyFirst = i % 2 === 0
      const a = (): void => {
        const r = runParser(LegacyParser as unknown as ParserCtor, chunks)
        bestLegacy = Math.min(bestLegacy, r.ms)
        legacyMessages = r.messages
      }
      const b = (): void => {
        const r = runParser(LiveParser, chunks)
        bestLive = Math.min(bestLive, r.ms)
        liveMessages = r.messages
      }
      if (legacyFirst) {
        a()
        b()
      } else {
        b()
        a()
      }
      bestFloor = Math.min(bestFloor, runFloor(chunks).ms)
    }

    if (legacyMessages !== liveMessages) disagreed = true

    const growth = previousLegacy === null ? '—' : `${(bestLegacy / previousLegacy).toFixed(2)}×`
    previousLegacy = bestLegacy

    process.stdout.write(
      `${`${chunkBytes / 1024}K`.padStart(8)} ${String(chunks.length).padStart(6)} ${bestLegacy.toFixed(2).padStart(11)} ${bestLive.toFixed(2).padStart(10)} ${bestFloor.toFixed(3).padStart(9)} ${growth.padStart(7)}\n`,
    )
  }

  process.stdout.write(
    `\n"ratio" is legacy(this row) / legacy(previous row). The chunk size halves\n` +
      `every row, so a quadratic accumulator reads ~2.00×; a linear one reads ~1.00×.\n`,
  )

  if (disagreed) {
    process.stderr.write('\nFAIL: the two parsers emitted different message counts\n')
    process.exit(1)
  }
}

main()
