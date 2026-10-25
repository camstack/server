#!/usr/bin/env tsx
/**
 * Phase 5 A/B harness — measures the end-to-end runPipeline call
 * latency against a real running server, with the same image fed once
 * as JPEG (legacy path) and once as raw RGB (Phase 4 fast path).
 *
 * Reports:
 *   call mean / p95 / p99 — wall-clock from `runPipeline.mutate` start
 *                            to the first FrameResult landing.
 *   inference ms          — engine-reported inferenceMs (Python pool).
 *   delta                 — JPEG mean - RGB mean per phase.
 *
 * The bench reuses the same fixture file `test-output/bench/*.jpg`
 * already shipped with the decoder bench. Decode that once via sharp
 * to get the RGB buffer; ship both shapes through the same
 * `pipelineExecutor.runPipeline` cap mount.
 *
 * Usage:
 *   npx tsx scripts/bench-pipeline-raw-vs-jpeg.mts [iterations=200] [parallel=4] [sweep?=0]
 *
 * sweep=1 runs the RGB path at parallel ∈ {1,2,4,8} so Phase 6 can
 * spot whether the predict pool saturates at ≤4 (the typical
 * single-thread predictor pattern) and whether multi-camera batching
 * has any spare capacity to harvest.
 *
 * Env:
 *   CAMSTACK_SERVER  https://localhost:4443
 *   CAMSTACK_USER    admin
 *   CAMSTACK_PASS    admin
 *   AGENT_NODE_ID    hub  (cluster node to target)
 *   FIXTURE_PATH     test-output/bench/sample-1080p.jpg
 *
 * Exit 0 on success.
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

const ITERATIONS = Number.parseInt(process.argv[2] ?? '200', 10)
const PARALLEL = Number.parseInt(process.argv[3] ?? '4', 10)
const SWEEP = process.argv[4] === '1' || process.argv[4] === 'sweep'
const SERVER = process.env.CAMSTACK_SERVER ?? 'https://localhost:4443'
const USERNAME = process.env.CAMSTACK_USER ?? 'admin'
const PASSWORD = process.env.CAMSTACK_PASS ?? 'admin'
const NODE_ID = process.env.AGENT_NODE_ID ?? 'hub'
const FIXTURE = path.resolve(process.env.FIXTURE_PATH ?? 'test-output/bench/sample-1080p.jpg')

if (!fs.existsSync(FIXTURE)) {
  console.error(`Fixture not found: ${FIXTURE}\nSet FIXTURE_PATH or generate the fixture.`)
  process.exit(1)
}

const sharp = sharpMod as unknown as (
  input: Buffer | Uint8Array,
  opts?: Record<string, unknown>,
) => sharpMod.Sharp

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

function percentile(values: number[], pct: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor((pct / 100) * sorted.length))
  return sorted[idx]!
}

function summary(label: string, samples: number[], inferences: number[]): void {
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length
  const inferMean = inferences.reduce((a, b) => a + b, 0) / inferences.length
  const p95 = percentile(samples, 95)
  const p99 = percentile(samples, 99)
  console.log(`${label}`)
  console.log(`  samples       ${samples.length}`)
  console.log(`  call mean     ${mean.toFixed(2)} ms`)
  console.log(`  call p95      ${p95.toFixed(2)} ms`)
  console.log(`  call p99      ${p99.toFixed(2)} ms`)
  console.log(`  infer mean    ${inferMean.toFixed(2)} ms`)
  console.log(`  fps (1/mean)  ${(1000 / mean).toFixed(2)}`)
}

async function runOnce(
  trpc: TrpcClient,
  steps: Array<{
    addonId: string
    modelId: string
    enabled: boolean
    classFilters: string[]
    children: never[]
  }>,
  payload:
    | { kind: 'jpeg'; image: Uint8Array }
    | {
        kind: 'raw'
        frame: { data: Uint8Array; format: 'rgb'; width: number; height: number; timestamp: number }
      },
): Promise<{ callMs: number; inferMs: number }> {
  const start = performance.now()
  const result =
    payload.kind === 'jpeg'
      ? await trpc.pipelineExecutor.runPipeline.mutate({
          nodeId: NODE_ID,
          steps,
          image: payload.image,
        })
      : await trpc.pipelineExecutor.runPipeline.mutate({
          nodeId: NODE_ID,
          steps,
          frame: payload.frame,
          deviceId: 0,
        })
  const callMs = performance.now() - start
  const inferMs = result?.debug?.totalInferenceMs ?? 0
  return { callMs, inferMs }
}

async function runWave(
  trpc: TrpcClient,
  iterations: number,
  parallel: number,
  steps: Array<{
    addonId: string
    modelId: string
    enabled: boolean
    classFilters: string[]
    children: never[]
  }>,
  buildPayload: () => ReturnType<typeof runOnce> extends Promise<infer R> ? unknown : never,
): Promise<{ calls: number[]; infers: number[] }> {
  const calls: number[] = []
  const infers: number[] = []
  let issued = 0
  const inflight = new Set<Promise<void>>()
  const startWave = performance.now()
  while (issued < iterations) {
    while (inflight.size < parallel && issued < iterations) {
      issued++
      const p = (async () => {
        const payload = buildPayload() as Parameters<typeof runOnce>[2]
        try {
          const out = await runOnce(trpc, steps, payload)
          calls.push(out.callMs)
          infers.push(out.inferMs)
        } catch (err: unknown) {
          console.error('iteration failed:', err)
        }
      })()
      inflight.add(p)
      p.finally(() => {
        inflight.delete(p)
      })
    }
    await Promise.race(inflight)
  }
  await Promise.all(inflight)
  console.log(`  wall clock     ${(performance.now() - startWave).toFixed(0)} ms`)
  return { calls, infers }
}

async function main(): Promise<void> {
  console.log(`\nA/B bench — runPipeline JPEG vs raw RGB`)
  console.log(`  server       ${SERVER}`)
  console.log(`  node         ${NODE_ID}`)
  console.log(`  iterations   ${ITERATIONS} per side`)
  console.log(`  parallel     ${PARALLEL}`)
  console.log(`  fixture      ${FIXTURE}`)

  const jpegBuf = fs.readFileSync(FIXTURE)
  const meta = await sharp(jpegBuf).metadata()
  const width = meta.width ?? 0
  const height = meta.height ?? 0
  if (!width || !height) throw new Error('failed to probe fixture dimensions')
  const rgbBuf = await sharp(jpegBuf).raw().toColorspace('srgb').toBuffer()
  console.log(`  resolution   ${width}×${height} (rgb bytes: ${rgbBuf.length})\n`)

  const { trpc, close } = await connect()
  try {
    const steps = [
      {
        addonId: 'object-detection',
        modelId: 'yolov11n',
        enabled: true,
        classFilters: [],
        children: [] as never[],
      },
    ]

    console.log('--- A: JPEG path (legacy) ---')
    const jpegRun = await runWave(trpc, ITERATIONS, PARALLEL, steps, () => ({
      kind: 'jpeg' as const,
      image: new Uint8Array(jpegBuf),
    }))
    summary('JPEG', jpegRun.calls, jpegRun.infers)

    console.log('\n--- B: RGB raw path (Phase 4) ---')
    const rgbRun = await runWave(trpc, ITERATIONS, PARALLEL, steps, () => ({
      kind: 'raw' as const,
      frame: {
        data: new Uint8Array(rgbBuf.buffer, rgbBuf.byteOffset, rgbBuf.byteLength),
        format: 'rgb' as const,
        width,
        height,
        timestamp: Date.now(),
      },
    }))
    summary('RGB ', rgbRun.calls, rgbRun.infers)

    const jpegMean = jpegRun.calls.reduce((a, b) => a + b, 0) / jpegRun.calls.length
    const rgbMean = rgbRun.calls.reduce((a, b) => a + b, 0) / rgbRun.calls.length
    const delta = jpegMean - rgbMean
    const pct = (delta / jpegMean) * 100
    console.log(
      `\nDelta — call mean: ${delta.toFixed(2)} ms (${pct.toFixed(1)}% reduction on raw path)`,
    )

    if (SWEEP) {
      console.log('\n--- C: parallel sweep on RGB path (Phase 6 capacity probe) ---')
      const concurrencies = [1, 2, 4, 8]
      for (const conc of concurrencies) {
        console.log(`\nparallel=${conc}`)
        const sweep = await runWave(trpc, ITERATIONS, conc, steps, () => ({
          kind: 'raw' as const,
          frame: {
            data: new Uint8Array(rgbBuf.buffer, rgbBuf.byteOffset, rgbBuf.byteLength),
            format: 'rgb' as const,
            width,
            height,
            timestamp: Date.now(),
          },
        }))
        summary(`  parallel=${conc}`, sweep.calls, sweep.infers)
      }
      console.log(
        '\nReading the sweep:\n' +
          '  - call mean stays roughly constant as parallel grows ⇒ predict pool saturated.\n' +
          '    Batching across cameras would land in linger overhead with no throughput\n' +
          '    upside — defer Phase 6.\n' +
          '  - call mean drops as parallel grows ⇒ predict pool has slack ⇒ batching\n' +
          '    window worth implementing (Python `MSG_INFER_BATCH` opcode + 5ms TS\n' +
          '    linger window in `RuntimeDispatcher`).',
      )
    }
  } finally {
    close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
