#!/usr/bin/env tsx
/**
 * WebRTC send path, measured on a fixture (D868) — OPT-IN, never part of
 * `npm test` or CI:
 *
 *   npx tsx scripts/bench-webrtc-send-path.mts [--packets 100000]
 *   npx tsx scripts/bench-webrtc-send-path.mts --repacketizer <path-to-an-older-h264-repacketizer.ts>
 *
 * Counts the JS-level Buffer allocations the send path makes per outgoing
 * packet (`Buffer.alloc` / `allocUnsafe` / `allocUnsafeSlow` / `concat` /
 * `from`) and the ArrayBuffers behind them, for
 *   - the real H.264 repacketizer (a GOP of FU-A, an oversized NAL and small
 *     NALs, MTU 1200), and
 *   - SRTP protection of 1.2 KB packets, for both ciphers, through werift's
 *     `SrtpSession.encrypt`: `--werift <dir of an unpacked werift@0.22.9
 *     tarball>` for the published code, nothing for the repo's patched copy
 *     (`patches/werift+0.22.9.patch`).
 *
 * The cipher's own allocations (`createCipheriv`, `update`'s output,
 * `getAuthTag`) are native, unavoidable through Node's API, and identical in
 * both columns; they are reported as a floor, not counted here.
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

interface CounterSnapshot {
  calls: number
  bytes: number
}

const counters: Record<string, CounterSnapshot> = {}
let counting = false

function wrap(name: 'alloc' | 'allocUnsafe' | 'allocUnsafeSlow' | 'concat' | 'from'): void {
  const original = Buffer[name] as (...args: unknown[]) => Buffer
  const counter: CounterSnapshot = { calls: 0, bytes: 0 }
  counters[name] = counter
  Object.defineProperty(Buffer, name, {
    configurable: true,
    value: function counted(this: unknown, ...args: unknown[]): Buffer {
      const out = original.apply(Buffer, args)
      if (counting) {
        counter.calls += 1
        counter.bytes += out.length
      }
      return out
    },
  })
}

for (const name of ['alloc', 'allocUnsafe', 'allocUnsafeSlow', 'concat', 'from'] as const)
  wrap(name)

function measure(label: string, packets: number, run: () => void): void {
  for (const c of Object.values(counters)) {
    c.calls = 0
    c.bytes = 0
  }
  counting = true
  run()
  counting = false
  const calls = Object.values(counters).reduce((n, c) => n + c.calls, 0)
  const slowCalls = counters['allocUnsafeSlow']!.calls
  console.log(
    `${label.padEnd(34)} ${(calls / packets).toFixed(2).padStart(6)} buffer calls/packet` +
      `   ${(slowCalls / packets).toFixed(4).padStart(7)} unpooled ArrayBuffers/packet` +
      `   ${Object.entries(counters)
        .map(([k, c]) => `${k}=${c.calls}`)
        .join(' ')}`,
  )
}

function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  const v = i >= 0 ? process.argv[i + 1] : undefined
  return v ?? fallback
}

const PACKETS = Number(argValue('packets', '100000'))

// ---- repacketizer ----------------------------------------------------------

const weriftRoot = argValue('werift', 'werift')
const weriftLabel = weriftRoot === 'werift' ? 'repo werift, patched' : 'werift 0.22.9 as published'
const weriftModule = require(weriftRoot) as typeof import('werift')
const { RtpHeader, RtpPacket, SrtpSession } = weriftModule

const repacketizerPath = argValue(
  'repacketizer',
  '../packages/addon-pipeline/src/stream-broker/webrtc/h264-repacketizer.ts',
)
const { H264Repacketizer } = (await import(
  repacketizerPath.startsWith('/')
    ? pathToFileURL(repacketizerPath).href
    : new URL(repacketizerPath, import.meta.url).href
)) as typeof import('../packages/addon-pipeline/src/stream-broker/webrtc/h264-repacketizer.ts')

function nal(type: number, size: number): Buffer {
  const out = Buffer.alloc(size, 0x5a)
  out[0] = 0x60 | type
  return out
}

function fuaOf(nalUnit: Buffer, fragment: number): Buffer[] {
  const header = nalUnit[0]!
  const body = nalUnit.subarray(1)
  const out: Buffer[] = []
  for (let off = 0; off < body.length; off += fragment) {
    const part = body.subarray(off, Math.min(off + fragment, body.length))
    const head = Buffer.from([
      (header & 0xe0) | 28,
      (off === 0 ? 0x80 : 0) | (off + fragment >= body.length ? 0x40 : 0) | (header & 0x1f),
    ])
    out.push(Buffer.concat([head, part]))
  }
  return out
}

function buildInputs(): Array<InstanceType<typeof RtpPacket>> {
  const inputs: Array<InstanceType<typeof RtpPacket>> = []
  let seq = 1
  let ts = 90_000
  const feed = (payload: Buffer, marker: boolean): void => {
    inputs.push(
      new RtpPacket(
        new RtpHeader({
          payloadType: 96,
          sequenceNumber: seq++ & 0xffff,
          timestamp: ts,
          ssrc: 1,
          marker,
        }),
        payload,
      ),
    )
  }
  // One cycle is ~143 source packets and leaves as ~143 outputs.
  for (let cycle = 0; cycle < Math.ceil(PACKETS / 143); cycle++) {
    for (const p of fuaOf(nal(5, 30_000), 1400)) feed(p, false)
    ts += 3000
    feed(nal(1, 3100), true) // oversized single NAL, cut into FU-A
    ts += 3000
    for (const p of fuaOf(nal(1, 2400), 1200)) feed(p, false)
    ts += 3000
    feed(nal(1, 400), true)
    ts += 3000
  }
  return inputs
}

const inputs = buildInputs()
const repacketizer = new H264Repacketizer(console, 1200)
let produced = 0
measure('H264Repacketizer (per source packet)', inputs.length, () => {
  for (const packet of inputs) produced += repacketizer.repacketize(packet).length
})
console.log(
  `  (${inputs.length} source packets in, ${produced} out; the fixture is built outside the counted region)`,
)

// ---- SRTP ------------------------------------------------------------------

function srtpPackets(): Array<{ header: InstanceType<typeof RtpHeader>; payload: Buffer }> {
  const payload = Buffer.alloc(1200, 0x42)
  return Array.from({ length: 1000 }, (_, i) => ({
    header: new RtpHeader({
      payloadType: 96,
      sequenceNumber: (1000 + i) & 0xffff,
      timestamp: 90_000 + i * 3000,
      ssrc: 0x11223344,
      marker: i % 30 === 0,
      extensions: [{ id: 1, payload: Buffer.from('0') }],
    }),
    payload,
  }))
}

function sessionFor(profile: 1 | 7): InstanceType<typeof SrtpSession> {
  const key = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex')
  const salt = Buffer.alloc(profile === 7 ? 12 : 14, 0xa5)
  return new SrtpSession({
    profile,
    keys: {
      localMasterKey: key,
      localMasterSalt: salt,
      remoteMasterKey: key,
      remoteMasterSalt: salt,
    },
  })
}

const sample = srtpPackets()
const rounds = Math.ceil(PACKETS / sample.length)
const total = rounds * sample.length

for (const [name, profile] of [
  ['GCM', 7],
  ['CTR', 1],
] as const) {
  const session = sessionFor(profile)
  measure(`SRTP ${name} (${weriftLabel})`, total, () => {
    for (let r = 0; r < rounds; r++) for (const p of sample) session.encrypt(p.payload, p.header)
  })
}
console.log(
  'floor (native, unchanged by the patch): createCipheriv + update() output + getAuthTag (GCM) / HMAC digest (CTR) per packet',
)
