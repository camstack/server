#!/usr/bin/env tsx
/**
 * What G.711 expansion costs where it does NOT happen today.
 *
 * D450 moved the audio chunk plane to the source RATE (8 kHz) but not to the
 * source FORMAT: `AudioRtpDecoder` still expands one G.711 byte into a 4-byte
 * f32le sample BEFORE the bytes enter the transport, so every leg of the plane
 * carries four times the source. Carrying the coded bytes and expanding next
 * to the consumer is a 4x cut on whichever legs it covers — IF the expansion
 * is free where it lands. This harness measures that rather than assuming it,
 * because "it is a lookup table, it must be negligible" is a story until a
 * number stands next to the transport cost it is traded against.
 *
 * Three expansion shapes, identical output asserted sample by sample, so a
 * number that got faster by doing less is caught rather than reported:
 *   A  per-RTP-packet expand   — what the broker does today (160 B at a time)
 *   B  per-window expand       — what a consumer would do (8000 B at once)
 *   C  no expand, copy only    — the accumulator's append with coded bytes
 *
 * Plus the transport side of the same window: msgpack encode+decode of the
 * 32 000-byte f32le payload against the 8 000-byte coded one — what each of
 * the plane's legs actually pays per window per camera.
 *
 * Usage:
 *   npx tsx scripts/bench-audio-g711-expand.mts [windows=20000]
 *
 * Exit 0 on success, throws if the two expansions disagree.
 */
import { performance } from 'node:perf_hooks'
import { encode, decode } from '@msgpack/msgpack'

const SAMPLE_RATE = 8000
const WINDOW_MS = 1000
const WINDOW_SAMPLES = (SAMPLE_RATE * WINDOW_MS) / 1000 // 8000
const RTP_PAYLOAD = 160 // 20 ms of G.711 at 8 kHz — the canonical packet
const CAMERAS = 22 // the fleet's native-G.711 cameras (D450)

/** Verbatim from `audio-rtp-decoder.ts` — the table both shapes share. */
function buildUlawTable(): Float32Array {
  const table = new Float32Array(256)
  for (let i = 0; i < 256; i++) {
    const c = ~i & 0xff
    const sign = (c & 0x80) !== 0 ? -1 : 1
    const exponent = (c >> 4) & 0x07
    const mantissa = c & 0x0f
    const magnitude = ((2 * mantissa + 33) << exponent) - 33
    table[i] = (sign * magnitude) / 32768
  }
  return table
}
const ULAW = buildUlawTable()

// One second of non-degenerate G.711 bytes. The table lookup cost does not
// depend on the values, but a constant buffer would let a JIT fold the loop.
const coded = new Uint8Array(WINDOW_SAMPLES)
for (let i = 0; i < WINDOW_SAMPLES; i++) coded[i] = (i * 37 + ((i / 7) | 0)) & 0xff

/** A — the broker's shape: expand each RTP payload as it arrives, append. */
function expandPerPacket(src: Uint8Array): Float32Array {
  const out = new Float32Array(src.length)
  let o = 0
  for (let p = 0; p < src.length; p += RTP_PAYLOAD) {
    const end = Math.min(p + RTP_PAYLOAD, src.length)
    for (let i = p; i < end; i++) out[o++] = ULAW[src[i]!]!
  }
  return out
}

/** B — the consumer's shape: expand the whole window at once. */
function expandWindow(src: Uint8Array): Float32Array {
  const out = new Float32Array(src.length)
  for (let i = 0; i < src.length; i++) out[i] = ULAW[src[i]!]!
  return out
}

/** C — no expansion: the accumulator's copy-and-append of coded bytes. */
function copyOnly(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src.length)
  out.set(src)
  return out
}

/** D — the floor both expansions stand on: the 32 KB Float32Array itself. */
function allocOnly(src: Uint8Array): Float32Array {
  return new Float32Array(src.length)
}

/**
 * Best of `rounds` passes, and every shape is re-run in every round. A shape
 * measured once, in a fixed order, reports the JIT's warm-up and the previous
 * shape's garbage as if they belonged to it — which is how "the batched loop
 * is twice the cost of the per-packet loop doing identical work" happens.
 */
function bench(label: string, n: number, rounds: number, fn: () => void): number {
  let best = Infinity
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < 200; i++) fn() // warm
    const t0 = performance.now()
    for (let i = 0; i < n; i++) fn()
    const ms = performance.now() - t0
    if (ms < best) best = ms
  }
  console.log(
    `${label.padEnd(38)} ${((best / n) * 1000).toFixed(2).padStart(8)} us/window   ` +
      `${best.toFixed(0).padStart(6)} ms / ${n} (best of ${rounds})`,
  )
  return best / n
}

const n = Number(process.argv[2] ?? 20000)

const a = expandPerPacket(coded)
const b = expandWindow(coded)
if (a.length !== b.length) throw new Error('length mismatch')
for (let i = 0; i < a.length; i++) {
  if (a[i] !== b[i]) throw new Error(`sample ${i} differs: ${a[i]} vs ${b[i]}`)
}
console.log(`identical output over ${a.length} samples\n`)

const ROUNDS = 5

console.log('— expansion, per 1 s window of one camera —')
const msA = bench('A  broker: expand per RTP packet', n, ROUNDS, () => expandPerPacket(coded))
const msB = bench('B  consumer: expand whole window', n, ROUNDS, () => expandWindow(coded))
bench('C  accumulator: copy coded bytes', n, ROUNDS, () => copyOnly(coded))
bench('D  floor: allocate the Float32Array', n, ROUNDS, () => allocOnly(coded))

console.log('\n— transport, per 1 s window of one camera —')
const f32 = expandWindow(coded)
const f32Bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength)
const wideMsg = { data: f32Bytes, sampleRate: 8000, channels: 1, timestamp: 1 }
const codedMsg = { data: coded, sampleRate: 8000, channels: 1, timestamp: 1, format: 'pcmu' }
const wideEnc = encode(wideMsg)
const codedEnc = encode(codedMsg)
console.log(`   f32le window on the wire            ${wideEnc.length} bytes`)
console.log(`   coded window on the wire            ${codedEnc.length} bytes`)
const msW = bench('   msgpack encode+decode f32le', n, ROUNDS, () => {
  decode(encode(wideMsg))
})
const msK = bench('   msgpack encode+decode coded', n, ROUNDS, () => {
  decode(encode(codedMsg))
})

console.log('\n— per minute, 22 cameras, one leg —')
const perMin = (msPerWindow: number): string => (msPerWindow * 60 * CAMERAS).toFixed(0)
console.log(`   expansion (B) once, somewhere       ${perMin(msB)} ms/min of one core`)
console.log(`   msgpack f32le, per leg              ${perMin(msW)} ms/min`)
console.log(`   msgpack coded, per leg              ${perMin(msK)} ms/min`)
console.log(
  `   bytes f32le, per leg                ${((wideEnc.length * 60 * CAMERAS) / 1e6).toFixed(1)} MB/min`,
)
console.log(
  `   bytes coded, per leg                ${((codedEnc.length * 60 * CAMERAS) / 1e6).toFixed(1)} MB/min`,
)
console.log(`\n   expansion as a share of ONE leg's msgpack: ${((msB / msW) * 100).toFixed(1)} %`)
console.log(
  `   expansion MOVED, not added (B - A):  ${((msB - msA) * 60 * CAMERAS).toFixed(0)} ms/min` +
    ` — the broker pays A today and stops paying it`,
)
