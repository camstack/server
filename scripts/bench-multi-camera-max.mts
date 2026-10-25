/**
 * Multi-camera *peak throughput* simulator.
 *
 * Where bench-multi-camera.mts paces dispatches at a target FPS to
 * mimic real motion-station load, this script removes the cap and
 * just hammers the pipeline as hard as it can absorb. Each "camera"
 * dispatches the next frame the instant the previous one resolves,
 * so the only ceilings left are:
 *
 *   - tRPC + JSON-base64 round-trip latency (host-side)
 *   - Python pool concurrency × per-predict latency (worker-side)
 *   - ANE single-channel serialization
 *
 * The point is to compare against external detector-engine reference
 * numbers and surface where we're shy.
 *
 * Sweep: cameras × concurrency × model. We hold batchMode=list (winner
 * of the previous bench) constant for all configs.
 */
import { readFileSync, statSync } from 'node:fs'

const SERVER = 'https://localhost:4443'
const IMAGE_PATH =
  '/Users/<local-user>/Documents/Git/camstack/camstack-server/test-output/annotated_persons-cars-animal.jpg'
const DURATION_S = 10

interface SweepConfig {
  readonly label: string
  readonly cameraCount: number
  readonly modelId: string
  readonly concurrency: number
  readonly batchMode: 'list' | 'window' | 'none'
  readonly maxBatchSize?: number
}

const SWEEP: readonly SweepConfig[] = [
  // Sweep concurrency at 6 cam yolov9t (the prior winner).
  {
    label: '6cam yolov9t c=2 list',
    cameraCount: 6,
    modelId: 'yolov9t',
    concurrency: 2,
    batchMode: 'list',
    maxBatchSize: 8,
  },
  {
    label: '6cam yolov9t c=4 list',
    cameraCount: 6,
    modelId: 'yolov9t',
    concurrency: 4,
    batchMode: 'list',
    maxBatchSize: 8,
  },
  {
    label: '6cam yolov9t c=8 list',
    cameraCount: 6,
    modelId: 'yolov9t',
    concurrency: 8,
    batchMode: 'list',
    maxBatchSize: 8,
  },
  // 12 cameras to over-subscribe and find the natural ceiling.
  {
    label: '12cam yolov9t c=4 list',
    cameraCount: 12,
    modelId: 'yolov9t',
    concurrency: 4,
    batchMode: 'list',
    maxBatchSize: 8,
  },
  {
    label: '12cam yolov9t c=8 list',
    cameraCount: 12,
    modelId: 'yolov9t',
    concurrency: 8,
    batchMode: 'list',
    maxBatchSize: 8,
  },
  // Same but with yolov9s for comparison at the optimal concurrency.
  {
    label: '6cam yolov9s c=4 list',
    cameraCount: 6,
    modelId: 'yolov9s',
    concurrency: 4,
    batchMode: 'list',
    maxBatchSize: 8,
  },
  {
    label: '12cam yolov9s c=8 list',
    cameraCount: 12,
    modelId: 'yolov9s',
    concurrency: 8,
    batchMode: 'list',
    maxBatchSize: 8,
  },
]

interface JsonRpcResult<T> {
  readonly result?: { readonly data?: { readonly json?: T } }
  readonly error?: { readonly json?: { readonly message?: string } }
}

const ignoreTls = (): typeof globalThis.fetch => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  return globalThis.fetch
}

async function login(fetchFn: typeof globalThis.fetch): Promise<string> {
  const r = await fetchFn(`${SERVER}/trpc/auth.login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ json: { username: 'admin', password: 'admin' } }),
  })
  const j = (await r.json()) as JsonRpcResult<{ readonly token: string }>
  const tok = j.result?.data?.json?.token
  if (!tok) throw new Error('login failed: ' + JSON.stringify(j))
  return tok
}

async function trpcPost<T>(
  fetchFn: typeof globalThis.fetch,
  token: string,
  path: string,
  input: unknown,
): Promise<T> {
  const r = await fetchFn(`${SERVER}/trpc/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ json: input }),
  })
  const j = (await r.json()) as JsonRpcResult<T>
  if (j.error) throw new Error(`${path}: ${j.error.json?.message ?? 'unknown'}`)
  if (!j.result?.data?.json) throw new Error(`${path}: empty result`)
  return j.result.data.json
}

interface FrameResult {
  readonly detections?: readonly unknown[]
  readonly debug?: { readonly totalInferenceMs?: number; readonly inferMs?: number }
}

interface PerCameraStats {
  cameraId: number
  framesCompleted: number
  framesFailed: number
  latencies: number[]
  inferMs: number[]
  detections: number
}

interface RunStats {
  readonly config: SweepConfig
  readonly durationMs: number
  readonly totalFrames: number
  readonly totalDetections: number
  readonly detsPerSec: number
  readonly perCamFps: number
  readonly p50Latency: number
  readonly p95Latency: number
  readonly p99Latency: number
  readonly p50Infer: number
  readonly p95Infer: number
  readonly errors: number
}

function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p))
  return sorted[idx] ?? 0
}

async function applyPipelineSettings(
  fetchFn: typeof globalThis.fetch,
  token: string,
  config: SweepConfig,
): Promise<void> {
  await new Promise((r) => setTimeout(r, 2_000))
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await trpcPost(fetchFn, token, 'addonSettings.updateGlobalSettings', {
        addonId: 'detection-pipeline',
        nodeId: 'hub',
        patch: {
          concurrency: config.concurrency,
          batchMode: config.batchMode,
          maxBatchSize: config.maxBatchSize ?? 8,
        },
      })
      lastErr = null
      break
    } catch (err) {
      lastErr = err
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('Request is rejected')) {
        console.log(
          `   (settings rejected mid-restart, attempt ${attempt + 1}/3 — likely persisted)`,
        )
        break
      }
      await new Promise((r) => setTimeout(r, 3_000))
    }
  }
  // Worker pool restart can take ~3-4s for python pool re-init.
  await new Promise((r) => setTimeout(r, 18_000))
  if (lastErr && !(lastErr instanceof Error && lastErr.message.includes('Request is rejected'))) {
    throw lastErr
  }
}

async function runOneSweep(
  fetchFn: typeof globalThis.fetch,
  token: string,
  imgB64: string,
  config: SweepConfig,
): Promise<RunStats> {
  const cameraStates: PerCameraStats[] = Array.from({ length: config.cameraCount }, (_, i) => ({
    cameraId: i,
    framesCompleted: 0,
    framesFailed: 0,
    latencies: [],
    inferMs: [],
    detections: 0,
  }))

  const t0 = Date.now()
  const tEnd = t0 + DURATION_S * 1000

  // No FPS cap — each camera issues the next predict the instant
  // the prior one resolves. This is the "back-to-back" peak path.
  const cameraLoops = cameraStates.map((stats) =>
    (async () => {
      while (Date.now() < tEnd) {
        const dispatchStart = Date.now()
        try {
          const r = await trpcPost<FrameResult>(fetchFn, token, 'pipelineExecutor.runPipeline', {
            steps: [
              { addonId: 'object-detection', modelId: config.modelId, enabled: true, children: [] },
            ],
            imageBase64: imgB64,
            nodeId: 'hub',
            sessionId: `peak-${stats.cameraId}-${dispatchStart}`,
          })
          const dispatchEnd = Date.now()
          stats.framesCompleted++
          stats.latencies.push(dispatchEnd - dispatchStart)
          stats.inferMs.push(r.debug?.totalInferenceMs ?? 0)
          stats.detections += r.detections?.length ?? 0
        } catch {
          stats.framesFailed++
        }
      }
    })(),
  )

  await Promise.all(cameraLoops)
  const durationMs = Date.now() - t0

  const allLatencies: number[] = []
  const allInferMs: number[] = []
  let totalFrames = 0
  let totalDetections = 0
  let errors = 0
  for (const s of cameraStates) {
    totalFrames += s.framesCompleted
    totalDetections += s.detections
    errors += s.framesFailed
    allLatencies.push(...s.latencies)
    allInferMs.push(...s.inferMs)
  }

  const totalFps = (totalFrames * 1000) / durationMs

  return {
    config,
    durationMs,
    totalFrames,
    totalDetections,
    detsPerSec: totalFps, // each runPipeline is 1 detection-cycle
    perCamFps: totalFps / config.cameraCount,
    p50Latency: percentile(allLatencies, 0.5),
    p95Latency: percentile(allLatencies, 0.95),
    p99Latency: percentile(allLatencies, 0.99),
    p50Infer: percentile(allInferMs, 0.5),
    p95Infer: percentile(allInferMs, 0.95),
    errors,
  }
}

function formatRow(s: RunStats): string {
  return [
    s.config.label.padEnd(28),
    `dets/s=${s.detsPerSec.toFixed(1)}`.padEnd(15),
    `per-cam=${s.perCamFps.toFixed(1)}fps`.padEnd(16),
    `p50=${s.p50Latency}ms`.padEnd(11),
    `p95=${s.p95Latency}ms`.padEnd(11),
    `p99=${s.p99Latency}ms`.padEnd(11),
    `infer p50=${s.p50Infer}ms`.padEnd(15),
    `infer p95=${s.p95Infer}ms`.padEnd(15),
    `errors=${s.errors}`,
  ].join(' ')
}

async function main(): Promise<void> {
  const fetchFn = ignoreTls()
  const token = await login(fetchFn)
  const imgBytes = readFileSync(IMAGE_PATH)
  const imgB64 = imgBytes.toString('base64')
  console.log(`image: ${IMAGE_PATH} (${statSync(IMAGE_PATH).size} bytes)`)
  console.log(`scenario: NO FPS cap, ${DURATION_S}s peak-throughput per run`)
  console.log()

  const results: RunStats[] = []
  let prevSig = ''
  for (const cfg of SWEEP) {
    const sig = `${cfg.concurrency}|${cfg.batchMode}|${cfg.maxBatchSize ?? 8}`
    if (sig !== prevSig) {
      console.log(
        `>> applying pool settings c=${cfg.concurrency} mode=${cfg.batchMode} maxBatch=${cfg.maxBatchSize ?? 8} (waiting for restart…)`,
      )
      await applyPipelineSettings(fetchFn, token, cfg)
      prevSig = sig
    }
    console.log(`>> running: ${cfg.label}`)
    // Warmup so the model is loaded into the multi-slot cache.
    await trpcPost(fetchFn, token, 'pipelineExecutor.runPipeline', {
      steps: [{ addonId: 'object-detection', modelId: cfg.modelId, enabled: true, children: [] }],
      imageBase64: imgB64,
      nodeId: 'hub',
      sessionId: `warmup-${Date.now()}`,
    }).catch(() => {
      /* ignore */
    })
    const stats = await runOneSweep(fetchFn, token, imgB64, cfg)
    results.push(stats)
    console.log(`   ${formatRow(stats)}`)
  }

  console.log('\n=== summary (sorted by detections/sec desc) ===\n')
  const sorted = [...results].sort((a, b) => b.detsPerSec - a.detsPerSec)
  for (const s of sorted) console.log(formatRow(s))

  // Restore the operator's defaults: concurrency=2, batchMode='' (server picks).
  console.log('\n>> restoring detection-pipeline defaults (concurrency=2, batchMode="")')
  try {
    await trpcPost(fetchFn, token, 'addonSettings.updateGlobalSettings', {
      addonId: 'detection-pipeline',
      nodeId: 'hub',
      patch: { concurrency: 2, batchMode: '', maxBatchSize: 8 },
    })
  } catch (err) {
    console.log(`   (restore: ${err instanceof Error ? err.message : String(err)})`)
  }
}

main().catch((err: unknown) => {
  console.error('FATAL:', err)
  process.exit(1)
})
