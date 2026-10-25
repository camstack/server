#!/usr/bin/env tsx
/**
 * Multi-camera stress sweep — answers "what's the max sustained
 * detection throughput a single agent can hold under N cameras
 * simultaneously each pushing F frames per second?"
 *
 * For each (N, F) pair the script spawns N concurrent loops, each
 * issuing `runPipeline` calls at a target rate of F fps with raw RGB
 * frames at the model input size (no decode, no transport bloat —
 * isolates the pipeline-runner + provider + python pool from the rest
 * of the broker). Runs for `durationSec` seconds per cell, reports:
 *
 *   target_dps         N × F           — what we asked for
 *   actual_dps         delivered fps   — what we got back
 *   saturated          bool             — fps achieved / target fps < 0.9
 *   call_mean_ms       per runPipeline  — average latency
 *   call_p95_ms        idem (p95)
 *   infer_mean_ms      python predict   — per-frame model latency
 *   queue_depth_avg    in-flight calls  — backpressure indicator
 *
 * Output: console grid + CSV in `bench-results/`.
 *
 * Usage:
 *   npx tsx scripts/bench-stress-cameras.mts [durationSec=15]
 *
 * Env:
 *   CAMSTACK_SERVER  https://localhost:4443
 *   CAMSTACK_USER    admin
 *   CAMSTACK_PASS    admin
 *   AGENT_NODE_ID    hub
 *   ADDON_ID         object-detection
 *   MODEL_ID         yolov11n
 *   MODEL_INPUT      640
 *   GRID             "N×F" cells, e.g. "1x10,2x10,4x10,8x10,4x5,4x15,4x20,4x30"
 *
 * Defaults sweep:
 *   1×10  baseline single-camera
 *   2×10
 *   4×10
 *   8×10  oversaturated agent
 *   4×5   slow cameras
 *   4×15
 *   4×20
 *   4×30  burst load
 */
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import superjson from 'superjson'
import WebSocket from 'ws'
import { performance } from 'node:perf_hooks'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import type { AppRouter } from '@camstack/types'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const DURATION_SEC = Number.parseInt(process.argv[2] ?? '15', 10)
const SERVER = process.env.CAMSTACK_SERVER ?? 'https://localhost:4443'
const USERNAME = process.env.CAMSTACK_USER ?? 'admin'
const PASSWORD = process.env.CAMSTACK_PASS ?? 'admin'
const NODE_ID = process.env.AGENT_NODE_ID ?? 'hub'
const ADDON_ID = process.env.ADDON_ID ?? 'object-detection'
const MODEL_ID = process.env.MODEL_ID ?? 'yolov11n'
const MODEL_INPUT = Number.parseInt(process.env.MODEL_INPUT ?? '640', 10)

interface Cell {
  readonly cameras: number
  readonly fps: number
}

const DEFAULT_GRID: readonly Cell[] = [
  { cameras: 1, fps: 10 },
  { cameras: 2, fps: 10 },
  { cameras: 4, fps: 10 },
  { cameras: 8, fps: 10 },
  { cameras: 4, fps: 5 },
  { cameras: 4, fps: 15 },
  { cameras: 4, fps: 20 },
  { cameras: 4, fps: 30 },
] as const

function parseGrid(raw: string | undefined): readonly Cell[] {
  if (!raw) return DEFAULT_GRID
  return raw.split(',').map((s) => {
    const m = s.trim().match(/^(\d+)x(\d+)$/i)
    if (!m) throw new Error(`Invalid cell "${s}", expected NxF`)
    return { cameras: Number.parseInt(m[1]!, 10), fps: Number.parseInt(m[2]!, 10) }
  })
}

const GRID = parseGrid(process.env.GRID)

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

interface CellResult {
  readonly cell: Cell
  readonly targetDps: number
  readonly actualDps: number
  readonly saturated: boolean
  readonly callMeanMs: number
  readonly callP95Ms: number
  readonly inferMeanMs: number
  readonly queueDepthAvg: number
  readonly errors: number
  readonly samples: number
  readonly wallSec: number
}

function percentile(values: readonly number[], pct: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor((pct / 100) * sorted.length))
  return sorted[idx]!
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length
}

const STEPS = [
  {
    addonId: ADDON_ID,
    modelId: MODEL_ID,
    enabled: true,
    classFilters: [] as string[],
    children: [] as never[],
  },
]

async function runCell(trpc: TrpcClient, cell: Cell, rgb: Uint8Array): Promise<CellResult> {
  const callMs: number[] = []
  const inferMs: number[] = []
  let inFlight = 0
  let inFlightSamples = 0
  let inFlightSum = 0
  let errors = 0
  let samples = 0
  const tickInterval = setInterval(() => {
    inFlightSum += inFlight
    inFlightSamples++
  }, 50)

  const cameraInterval = 1000 / cell.fps
  const stopAt = performance.now() + DURATION_SEC * 1000

  const runOnce = async (): Promise<void> => {
    inFlight++
    const t0 = performance.now()
    try {
      const res = await trpc.pipelineExecutor.runPipeline.mutate({
        nodeId: NODE_ID,
        steps: STEPS,
        frame: {
          data: rgb,
          format: 'rgb',
          width: MODEL_INPUT,
          height: MODEL_INPUT,
          timestamp: Date.now(),
        },
        deviceId: 0,
      })
      callMs.push(performance.now() - t0)
      inferMs.push(res.debug?.totalInferenceMs ?? 0)
      samples++
    } catch {
      errors++
    } finally {
      inFlight--
    }
  }

  const cameraLoop = async (): Promise<void> => {
    while (performance.now() < stopAt) {
      const callStart = performance.now()
      // Don't block the loop — fire and forget so the camera holds
      // its target rate even when calls take longer than the
      // per-frame interval. The queue-depth gauge reports backpressure.
      void runOnce()
      const elapsed = performance.now() - callStart
      const sleep = Math.max(0, cameraInterval - elapsed)
      await new Promise<void>((resolve) => setTimeout(resolve, sleep))
    }
  }

  const wallStart = performance.now()
  const loops = Array.from({ length: cell.cameras }, () => cameraLoop())
  await Promise.all(loops)

  // Drain any in-flight calls that started before stopAt.
  while (inFlight > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }
  clearInterval(tickInterval)
  const wallSec = (performance.now() - wallStart) / 1000

  const targetDps = cell.cameras * cell.fps
  const actualDps = samples / wallSec
  return {
    cell,
    targetDps,
    actualDps,
    saturated: actualDps / targetDps < 0.9,
    callMeanMs: mean(callMs),
    callP95Ms: percentile(callMs, 95),
    inferMeanMs: mean(inferMs),
    queueDepthAvg: inFlightSamples > 0 ? inFlightSum / inFlightSamples : 0,
    errors,
    samples,
    wallSec,
  }
}

async function warmup(trpc: TrpcClient, rgb: Uint8Array): Promise<void> {
  // Two synchronous calls so the python pool loads model + jit-warms
  // the predict path before measurements start.
  for (let i = 0; i < 2; i++) {
    await trpc.pipelineExecutor.runPipeline.mutate({
      nodeId: NODE_ID,
      steps: STEPS,
      frame: {
        data: rgb,
        format: 'rgb',
        width: MODEL_INPUT,
        height: MODEL_INPUT,
        timestamp: Date.now(),
      },
      deviceId: 0,
    })
  }
}

function fmtCell(c: Cell): string {
  return `${c.cameras}cam×${c.fps}fps`
}

function printGrid(rows: readonly CellResult[]): void {
  const header = `${'cell'.padEnd(11)} ${'target_dps'.padStart(11)} ${'actual_dps'.padStart(11)} ${'sat'.padStart(4)} ${'call_mean'.padStart(10)} ${'call_p95'.padStart(9)} ${'infer'.padStart(7)} ${'queue'.padStart(6)} ${'samples'.padStart(8)} ${'errors'.padStart(7)}`
  console.log('\n' + header)
  console.log('-'.repeat(header.length))
  for (const r of rows) {
    console.log(
      `${fmtCell(r.cell).padEnd(11)} ${r.targetDps.toFixed(1).padStart(11)} ${r.actualDps.toFixed(2).padStart(11)} ${(r.saturated ? 'YES' : 'no').padStart(4)} ${r.callMeanMs.toFixed(1).padStart(10)} ${r.callP95Ms.toFixed(1).padStart(9)} ${r.inferMeanMs.toFixed(1).padStart(7)} ${r.queueDepthAvg.toFixed(1).padStart(6)} ${String(r.samples).padStart(8)} ${String(r.errors).padStart(7)}`,
    )
  }
}

function writeCsv(rows: readonly CellResult[]): string {
  const dir = path.resolve('bench-results')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const out = path.join(dir, `bench-stress-${stamp}.csv`)
  const lines: string[] = [
    'cameras,fps,target_dps,actual_dps,saturated,call_mean_ms,call_p95_ms,infer_mean_ms,queue_depth_avg,samples,errors,wall_sec',
  ]
  for (const r of rows) {
    lines.push(
      [
        r.cell.cameras,
        r.cell.fps,
        r.targetDps,
        r.actualDps.toFixed(3),
        r.saturated ? 1 : 0,
        r.callMeanMs.toFixed(3),
        r.callP95Ms.toFixed(3),
        r.inferMeanMs.toFixed(3),
        r.queueDepthAvg.toFixed(3),
        r.samples,
        r.errors,
        r.wallSec.toFixed(3),
      ].join(','),
    )
  }
  fs.writeFileSync(out, lines.join('\n') + '\n')
  return out
}

async function main(): Promise<void> {
  console.log('========================')
  console.log(new Date().toLocaleString())
  console.log(`CPU:        ${os.cpus()[0]?.model ?? 'unknown'} (${os.cpus().length} cores)`)
  console.log(`Server:     ${SERVER}`)
  console.log(`Node:       ${NODE_ID}`)
  console.log(`Model:      ${ADDON_ID}/${MODEL_ID} @ ${MODEL_INPUT}×${MODEL_INPUT}`)
  console.log(`Duration:   ${DURATION_SEC}s per cell`)
  console.log(`Cells:      ${GRID.length}`)

  const rgb = new Uint8Array(MODEL_INPUT * MODEL_INPUT * 3)
  const { trpc, close } = await connect()
  try {
    console.log('\nWarmup …')
    await warmup(trpc, rgb)
    console.log('Warmup done.\n')

    const results: CellResult[] = []
    for (const cell of GRID) {
      process.stdout.write(`Running ${fmtCell(cell)} (target ${cell.cameras * cell.fps} dps) … `)
      const r = await runCell(trpc, cell, rgb)
      console.log(`actual ${r.actualDps.toFixed(2)} dps ${r.saturated ? '(SATURATED)' : ''}`)
      results.push(r)
    }
    printGrid(results)
    const csv = writeCsv(results)
    console.log(`\nCSV: ${csv}`)
  } finally {
    close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
