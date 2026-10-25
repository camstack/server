/**
 * The measured process of `scripts/bench-stream-broker-gc.mts` — do not run by hand,
 * the runner spawns it under the V8 flags being judged.
 *
 * Drives the REAL `StreamBroker` (native RTSP reader, depacketizer, access-unit
 * assembler, source-RTP pre-buffer ring, clip ring, RTSP restreamer and
 * `RtspSession` over real TCP) at the hub's measured load shape
 * (`profile.json`, one entry per broker: bitrate, fps, GOP, codec, RTSP
 * clients, pre-buffer seconds) and reports GC counts and CPU on stdout as
 * `RESULT` lines the runner parses. The fake camera fleet and the restream
 * drain clients live in `generator.mjs`, a separate process, so none of their
 * allocations land in the measured heap.
 *
 * Environment: `GEN_PORT`, `RESTREAM_PORT`, `BROKERS` (first N profile
 * entries), `WARMUP_S`, `DURATION_S`, `CLIP_SEC` (clip ring on the sub/low
 * profiles), `TALLY=1` (attribute Buffer allocations per call site).
 */
import fs from 'node:fs'
import net from 'node:net'
import { constants, PerformanceObserver } from 'node:perf_hooks'
import type { IScopedLogger } from '@camstack/types'
import { RtspSession } from '../../packages/addon-pipeline/src/stream-broker/rtsp/rtsp-session.ts'
import { StreamBroker } from '../../packages/addon-pipeline/src/stream-broker/stream-broker/stream-broker.ts'

interface BrokerProfile {
  readonly id: string
  readonly kbps: number
  readonly fps: number
  readonly gopMs: number
  readonly codec: 'h264' | 'h265'
  readonly clients: number
  readonly pre: number
  readonly audio: boolean
}

interface AllocationTally {
  bytes: number
  calls: number
}

interface GcEntryDetail {
  readonly kind: number
}

const fullProfile: readonly BrokerProfile[] = JSON.parse(
  fs.readFileSync(new URL('./profile.json', import.meta.url), 'utf8'),
) as BrokerProfile[]
const brokerCount = Number(process.env['BROKERS'] ?? fullProfile.length)
const profile = fullProfile.slice(0, brokerCount)
const GEN_PORT = Number(process.env['GEN_PORT'] ?? 18554)
const RESTREAM_PORT = Number(process.env['RESTREAM_PORT'] ?? 18555)
const WARMUP_S = Number(process.env['WARMUP_S'] ?? 20)
const DURATION_S = Number(process.env['DURATION_S'] ?? 90)
const CLIP_SEC = Number(process.env['CLIP_SEC'] ?? 30)

// ── Buffer allocation tally (sampled stacks) ──────────────────────────────
type BufferFactory = 'allocUnsafeSlow' | 'allocUnsafe' | 'alloc' | 'concat' | 'from'
const tally = new Map<string, AllocationTally>()
let tallyOn = false
if (process.env['TALLY'] === '1') {
  const SAMPLE = Number(process.env['TALLY_SAMPLE'] ?? 16)
  let depth = 0
  let n = 0
  const factories = Buffer as unknown as Record<BufferFactory, (...args: unknown[]) => Buffer>
  const wrap = (name: BufferFactory): void => {
    const orig = factories[name]
    factories[name] = function tallied(...args: unknown[]): Buffer {
      depth++
      try {
        const r = orig.apply(Buffer, args)
        if (depth === 1 && tallyOn && ++n % SAMPLE === 0) {
          const stack = new Error().stack?.split('\n') ?? []
          const site = stack
            .slice(2, 4)
            .map((s) =>
              s
                .trim()
                .replace(/^at /, '')
                .replace(/.*\/src\//, ''),
            )
            .join(' < ')
          const key = `${name} ${site}`
          const t = tally.get(key) ?? { bytes: 0, calls: 0 }
          t.bytes += r.length * SAMPLE
          t.calls += SAMPLE
          tally.set(key, t)
        }
        return r
      } finally {
        depth--
      }
    }
  }
  for (const name of ['allocUnsafeSlow', 'allocUnsafe', 'alloc', 'concat', 'from'] as const)
    wrap(name)
}

const silent: IScopedLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent
  },
  withTags() {
    return silent
  },
}

let majors = 0
let minors = 0
let incremental = 0
let pauseMs = 0
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    const detail = (entry as unknown as { detail: GcEntryDetail }).detail
    if (detail.kind === constants.NODE_PERFORMANCE_GC_MAJOR) majors++
    else if (detail.kind === constants.NODE_PERFORMANCE_GC_MINOR) minors++
    else if (detail.kind === constants.NODE_PERFORMANCE_GC_INCREMENTAL) incremental++
    pauseMs += entry.duration
  }
}).observe({ entryTypes: ['gc'] })

async function main(): Promise<void> {
  const brokers: StreamBroker[] = []
  for (let i = 0; i < profile.length; i++) {
    const p = profile[i]!
    const broker = new StreamBroker(`${1000 + i}/${p.id.split('/')[1]}`, silent)
    if (p.pre > 0) broker.setPrebuffer({ enabled: true, seconds: p.pre })
    if (CLIP_SEC > 0 && /sub|low|slot/.test(p.id)) broker.setClipRetention(CLIP_SEC)
    brokers.push(broker)
    await broker.start({
      type: 'rtsp',
      url: `rtsp://127.0.0.1:${GEN_PORT}/s${i}`,
      videoCodec: p.codec,
    })
  }

  // Restream sessions over real TCP; the generator process drains them. The
  // first byte a drain client sends is the broker index it wants.
  const server = net.createServer((sock) => {
    sock.once('data', (d) => {
      const broker = brokers[d[0]!]
      if (!broker) {
        sock.destroy()
        return
      }
      const restreamer = broker.getRtspRestreamer()
      const session = new RtspSession(sock, restreamer.getSdp() ?? '', undefined, false)
      restreamer.addSession(session)
      sock.emit(
        'data',
        Buffer.from(
          'SETUP rtsp://localhost/x/trackID=0 RTSP/1.0\r\nCSeq: 1\r\nTransport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n',
        ),
      )
      sock.emit('data', Buffer.from('PLAY rtsp://localhost/x RTSP/1.0\r\nCSeq: 2\r\n\r\n'))
    })
    sock.on('error', () => {})
  })
  server.listen(RESTREAM_PORT, '127.0.0.1')

  await new Promise((r) => setTimeout(r, WARMUP_S * 1000))
  majors = 0
  minors = 0
  incremental = 0
  pauseMs = 0
  tallyOn = true
  const cpu0 = process.cpuUsage()
  const t0 = performance.now()
  const sampler = setInterval(() => {
    const m = process.memoryUsage()
    console.log(
      `  heapUsed=${(m.heapUsed / 1e6).toFixed(0)}MB ab=${(m.arrayBuffers / 1e6).toFixed(0)}MB rss=${(m.rss / 1e6).toFixed(0)}MB`,
    )
  }, 15_000)
  await new Promise((r) => setTimeout(r, DURATION_S * 1000))
  clearInterval(sampler)

  const elapsedS = (performance.now() - t0) / 1000
  const cpu = process.cpuUsage(cpu0)
  const stats = brokers.map((b) => b.getStats())
  const kbps = stats.reduce((a, s) => a + s.bitrateKbps, 0)
  const fps = stats.reduce((a, s) => a + s.inputFps, 0)
  const clients = stats.reduce((a, s) => a + s.rtspClients, 0)
  console.log(
    `RESULT brokers=${brokers.length} ingestKbps=${kbps} pictures/s=${fps.toFixed(0)} rtspClients=${clients}`,
  )
  const perMin = (count: number): string => ((count * 60) / elapsedS).toFixed(1)
  console.log(
    `RESULT maj/min=${perMin(majors)} min/min=${perMin(minors)} inc/min=${perMin(incremental)} ` +
      `gcPauseMs/5min=${((pauseMs * 300) / elapsedS).toFixed(0)} ` +
      `cpu=${(((cpu.user + cpu.system) / 1e6 / elapsedS) * 100).toFixed(1)}%`,
  )
  if (process.env['TALLY'] === '1') {
    const rows = [...tally.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 18)
    const total = [...tally.values()].reduce((a, t) => a + t.bytes, 0)
    console.log(`TALLY total=${(total / elapsedS / 1e6).toFixed(1)}MB/s`)
    for (const [key, t] of rows) {
      console.log(
        `TALLY ${(t.bytes / elapsedS / 1e6).toFixed(2)}MB/s ${(t.calls / elapsedS).toFixed(0)}/s avg=${(t.bytes / t.calls).toFixed(0)}B ${key}`,
      )
    }
  }
  process.exit(0)
}
void main()
