#!/usr/bin/env tsx
/**
 * Bench suite — sweep matrix across (path × parallelism × batchSize ×
 * imageSize) so single-run regressions don't hide behind one set of
 * parameters. Each combo runs warmup + N measured iterations and
 * reports:
 *
 *   fps              wall-clock total throughput (results / sec)
 *   call_mean_ms     wall-clock per call (single) or per batch
 *   per_frame_ms     call_mean / batchSize (lets you compare paths)
 *   infer_max_ms     max inferenceMs across results (CoreML predict)
 *   transport_ms     call_mean - infer_max (≈ IPC + serialize)
 *   detections       avg detection count per frame (sanity)
 *
 * Output: console table + CSV file under bench-results/ for diffing.
 *
 * Usage:
 *   npx tsx scripts/bench-suite.mts [iterations=50] [warmup=2]
 *
 * Env:
 *   CAMSTACK_SERVER  https://localhost:4443
 *   CAMSTACK_USER    admin
 *   CAMSTACK_PASS    admin
 *   AGENT_NODE_ID    hub
 *   FIXTURE_PATH     test-output/bench/sample.jpg  (any JPEG)
 *   MATRIX           comma-separated combos to override default sweep:
 *                    "path:parallel:batch:size" e.g.
 *                    "single:1:1:640,parallel:4:1:640,batch:1:4:640,batch:1:4:320"
 *
 * Default sweep:
 *   single:1:1:640      single call baseline
 *   parallel:2:1:640    Promise.all of 2 single calls
 *   parallel:4:1:640    Promise.all of 4 single calls
 *   parallel:8:1:640    Promise.all of 8 single calls
 *   batch:1:2:640       1 cap call, batch=2
 *   batch:1:4:640       1 cap call, batch=4
 *   batch:1:8:640       1 cap call, batch=8
 *   batch:1:4:320       1 cap call, batch=4, smaller image
 *   batch:1:4:1280      1 cap call, batch=4, larger image
 *
 * Run from repo root.
 */
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client'
import superjson from 'superjson'
import WebSocket from 'ws'
import { performance } from 'node:perf_hooks'
import * as fs from 'node:fs'
import * as path from 'node:path'
import sharpMod from 'sharp'
import type { AppRouter } from '@camstack/types'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const ITERATIONS = Number.parseInt(process.argv[2] ?? '50', 10)
const WARMUP = Number.parseInt(process.argv[3] ?? '2', 10)

const SERVER = process.env.CAMSTACK_SERVER ?? 'https://localhost:4443'
const USERNAME = process.env.CAMSTACK_USER ?? 'admin'
const PASSWORD = process.env.CAMSTACK_PASS ?? 'admin'
const NODE_ID = process.env.AGENT_NODE_ID ?? 'hub'
const FIXTURE_DEFAULT = path.resolve('test-output/bench/sample.jpg')
const FIXTURE = path.resolve(process.env.FIXTURE_PATH ?? FIXTURE_DEFAULT)
const ADDON_ID = process.env.ADDON_ID ?? 'object-detection'
const MODEL_ID = process.env.MODEL_ID ?? 'yolov11n'

const sharp = sharpMod as unknown as (
  input: Buffer | Uint8Array,
  opts?: Record<string, unknown>,
) => sharpMod.Sharp

interface ComboSpec {
  readonly path: 'single' | 'parallel' | 'batch'
  readonly parallel: number
  readonly batch: number
  readonly size: number
}

const DEFAULT_MATRIX: readonly ComboSpec[] = [
  { path: 'single', parallel: 1, batch: 1, size: 640 },
  { path: 'parallel', parallel: 2, batch: 1, size: 640 },
  { path: 'parallel', parallel: 4, batch: 1, size: 640 },
  { path: 'parallel', parallel: 8, batch: 1, size: 640 },
  { path: 'batch', parallel: 1, batch: 2, size: 640 },
  { path: 'batch', parallel: 1, batch: 4, size: 640 },
  { path: 'batch', parallel: 1, batch: 8, size: 640 },
  { path: 'batch', parallel: 1, batch: 4, size: 320 },
  { path: 'batch', parallel: 1, batch: 4, size: 1280 },
] as const

function parseMatrix(raw: string | undefined): readonly ComboSpec[] {
  if (!raw) return DEFAULT_MATRIX
  return raw.split(',').map((s) => {
    const parts = s.split(':')
    if (parts.length !== 4) throw new Error(`Invalid combo "${s}"`)
    const pPath = parts[0] as ComboSpec['path']
    if (pPath !== 'single' && pPath !== 'parallel' && pPath !== 'batch') {
      throw new Error(`Invalid path "${pPath}" in combo "${s}"`)
    }
    return {
      path: pPath,
      parallel: Number.parseInt(parts[1]!, 10),
      batch: Number.parseInt(parts[2]!, 10),
      size: Number.parseInt(parts[3]!, 10),
    }
  })
}

const MATRIX = parseMatrix(process.env.MATRIX)

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

interface CallOutput {
  readonly batchSize: number
  readonly callMs: number
  readonly perFrameMs: number
  readonly inferMaxMs: number
  readonly detTotal: number
}

interface FixtureRgb {
  readonly bytes: Uint8Array
  readonly width: number
  readonly height: number
}

const fixtureCache = new Map<number, FixtureRgb>()

async function getFixture(size: number, jpeg: Buffer): Promise<FixtureRgb> {
  const cached = fixtureCache.get(size)
  if (cached) return cached
  const rgb = await sharp(jpeg)
    .resize({ width: size, height: size, fit: 'fill' })
    .raw()
    .toColorspace('srgb')
    .toBuffer()
  const f = {
    bytes: new Uint8Array(rgb.buffer, rgb.byteOffset, rgb.byteLength),
    width: size,
    height: size,
  }
  fixtureCache.set(size, f)
  return f
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

async function runSingle(trpc: TrpcClient, fx: FixtureRgb): Promise<CallOutput> {
  const t0 = performance.now()
  const res = await trpc.pipelineExecutor.runPipeline.mutate({
    nodeId: NODE_ID,
    steps: STEPS,
    frame: {
      data: fx.bytes,
      format: 'rgb',
      width: fx.width,
      height: fx.height,
      timestamp: Date.now(),
    },
    deviceId: 0,
  })
  const callMs = performance.now() - t0
  const inferMs = res.debug?.totalInferenceMs ?? 0
  const det = res.detections?.length ?? 0
  return { batchSize: 1, callMs, perFrameMs: callMs, inferMaxMs: inferMs, detTotal: det }
}

async function runBatch(trpc: TrpcClient, fx: FixtureRgb, size: number): Promise<CallOutput> {
  const frames = Array.from({ length: size }, () => ({
    data: fx.bytes,
    format: 'rgb' as const,
    width: fx.width,
    height: fx.height,
    timestamp: Date.now(),
  }))
  const t0 = performance.now()
  const out = await trpc.pipelineExecutor.runPipelineBatch.mutate({
    nodeId: NODE_ID,
    steps: STEPS,
    frames,
    deviceId: 0,
  })
  const callMs = performance.now() - t0
  const inferMax = out.results.reduce((acc, r) => Math.max(acc, r.debug?.totalInferenceMs ?? 0), 0)
  const detTotal = out.results.reduce((acc, r) => acc + (r.detections?.length ?? 0), 0)
  return {
    batchSize: out.results.length,
    callMs,
    perFrameMs: callMs / Math.max(1, out.results.length),
    inferMaxMs: inferMax,
    detTotal,
  }
}

interface ComboResult {
  readonly spec: ComboSpec
  readonly samples: number // total frame results
  readonly calls: number // total cap calls
  readonly wallSec: number
  readonly fps: number
  readonly callMeanMs: number
  readonly callP95Ms: number
  readonly perFrameMs: number
  readonly inferMaxMs: number
  readonly transportMs: number
  readonly avgDetections: number
}

function percentile(values: number[], pct: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor((pct / 100) * sorted.length))
  return sorted[idx]!
}

async function runCombo(trpc: TrpcClient, spec: ComboSpec, jpeg: Buffer): Promise<ComboResult> {
  const fx = await getFixture(spec.size, jpeg)
  const issueOnce = async (): Promise<CallOutput[]> => {
    if (spec.path === 'single') {
      return [await runSingle(trpc, fx)]
    }
    if (spec.path === 'parallel') {
      const outs = await Promise.all(
        Array.from({ length: spec.parallel }, () => runSingle(trpc, fx)),
      )
      return outs
    }
    return [await runBatch(trpc, fx, spec.batch)]
  }

  // Warmup
  for (let w = 0; w < WARMUP; w++) {
    await issueOnce()
  }

  const callMs: number[] = []
  const perFrameMs: number[] = []
  const inferMs: number[] = []
  const detCounts: number[] = []
  let calls = 0
  let samples = 0
  const wallStart = performance.now()
  for (let i = 0; i < ITERATIONS; i++) {
    const outs = await issueOnce()
    for (const out of outs) {
      calls++
      samples += out.batchSize
      callMs.push(out.callMs)
      perFrameMs.push(out.perFrameMs)
      inferMs.push(out.inferMaxMs)
      detCounts.push(out.detTotal / Math.max(1, out.batchSize))
    }
  }
  const wallSec = (performance.now() - wallStart) / 1000
  const fps = samples / wallSec
  const mean = (arr: number[]) => arr.reduce((s, v) => s + v, 0) / Math.max(1, arr.length)
  const callMeanMs = mean(callMs)
  const callP95Ms = percentile(callMs, 95)
  const perFrameMean = mean(perFrameMs)
  const inferMax = mean(inferMs)
  const transport = Math.max(0, perFrameMean - inferMax)
  const avgDet = mean(detCounts)
  return {
    spec,
    samples,
    calls,
    wallSec,
    fps,
    callMeanMs,
    callP95Ms,
    perFrameMs: perFrameMean,
    inferMaxMs: inferMax,
    transportMs: transport,
    avgDetections: avgDet,
  }
}

function fmtSpec(s: ComboSpec): string {
  return `${s.path.padEnd(8)} p=${s.parallel} b=${s.batch} ${s.size}px`
}

function printTable(rows: readonly ComboResult[]): void {
  const header = `${'combo'.padEnd(28)} ${'fps'.padStart(7)} ${'callMs'.padStart(9)} ${'p95'.padStart(7)} ${'pfMs'.padStart(7)} ${'infer'.padStart(7)} ${'trans'.padStart(7)} ${'det/f'.padStart(6)} ${'samples'.padStart(8)}`
  console.log('\n' + header)
  console.log('-'.repeat(header.length))
  for (const r of rows) {
    console.log(
      `${fmtSpec(r.spec).padEnd(28)} ${r.fps.toFixed(2).padStart(7)} ${r.callMeanMs.toFixed(2).padStart(9)} ${r.callP95Ms.toFixed(2).padStart(7)} ${r.perFrameMs.toFixed(2).padStart(7)} ${r.inferMaxMs.toFixed(2).padStart(7)} ${r.transportMs.toFixed(2).padStart(7)} ${r.avgDetections.toFixed(2).padStart(6)} ${String(r.samples).padStart(8)}`,
    )
  }
}

function writeCsv(rows: readonly ComboResult[]): string {
  const dir = path.resolve('bench-results')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const out = path.join(dir, `bench-suite-${stamp}.csv`)
  const lines: string[] = []
  lines.push(
    'path,parallel,batch,size,iterations,calls,samples,wallSec,fps,callMeanMs,callP95Ms,perFrameMs,inferMaxMs,transportMs,avgDetections',
  )
  for (const r of rows) {
    lines.push(
      [
        r.spec.path,
        r.spec.parallel,
        r.spec.batch,
        r.spec.size,
        ITERATIONS,
        r.calls,
        r.samples,
        r.wallSec.toFixed(3),
        r.fps.toFixed(3),
        r.callMeanMs.toFixed(3),
        r.callP95Ms.toFixed(3),
        r.perFrameMs.toFixed(3),
        r.inferMaxMs.toFixed(3),
        r.transportMs.toFixed(3),
        r.avgDetections.toFixed(3),
      ].join(','),
    )
  }
  fs.writeFileSync(out, lines.join('\n') + '\n')
  return out
}

async function main(): Promise<void> {
  if (!fs.existsSync(FIXTURE)) {
    console.error(`Fixture not found: ${FIXTURE}`)
    console.error('Set FIXTURE_PATH to a valid JPEG (any size — gets resized per-combo).')
    process.exit(1)
  }
  console.log('========================')
  console.log(new Date().toLocaleString())
  console.log(`Server:     ${SERVER}`)
  console.log(`Node:       ${NODE_ID}`)
  console.log(`Model:      ${ADDON_ID}/${MODEL_ID}`)
  console.log(`Fixture:    ${FIXTURE}`)
  console.log(`Iterations: ${ITERATIONS} per combo (warmup ${WARMUP})`)
  console.log(`Combos:     ${MATRIX.length}`)

  const jpeg = fs.readFileSync(FIXTURE)
  const { trpc, close } = await connect()
  const results: ComboResult[] = []
  try {
    for (const spec of MATRIX) {
      process.stdout.write(`\nrunning ${fmtSpec(spec)} ... `)
      const r = await runCombo(trpc, spec, jpeg)
      console.log(`fps=${r.fps.toFixed(2)} call=${r.callMeanMs.toFixed(1)}ms`)
      results.push(r)
    }
  } finally {
    close()
  }

  results.sort((a, b) => b.fps - a.fps)
  printTable(results)
  const csv = writeCsv(results)
  console.log(`\nCSV: ${csv}`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
