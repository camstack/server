#!/usr/bin/env tsx
/**
 * Motion-overlay latency probe. Subscribes to the SAME tRPC WSS stream the
 * admin-ui uses and measures, per camera, for the motion overlay events
 * (`detection.motion-zones-raw` + `detection.motion-analysis`):
 *
 *   - deliveryMs = receipt(now) - event envelope timestamp (runner emit time)
 *     → runner-emit → hub → WSS → here. The path the UI sees, minus browser
 *       render. If this is ~2s, the lag is server-side emit/delivery congestion.
 *   - gapMs = inter-arrival gap between consecutive events for a camera
 *     → the effective UI update cadence (how choppy the box is).
 *
 * Both clocks are this machine (localhost), so deliveryMs has no skew.
 *
 * Usage: npx tsx scripts/probe-motion-latency.mts [durationSec=30]
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
  delivery: number[]
  gaps: number[]
  last: number
  count: number
}
const stats = new Map<string, S>() // key = `${category}|${deviceId}`

function rec(key: string, deliveryMs: number, now: number): void {
  let s = stats.get(key)
  if (!s) {
    s = { delivery: [], gaps: [], last: 0, count: 0 }
    stats.set(key, s)
  }
  if (Number.isFinite(deliveryMs)) s.delivery.push(deliveryMs)
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
  console.log(`\n=== motion overlay delivery (deliveryMs = emit→here) + update gap ===`)
  console.log('category|dev               | n   | deliv avg/p95/max ms | gap avg/p95 ms (cadence)')
  for (const key of [...stats.keys()].sort()) {
    const s = stats.get(key)!
    console.log(
      `${key.padEnd(34)}| ${String(s.count).padStart(3)} | ${mean(s.delivery).toFixed(0).padStart(5)}/${pct(s.delivery, 95).toFixed(0).padStart(5)}/${Math.max(
        0,
        ...s.delivery,
      )
        .toFixed(0)
        .padStart(
          5,
        )} | ${mean(s.gaps).toFixed(0).padStart(5)}/${pct(s.gaps, 95).toFixed(0).padStart(5)}`,
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
  console.log(`Motion latency probe — ${DURATION_SEC}s. Subscribing to motion overlay categories…`)

  const subs = ['detection.motion-zones-raw', 'detection.motion-analysis'].map((category) =>
    trpc.live.onEvent.subscribe(
      { category },
      {
        onData: (evt: unknown) => {
          const now = Date.now()
          const e = evt as {
            timestamp?: unknown
            category?: string
            source?: { id?: number | string }
            data?: { deviceId?: number }
          }
          const dev = e.source?.id ?? e.data?.deviceId ?? '?'
          const deliveryMs = now - envMs(e.timestamp)
          rec(`${category}|${dev}`, deliveryMs, now)
        },
      },
    ),
  )

  const iv = setInterval(report, 5000)
  await new Promise((r) => setTimeout(r, DURATION_SEC * 1000))
  clearInterval(iv)
  report()
  subs.forEach((s) => s.unsubscribe())
  ws.close()
  process.exit(0)
}

void main()
