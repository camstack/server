#!/usr/bin/env tsx
/**
 * E2E latency probe — measures the wall-clock gap from a frame's
 * decoder timestamp (when the broker emitted the decoded buffer) to
 * the moment the resulting `pipeline.inference-result` event arrives
 * over the tRPC subscription on the UI side.
 *
 * What this captures (in order, all lumped into one number):
 *   1. broker → pipeline-runner enqueue
 *   2. runner → pipelineExecutor.runPipeline cap call
 *   3. provider executor.run + python pool predict
 *   4. result → eventBus.emit on hub
 *   5. eventBus → tRPC subscription serializer
 *   6. WebSocket flight to this script
 *
 * What it does NOT capture (these still happen before #1):
 *   - RTSP packet network arrival
 *   - depacketizer + decoder decode time
 *
 * That's deliberate — `frame.timestamp` is set by the decoder when it
 * publishes the frame, so this measures the *post-decode* pipeline
 * which is what the UI experiences.
 *
 * Usage:
 *   npx tsx scripts/bench-e2e-latency.mts [durationSec=60]
 *
 * Env:
 *   CAMSTACK_SERVER  https://localhost:4443
 *   CAMSTACK_USER    admin
 *   CAMSTACK_PASS    admin
 *
 * Output: live tail of per-camera latency stats every 5s + final
 * report sorted by camera fps.
 */
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import superjson from 'superjson'
import WebSocket from 'ws'
import type { AppRouter } from '@camstack/types'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const DURATION_SEC = Number.parseInt(process.argv[2] ?? '60', 10)

const SERVER = process.env.CAMSTACK_SERVER ?? 'https://localhost:4443'
const USERNAME = process.env.CAMSTACK_USER ?? 'admin'
const PASSWORD = process.env.CAMSTACK_PASS ?? 'admin'

async function login(): Promise<string> {
  const res = await fetch(`${SERVER}/trpc/auth.login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ json: { username: USERNAME, password: PASSWORD } }),
  })
  const body = (await res.json()) as { result?: { data?: { json?: { token?: string } } } }
  const token = body?.result?.data?.json?.token
  if (!token) throw new Error(`login failed: ${JSON.stringify(body)}`)
  return token
}

type TrpcClient = ReturnType<typeof createTRPCClient<AppRouter>>

async function connect(): Promise<{ trpc: TrpcClient; close: () => void }> {
  const token = await login()
  const ws = createWSClient({
    url: SERVER.replace('https', 'wss') + '/trpc',
    WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
    connectionParams: { token },
  })
  const trpc = createTRPCClient<AppRouter>({
    links: [wsLink({ client: ws, transformer: superjson })],
  })
  return { trpc, close: () => ws.close() }
}

interface CameraStats {
  samples: number[]
  inferSamples: number[]
  detectionsTotal: number
  firstSeenAt: number
  lastSeenAt: number
}

const stats = new Map<number, CameraStats>()

function record(deviceId: number, latencyMs: number, inferMs: number, detCount: number): void {
  let s = stats.get(deviceId)
  const now = Date.now()
  if (!s) {
    s = { samples: [], inferSamples: [], detectionsTotal: 0, firstSeenAt: now, lastSeenAt: now }
    stats.set(deviceId, s)
  }
  s.samples.push(latencyMs)
  s.inferSamples.push(inferMs)
  s.detectionsTotal += detCount
  s.lastSeenAt = now
}

function percentile(values: readonly number[], pct: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor((pct / 100) * sorted.length))
  return sorted[idx]!
}

function maxOf(values: readonly number[]): number {
  return values.length === 0 ? 0 : Math.max(...values)
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length
}

function printTable(label: string): void {
  const ids = [...stats.keys()].sort((a, b) => a - b)
  if (ids.length === 0) {
    console.log(`[${label}] no samples yet`)
    return
  }
  console.log(`\n=== ${label} ===`)
  const header = `${'devId'.padStart(6)} ${'frames'.padStart(7)} ${'fps'.padStart(6)} ${'lat_avg'.padStart(8)} ${'lat_p50'.padStart(8)} ${'lat_p95'.padStart(8)} ${'lat_p99'.padStart(8)} ${'lat_max'.padStart(8)} ${'infer_avg'.padStart(10)} ${'det/f'.padStart(6)}`
  console.log(header)
  console.log('-'.repeat(header.length))
  for (const id of ids) {
    const s = stats.get(id)!
    const span = (s.lastSeenAt - s.firstSeenAt) / 1000
    const fps = span > 0 ? s.samples.length / span : 0
    const avgDet = s.samples.length > 0 ? s.detectionsTotal / s.samples.length : 0
    console.log(
      `${String(id).padStart(6)} ${String(s.samples.length).padStart(7)} ${fps.toFixed(2).padStart(6)} ${mean(s.samples).toFixed(1).padStart(8)} ${percentile(s.samples, 50).toFixed(1).padStart(8)} ${percentile(s.samples, 95).toFixed(1).padStart(8)} ${percentile(s.samples, 99).toFixed(1).padStart(8)} ${maxOf(s.samples).toFixed(1).padStart(8)} ${mean(s.inferSamples).toFixed(1).padStart(10)} ${avgDet.toFixed(2).padStart(6)}`,
    )
  }
}

interface PipelineEventDataFrame {
  readonly timestamp?: number
  readonly detections?: readonly unknown[]
  readonly debug?: { readonly totalInferenceMs?: number }
}

interface PipelineInferenceEventData {
  readonly deviceId?: number
  readonly frame?: PipelineEventDataFrame
}

async function main(): Promise<void> {
  console.log(`E2E latency probe — duration ${DURATION_SEC}s`)
  console.log(`Server: ${SERVER}`)
  console.log('Subscribing to category=pipeline.inference-result …')

  const { trpc, close } = await connect()
  let receivedTotal = 0
  let firstReceiveAt = 0
  const sub = trpc.live.onEvent.subscribe(
    { category: 'pipeline.inference-result' },
    {
      onData: (evt) => {
        const recv = Date.now()
        if (firstReceiveAt === 0) firstReceiveAt = recv
        const data = evt.data as unknown as PipelineInferenceEventData | undefined
        const frame = data?.frame
        const deviceId = data?.deviceId
        if (typeof deviceId !== 'number') return
        const ts = frame?.timestamp
        if (typeof ts !== 'number') return
        const latency = recv - ts
        const inferMs = frame?.debug?.totalInferenceMs ?? 0
        const det = frame?.detections?.length ?? 0
        record(deviceId, latency, inferMs, det)
        receivedTotal++
      },
      onError: (err) => {
        console.error('subscription error:', err)
      },
    },
  )

  const reportInterval = setInterval(() => {
    printTable(`tick @ ${Math.round((Date.now() - firstReceiveAt) / 1000)}s`)
  }, 5000)

  await new Promise<void>((resolve) => setTimeout(resolve, DURATION_SEC * 1000))
  clearInterval(reportInterval)
  sub.unsubscribe()
  close()

  printTable('FINAL')
  console.log(`\nTotal events received: ${receivedTotal}`)
  console.log(`Total wall: ${(Date.now() - firstReceiveAt) / 1000}s`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
