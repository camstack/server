/**
 * Latency Probe — connects to the running CamStack server and measures
 * end-to-end detection latency breakdown for a specific device.
 *
 * Subscribes to detection.result events and logs per-phase timing.
 */
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import superjson from 'superjson'
import WebSocket from 'ws'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const SERVER = 'https://localhost:4443'
const DEVICE_ID = process.argv[2] || 'dev_0003'
const SAMPLE_COUNT = parseInt(process.argv[3] || '30', 10)

// ── Login ──
const loginRes = await fetch(`${SERVER}/trpc/auth.login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ json: { username: 'admin', password: 'admin' } }),
})
const token = (await loginRes.json())?.result?.data?.json?.token
if (!token) {
  console.error('Login failed')
  process.exit(1)
}

// ── tRPC WS client ──
const ws = createWSClient({
  url: SERVER.replace('https', 'wss') + '/trpc',
  WebSocket,
  connectionParams: () => ({ token }),
})
const trpc = createTRPCClient({
  links: [wsLink({ client: ws, transformer: superjson })],
})

console.log(`\nLatency probe for ${DEVICE_ID} — collecting ${SAMPLE_COUNT} detection samples...\n`)
console.log('cap→enq  queue  sem   infer  emit  E2E(srv) WS     E2E(client)  dets  classes')
console.log('──────── ────── ───── ────── ───── ──────── ────── ─────────── ───── ────────')

const samples = []
let count = 0

const sub = trpc.live.onEvent.subscribe(
  { category: 'detection.result' },
  {
    onData: (event) => {
      const now = Date.now()
      const src = event?.source?.id
      if (src !== DEVICE_ID) return
      const data = event?.data

      // Pipeline traces now have their own category (pipeline.trace) — they
      // never reach this `detection.result` subscription, so no filter needed.

      const captureTs = data?.captureTimestamp
      const emitTs = data?.emitTimestamp
      const pr = data?.pipelineResult
      if (!captureTs || !emitTs || !pr) return

      const serverMs = emitTs - captureTs // capture → server emit
      const wsMs = now - emitTs // server emit → client receive
      const e2eClient = now - captureTs // capture → client receive

      // Extract step timings if available
      const stepTimings = pr.stepTimings ?? []
      const totalInference = stepTimings.reduce((s, t) => s + (t.ms ?? 0), 0)

      // Detection summary
      const dets = pr.detections ?? []
      const detCount = dets.length
      const classes = dets
        .map((d) => {
          const ch = d.children?.length ?? 0
          return ch > 0
            ? `${d.className}(${(d.confidence * 100).toFixed(0)}%)+${ch}ch`
            : `${d.className}(${(d.confidence * 100).toFixed(0)}%)`
        })
        .join(', ')

      // We don't have per-frame phase breakdown from the event,
      // but we can compute: overhead = serverMs - totalInference
      const overhead = serverMs - totalInference

      const pad = (n, w = 6) => String(n).padStart(w)
      console.log(
        `${pad(overhead, 8)}ms ${pad('?', 6)}  ${pad('?', 5)} ${pad(totalInference)}ms ${pad('?', 5)} ${pad(serverMs, 8)}ms ${pad(wsMs)}ms ${pad(e2eClient, 11)}ms ${pad(detCount, 5)} ${classes}`,
      )

      samples.push({ serverMs, wsMs, e2eClient, totalInference, overhead, detCount })
      count++

      if (count >= SAMPLE_COUNT) {
        printSummary()
        sub.unsubscribe()
        ws.close()
        process.exit(0)
      }
    },
  },
)

// Also subscribe to detection.raw to measure motion latency
const motionSamples = []
const subMotion = trpc.live.onEvent.subscribe(
  { category: 'detection.raw' },
  {
    onData: (event) => {
      const now = Date.now()
      if (event?.source?.id !== DEVICE_ID) return
      const data = event?.data
      if (data?.type !== 'motion.raw') return
      const captureTs = data?.captureTimestamp
      const emitTs = data?.emitTimestamp
      if (!captureTs || !emitTs) return
      motionSamples.push({
        serverMs: emitTs - captureTs,
        wsMs: now - emitTs,
        e2eClient: now - captureTs,
      })
    },
  },
)

function printSummary() {
  console.log('\n═══ SUMMARY ═══\n')
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0)
  const p95 = (arr) => {
    const s = [...arr].sort((a, b) => a - b)
    return Math.round(s[Math.floor(s.length * 0.95)] ?? s[s.length - 1] ?? 0)
  }

  if (samples.length > 0) {
    console.log(`Detection (${samples.length} samples):`)
    console.log(
      `  Server total:    avg=${avg(samples.map((s) => s.serverMs))}ms  p95=${p95(samples.map((s) => s.serverMs))}ms`,
    )
    console.log(
      `    ├─ Inference:  avg=${avg(samples.map((s) => s.totalInference))}ms  p95=${p95(samples.map((s) => s.totalInference))}ms`,
    )
    console.log(
      `    └─ Overhead:   avg=${avg(samples.map((s) => s.overhead))}ms  p95=${p95(samples.map((s) => s.overhead))}ms  (queue + semaphore + IPC + emit)`,
    )
    console.log(
      `  WebSocket:       avg=${avg(samples.map((s) => s.wsMs))}ms  p95=${p95(samples.map((s) => s.wsMs))}ms`,
    )
    console.log(
      `  E2E (client):    avg=${avg(samples.map((s) => s.e2eClient))}ms  p95=${p95(samples.map((s) => s.e2eClient))}ms`,
    )
    console.log(
      `  Avg detections:  ${(samples.reduce((s, x) => s + x.detCount, 0) / samples.length).toFixed(1)}`,
    )
  }

  if (motionSamples.length > 0) {
    console.log(`\nMotion raw (${motionSamples.length} samples):`)
    console.log(
      `  Server:  avg=${avg(motionSamples.map((s) => s.serverMs))}ms  p95=${p95(motionSamples.map((s) => s.serverMs))}ms`,
    )
    console.log(
      `  WS:      avg=${avg(motionSamples.map((s) => s.wsMs))}ms  p95=${p95(motionSamples.map((s) => s.wsMs))}ms`,
    )
    console.log(
      `  E2E:     avg=${avg(motionSamples.map((s) => s.e2eClient))}ms  p95=${p95(motionSamples.map((s) => s.e2eClient))}ms`,
    )
  }
}

setTimeout(() => {
  console.log(`\nTimeout — got ${count} detection samples, ${motionSamples.length} motion samples`)
  printSummary()
  sub.unsubscribe()
  subMotion.unsubscribe()
  ws.close()
  process.exit(0)
}, 60000)
