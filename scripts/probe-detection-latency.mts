#!/usr/bin/env tsx
/**
 * Detection-overlay latency probe. Subscribes to the SAME tRPC WSS stream the
 * admin-ui uses (`detection.result`) and measures, per camera, two clocks:
 *
 *   - captureToUiMs = receipt(now) - data.capturedAt
 *     → TRUE end-to-end: shm-ring frame commit (capture) → inference →
 *       orchestrator emit → hub → WSS → here. This is "vs the original frame
 *       time" — the box's real age when it reaches the UI. `capturedAt` is
 *       threaded onto the event (PipelineInferenceResult → DetectionResult);
 *       NaN when the build hasn't shipped that field yet.
 *   - deliveryMs = receipt(now) - event envelope timestamp (orchestrator emit)
 *     → emit → hub → WSS → here. The post-inference delivery leg only.
 *   - gapMs = inter-arrival gap between consecutive events for a camera
 *     → effective UI box-update cadence.
 *
 * All clocks are this machine (localhost), so there is no cross-host skew.
 *
 * Compare against scripts/probe-motion-latency.mts (motion overlay) and the
 * runner's "pipeline stats" log (frameAge / e2e per stage).
 *
 * Usage: npx tsx scripts/probe-detection-latency.mts [durationSec=30]
 */
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import superjson from 'superjson'
import WebSocket from 'ws'
import type { AppRouter } from '@camstack/types'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const DURATION_SEC = Number.parseInt(process.argv[2] ?? '30', 10)
const SERVER = process.env.CAMSTACK_SERVER ?? 'https://localhost:4443'

async function login(): Promise<string> {
  const res = await fetch(`${SERVER}/trpc/auth.login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ json: { username: 'admin', password: 'admin' } }),
  })
  const body = (await res.json()) as { result?: { data?: { json?: { token?: string } } } }
  const token = body?.result?.data?.json?.token
  if (!token) throw new Error(`login failed: ${JSON.stringify(body)}`)
  return token
}

function envMs(ts: unknown): number {
  if (typeof ts === 'number') return ts
  if (ts instanceof Date) return ts.getTime()
  if (typeof ts === 'string') return new Date(ts).getTime()
  return NaN
}

interface S {
  capture: number[]
  delivery: number[]
  gaps: number[]
  dets: number[]
  last: number
  count: number
}
const stats = new Map<string, S>() // key = deviceId

function rec(key: string, captureMs: number, deliveryMs: number, dets: number, now: number): void {
  let s = stats.get(key)
  if (!s) {
    s = { capture: [], delivery: [], gaps: [], dets: [], last: 0, count: 0 }
    stats.set(key, s)
  }
  if (Number.isFinite(captureMs)) s.capture.push(captureMs)
  if (Number.isFinite(deliveryMs)) s.delivery.push(deliveryMs)
  if (Number.isFinite(dets)) s.dets.push(dets)
  if (s.last > 0) s.gaps.push(now - s.last)
  s.last = now
  s.count++
}

const pct = (a: number[], p: number): number => {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!
}
const mean = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)

function report(): void {
  console.log(`\n=== detection overlay latency (detection.result) ===`)
  console.log(
    'dev   | n   | capture→UI avg/p95/max ms | delivery avg/p95/max ms | gap avg/p95 ms | det avg',
  )
  for (const key of [...stats.keys()].sort()) {
    const s = stats.get(key)!
    const cap = s.capture.length
      ? `${mean(s.capture).toFixed(0).padStart(5)}/${pct(s.capture, 95).toFixed(0).padStart(5)}/${Math.max(
          0,
          ...s.capture,
        )
          .toFixed(0)
          .padStart(5)}`
      : '  n/a (capturedAt absent)'
    console.log(
      `${key.padEnd(6)}| ${String(s.count).padStart(3)} | ${cap.padStart(25)} | ${mean(s.delivery).toFixed(0).padStart(5)}/${pct(s.delivery, 95).toFixed(0).padStart(5)}/${Math.max(
        0,
        ...s.delivery,
      )
        .toFixed(0)
        .padStart(
          5,
        )} | ${mean(s.gaps).toFixed(0).padStart(5)}/${pct(s.gaps, 95).toFixed(0).padStart(5)} | ${mean(s.dets).toFixed(1).padStart(5)}`,
    )
  }
}

async function main(): Promise<void> {
  const token = await login()
  const ws = createWSClient({
    url: SERVER.replace('https', 'wss') + '/trpc',
    WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
    connectionParams: { token },
  })
  const trpc = createTRPCClient<AppRouter>({
    links: [wsLink({ client: ws, transformer: superjson })],
  })
  console.log(`Detection latency probe — ${DURATION_SEC}s. Subscribing to detection.result…`)

  const sub = trpc.live.onEvent.subscribe(
    { category: 'detection.result' },
    {
      onData: (evt: unknown) => {
        const now = Date.now()
        const e = evt as {
          timestamp?: unknown
          source?: { id?: number | string }
          data?: {
            deviceId?: number
            capturedAt?: number
            frame?: { detections?: readonly unknown[] }
          }
        }
        const dev = e.source?.id ?? e.data?.deviceId ?? '?'
        const deliveryMs = now - envMs(e.timestamp)
        const captureMs = typeof e.data?.capturedAt === 'number' ? now - e.data.capturedAt : NaN
        const dets = e.data?.frame?.detections?.length ?? 0
        rec(String(dev), captureMs, deliveryMs, dets, now)
      },
    },
  )

  const iv = setInterval(report, 5000)
  await new Promise((r) => setTimeout(r, DURATION_SEC * 1000))
  clearInterval(iv)
  report()
  sub.unsubscribe()
  ws.close()
  process.exit(0)
}

void main()
