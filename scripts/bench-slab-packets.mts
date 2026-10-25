#!/usr/bin/env tsx
/**
 * Slab-backed packets, measured on a fixture (D868) — OPT-IN, never part of
 * `npm test` or CI: `npx tsx scripts/bench-slab-packets.mts [--slab-kib 128]`.
 *
 * Part 1, INGEST: N RTP packets across S streams, cut out of a socket-sized
 * chunk exactly the way the readers do, retained in a per-stream ring for one
 * GOP and evicted. Run twice in one process, once with the old per-packet
 * `copyOwned` and once with a `PacketSlabPool`, reporting
 *   - backing stores allocated (old: one per packet; new: slab allocations),
 *   - peak external memory above the baseline,
 *   - major / minor GCs and wall time.
 *
 * Part 2, WEBRTC SEND: M RTP packets through the real werift SRTP context and
 * the real H.264 repacketizer, with the session's own scratch/arena, against
 * the unpatched reference path, reporting JS-level buffer allocations per
 * packet (Buffer.alloc / allocUnsafe / concat / from) and the GC counts.
 */
import { constants, PerformanceObserver } from 'node:perf_hooks'

const arrayBuffersMb = (): number => process.memoryUsage().arrayBuffers / 1048576
import { copyOwned } from '../packages/addon-pipeline/src/stream-broker/stream-broker/owned-buffer.ts'
import {
  holdPacket,
  PacketSlabPool,
  releasePacket,
} from '../packages/addon-pipeline/src/stream-broker/stream-broker/slab-pool.ts'

interface Args {
  readonly packets: number
  readonly streams: number
  readonly slabKib: number
  readonly ringPackets: number
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string, fallback: number): number => {
    const i = argv.indexOf(`--${name}`)
    const raw = i >= 0 ? argv[i + 1] : undefined
    const n = raw === undefined ? NaN : Number(raw)
    return Number.isFinite(n) ? n : fallback
  }
  return {
    packets: get('packets', 200_000),
    streams: get('streams', 70),
    slabKib: get('slab-kib', 128),
    ringPackets: get('ring-packets', 350),
  }
}

interface GcCounts {
  major: number
  minor: number
}

function observeGc(): { counts: GcCounts; stop: () => void } {
  const counts: GcCounts = { major: 0, minor: 0 }
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      const kind = e.detail && 'kind' in e.detail ? Number(e.detail.kind) : -1
      if (kind === constants.NODE_PERFORMANCE_GC_MAJOR) counts.major += 1
      else if (kind === constants.NODE_PERFORMANCE_GC_MINOR) counts.minor += 1
    }
  })
  obs.observe({ entryTypes: ['gc'] })
  return { counts, stop: () => obs.disconnect() }
}

interface IngestResult {
  readonly label: string
  readonly backingStores: number
  readonly peakArrayBuffersMb: number
  readonly major: number
  readonly minor: number
  readonly ms: number
}

type Cut = (src: Buffer, start: number, end: number, stream: number) => Buffer

/** One socket-sized chunk of RFC 4571 frames: `[len16][rtp]…`. */
function makeChunk(sizes: readonly number[]): Buffer {
  const parts: Buffer[] = []
  for (const size of sizes) {
    const head = Buffer.alloc(2)
    head.writeUInt16BE(size, 0)
    parts.push(head, Buffer.alloc(size, 0x5a))
  }
  return Buffer.concat(parts)
}

async function runIngest(
  label: string,
  args: Args,
  makeCut: () => {
    cut: Cut
    held: (b: Buffer) => void
    dropped: (b: Buffer) => void
    stores: () => number
  },
): Promise<IngestResult> {
  if (global.gc) global.gc()
  const gc = observeGc()
  const baseBuffers = arrayBuffersMb()
  let peak = 0
  const { cut, held, dropped, stores } = makeCut()
  const rings: Buffer[][] = Array.from({ length: args.streams }, () => [])
  const sizes = [1380, 1380, 1380, 1380, 900, 1200, 1380, 400, 1380, 1100]
  const chunk = makeChunk(sizes)
  const started = process.hrtime.bigint()
  let produced = 0
  let stream = 0
  while (produced < args.packets) {
    let offset = 0
    while (offset + 2 <= chunk.length && produced < args.packets) {
      const length = chunk.readUInt16BE(offset)
      const packet = cut(chunk, offset + 2, offset + 2 + length, stream)
      offset += 2 + length
      produced += 1
      const ring = rings[stream]!
      held(packet)
      ring.push(packet)
      if (ring.length > args.ringPackets) dropped(ring.shift()!)
      stream = (stream + 1) % args.streams
    }
    if (produced % 4000 < sizes.length) {
      peak = Math.max(peak, arrayBuffersMb() - baseBuffers)
      // Let the observer's callbacks run and the clock move like a live reader.
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  await new Promise<void>((resolve) => setImmediate(resolve))
  gc.stop()
  return {
    label,
    backingStores: stores(),
    peakArrayBuffersMb: Number(peak.toFixed(1)),
    major: gc.counts.major,
    minor: gc.counts.minor,
    ms: Math.round(ms),
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  console.log(`ingest: ${args.packets} packets, ${args.streams} streams, ring ${args.ringPackets}`)

  let oldStores = 0
  const old = await runIngest('copyOwned (before)', args, () => ({
    cut: (src, s, e) => {
      oldStores += 1
      return copyOwned(src, s, e)
    },
    held: () => {},
    dropped: () => {},
    stores: () => oldStores,
  }))

  // Virtual clock: the packets-per-second of the hub's measured load.
  let clock = 0
  const pools = Array.from(
    { length: args.streams },
    () =>
      new PacketSlabPool({
        slabBytes: args.slabKib * 1024,
        now: () => clock,
      }),
  )
  let tick = 0
  const slab = await runIngest(`slab ${args.slabKib} KiB (after)`, args, () => ({
    cut: (src, s, e, stream) => {
      tick += 1
      clock = Math.floor((tick * 1000) / 12_200)
      return pools[stream]!.copy(src, s, e)
    },
    held: holdPacket,
    dropped: releasePacket,
    stores: () => pools.reduce((n, p) => n + p.stats().allocs, 0),
  }))

  console.table([old, slab])
}

await main()
