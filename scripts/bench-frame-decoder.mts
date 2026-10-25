#!/usr/bin/env tsx
/**
 * UDS `FrameDecoder` throughput — the quadratic accumulator, and the fix.
 *
 * Why this exists: the hub's UDS transport reassembles every parent↔child
 * frame through `FrameDecoder.push`. The original accumulator did
 * `Buffer.concat([this.buf, chunk])` ONCE PER SOCKET CHUNK, so a frame of N
 * bytes arriving in C-byte pieces copied ~N²/2C bytes on the main thread.
 * Media transits this router constantly (native crops, key frames, snapshot
 * blobs), and the hub's main thread was measured busy 82.2 s out of 120.
 *
 * This harness runs BOTH implementations over identical byte streams:
 *   - `LegacyFrameDecoder` — a verbatim copy of the original, kept here and
 *     nowhere else, so the comparison is against real code rather than a
 *     description of it.
 *   - `FrameDecoder` — the shipped implementation.
 * It also asserts both produce identical frame counts, so a number that got
 * faster by decoding less is caught rather than reported.
 *
 * Usage:
 *   npx tsx scripts/bench-frame-decoder.mts [iterations=20]
 *
 * Exit 0 on success, 1 if the two decoders disagree.
 */
import { performance } from 'node:perf_hooks'
import { decode } from '@msgpack/msgpack'
import { encodeFrame, FrameDecoder } from '../packages/system/src/kernel/transport/frame-codec.ts'

/** The ORIGINAL accumulator, preserved verbatim for the A/B. */
class LegacyFrameDecoder {
  private buf: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): unknown[] {
    this.buf = this.buf.byteLength === 0 ? chunk : Buffer.concat([this.buf, chunk])
    const frames: unknown[] = []
    while (this.buf.byteLength >= 4) {
      const len = this.buf.readUInt32BE(0)
      if (this.buf.byteLength < 4 + len) break
      frames.push(decode(this.buf.subarray(4, 4 + len)))
      this.buf = this.buf.subarray(4 + len)
    }
    return frames
  }
}

interface Decoderish {
  push(chunk: Buffer): unknown[]
}

interface Scenario {
  readonly name: string
  /** One encoded frame stream. */
  readonly stream: Buffer
  /** Socket delivery size in bytes. */
  readonly chunkBytes: number
}

interface Sample {
  readonly meanMs: number
  readonly minMs: number
  readonly maxMs: number
  readonly frames: number
}

const CHUNK_64K = 64 * 1024

function payload(size: number): Uint8Array {
  const out = new Uint8Array(size)
  for (let i = 0; i < size; i++) out[i] = (i * 31) & 0xff
  return out
}

function buildScenarios(): readonly Scenario[] {
  const oneFrame = (bytes: number): Buffer => encodeFrame({ k: 'evt', body: payload(bytes) })
  const many = (count: number, bytes: number): Buffer =>
    Buffer.concat(
      Array.from({ length: count }, () => encodeFrame({ k: 'evt', body: payload(bytes) })),
    )
  return [
    { name: '256 KiB frame  / 64 KiB chunks', stream: oneFrame(256 * 1024), chunkBytes: CHUNK_64K },
    {
      name: '1 MiB frame    / 64 KiB chunks',
      stream: oneFrame(1024 * 1024),
      chunkBytes: CHUNK_64K,
    },
    {
      name: '4 MiB frame    / 64 KiB chunks',
      stream: oneFrame(4 * 1024 * 1024),
      chunkBytes: CHUNK_64K,
    },
    {
      name: '8 MiB frame    / 64 KiB chunks',
      stream: oneFrame(8 * 1024 * 1024),
      chunkBytes: CHUNK_64K,
    },
    {
      name: '4 MiB frame    / 16 KiB chunks',
      stream: oneFrame(4 * 1024 * 1024),
      chunkBytes: 16 * 1024,
    },
    { name: '2000 small cap calls (1 chunk)', stream: many(2000, 64), chunkBytes: 1 << 30 },
    { name: '200 x 32 KiB   / 64 KiB chunks', stream: many(200, 32 * 1024), chunkBytes: CHUNK_64K },
  ]
}

function split(buf: Buffer, size: number): readonly Buffer[] {
  const out: Buffer[] = []
  for (let i = 0; i < buf.byteLength; i += size) out.push(buf.subarray(i, i + size))
  return out
}

function run(make: () => Decoderish, chunks: readonly Buffer[], iterations: number): Sample {
  // One untimed pass to let the JIT settle.
  let frames = 0
  {
    const dec = make()
    for (const c of chunks) frames += dec.push(c).length
  }
  const timings: number[] = []
  for (let i = 0; i < iterations; i++) {
    const dec = make()
    const t0 = performance.now()
    let n = 0
    for (const c of chunks) n += dec.push(c).length
    timings.push(performance.now() - t0)
    if (n !== frames) throw new Error(`unstable frame count: ${n} vs ${frames}`)
  }
  const sum = timings.reduce((a, b) => a + b, 0)
  return {
    meanMs: sum / timings.length,
    minMs: Math.min(...timings),
    maxMs: Math.max(...timings),
    frames,
  }
}

function fmt(ms: number): string {
  return ms.toFixed(3).padStart(9)
}

function main(): number {
  const iterations = Number(process.argv[2] ?? 20)
  const scenarios = buildScenarios()
  let mismatch = false

  process.stdout.write(
    `FrameDecoder A/B — ${iterations} iterations per scenario, node ${process.version}\n\n`,
  )
  process.stdout.write(
    `${'scenario'.padEnd(32)} ${'old mean'.padStart(9)} ${'new mean'.padStart(9)} ` +
      `${'speedup'.padStart(8)} ${'frames'.padStart(7)}\n`,
  )
  process.stdout.write(
    `${'-'.repeat(32)} ${'-'.repeat(9)} ${'-'.repeat(9)} ${'-'.repeat(8)} ${'-'.repeat(7)}\n`,
  )

  for (const s of scenarios) {
    const chunks = split(s.stream, s.chunkBytes)
    const legacy = run(() => new LegacyFrameDecoder(), chunks, iterations)
    const next = run(() => new FrameDecoder(), chunks, iterations)
    if (legacy.frames !== next.frames) {
      mismatch = true
      process.stderr.write(
        `MISMATCH in "${s.name}": old decoded ${legacy.frames} frames, new decoded ${next.frames}\n`,
      )
    }
    const speedup = legacy.meanMs / next.meanMs
    process.stdout.write(
      `${s.name.padEnd(32)} ${fmt(legacy.meanMs)} ${fmt(next.meanMs)} ` +
        `${`${speedup.toFixed(2)}x`.padStart(8)} ${String(next.frames).padStart(7)}\n`,
    )
  }

  process.stdout.write(
    '\nold = Buffer.concat per socket chunk (quadratic) · new = accumulate chunks, concat once per frame\n',
  )
  return mismatch ? 1 : 0
}

process.exit(main())
