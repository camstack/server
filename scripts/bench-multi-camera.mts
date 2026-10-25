/**
 * Multi-camera throughput simulator.
 *
 * Spawns N "virtual cameras" — each one fires `runPipeline` (single
 * frame) at a target FPS, sustained for `DURATION_S` seconds. At the
 * end we report aggregate throughput + per-camera latency p50/p95 +
 * detector throughput per camera, mimicking how a real cluster sees
 * load when motion-detection stations are dispatching.
 *
 * The goal is "what configuration tops out closest to the operator's
 * target?" — sweeping `batchMode`, `model`, and `cameraCount`. Output
 * is a CSV-friendly table at the end so you can paste it into
 * spreadsheets.
 *
 * The simulator uses single-frame `pipelineExecutor.runPipeline` (NOT
 * the bench-only `runPipelineBatch`) so the path mirrors the
 * production camera-runtime hot path: motion → cropped frame → 1
 * predict per dispatch.
 */
import { readFileSync, statSync } from 'node:fs'

const SERVER = 'https://localhost:4443'
const IMAGE_PATH =
  '/Users/<local-user>/Documents/Git/camstack/camstack-server/test-output/annotated_persons-cars-animal.jpg'
const DURATION_S = 10
/**
 * The target FPS each "camera" tries to dispatch at. Real motion-
 * detection cameras burst at the source FPS (15-25) only during
 * actual motion; idle cameras don't dispatch. We use 10 fps as a
 * "sustained motion" approximation — the floor the operator wants
 * to keep healthy across the cluster.
 */
const TARGET_FPS_PER_CAMERA = 10

interface SweepConfig {
  readonly label: string
  readonly cameraCount: number
  readonly modelId: string
  readonly batchMode: '' | 'none' | 'list' | 'window'
}

const SWEEP: readonly SweepConfig[] = [
  // Baseline — current default behaviour.
  { label: '1cam yolov9s default', cameraCount: 1, modelId: 'yolov9s', batchMode: '' },
  { label: '3cam yolov9s default', cameraCount: 3, modelId: 'yolov9s', batchMode: '' },
  { label: '6cam yolov9s default', cameraCount: 6, modelId: 'yolov9s', batchMode: '' },

  // batchMode toggle — list packs camera-bursts on the predict thread.
  { label: '6cam yolov9s list', cameraCount: 6, modelId: 'yolov9s', batchMode: 'list' },
  { label: '6cam yolov9s window', cameraCount: 6, modelId: 'yolov9s', batchMode: 'window' },

  // Model swap — yolov9t is 3-4x smaller, should fit ANE pipeline better.
  { label: '6cam yolov9t default', cameraCount: 6, modelId: 'yolov9t', batchMode: '' },
  { label: '6cam yolov9t list', cameraCount: 6, modelId: 'yolov9t', batchMode: 'list' },
  { label: '6cam yolov9t window', cameraCount: 6, modelId: 'yolov9t', batchMode: 'window' },
]

// ── Boilerplate ─────────────────────────────────────────────────────

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
  readonly debug?: { readonly totalInferenceMs?: number }
}

interface PerCameraStats {
  cameraId: number
  framesAttempted: number
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
  readonly totalFps: number
  readonly perCamera: readonly PerCameraStats[]
  readonly p50Latency: number
  readonly p95Latency: number
  readonly p99Latency: number
  readonly p50Infer: number
  readonly p95Infer: number
}

function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p))
  return sorted[idx] ?? 0
}

async function setBatchMode(
  fetchFn: typeof globalThis.fetch,
  token: string,
  batchMode: SweepConfig['batchMode'],
): Promise<void> {
  // Drain any in-flight predicts left over from the previous run
  // (Moleculer rejects settings updates if the worker queue is full).
  await new Promise((r) => setTimeout(r, 2_000))

  // Retry-on-rejection: the patch itself succeeds at the storage
  // layer but the response can race with the addon-restart it
  // triggers (Moleculer "Request is rejected" during nodeOnline race).
  // We retry up to 3× and treat consecutive rejections as success
  // since the patch IS persisted before the rejection fires.
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await trpcPost(fetchFn, token, 'addonSettings.updateGlobalSettings', {
        addonId: 'detection-pipeline',
        nodeId: 'hub',
        patch: { batchMode },
      })
      lastErr = null
      break
    } catch (err) {
      lastErr = err
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('Request is rejected')) {
        // Patch likely already persisted; just wait for restart.
        console.log(
          `   (settings update rejected mid-restart, attempt ${attempt + 1}/3 — likely persisted, continuing)`,
        )
        break
      }
      // Other failure — wait and retry.
      await new Promise((r) => setTimeout(r, 3_000))
    }
  }
  // The addon restarts on `requiresRestart: true`. Wait for the
  // pipeline group to come back before benching.
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
    framesAttempted: 0,
    framesCompleted: 0,
    framesFailed: 0,
    latencies: [],
    inferMs: [],
    detections: 0,
  }))

  const intervalMs = 1000 / TARGET_FPS_PER_CAMERA
  const t0 = Date.now()
  const tEnd = t0 + DURATION_S * 1000

  // Per-camera dispatch loop. Each "camera" awaits its own predict
  // before scheduling the next — simulates "one frame in flight per
  // motion-station" which is what production does (the broker waits
  // for the previous detect to complete before pushing a new frame).
  // If a camera can't keep up at TARGET_FPS, gap grows naturally —
  // measured via `framesCompleted < framesAttempted` and the per-cam
  // delivered FPS.
  const cameraLoops = cameraStates.map((stats) =>
    (async () => {
      while (Date.now() < tEnd) {
        const dispatchStart = Date.now()
        stats.framesAttempted++
        try {
          const r = await trpcPost<FrameResult>(fetchFn, token, 'pipelineExecutor.runPipeline', {
            steps: [
              { addonId: 'object-detection', modelId: config.modelId, enabled: true, children: [] },
            ],
            imageBase64: imgB64,
            nodeId: 'hub',
            sessionId: `sim-cam-${stats.cameraId}-${dispatchStart}`,
          })
          const dispatchEnd = Date.now()
          stats.framesCompleted++
          stats.latencies.push(dispatchEnd - dispatchStart)
          stats.inferMs.push(r.debug?.totalInferenceMs ?? 0)
          stats.detections += r.detections?.length ?? 0
        } catch {
          stats.framesFailed++
        }
        // Pace to TARGET_FPS — sleep the residual to next slot if we
        // finished early. If we ran longer than `intervalMs`, dispatch
        // immediately (back-pressure on the camera).
        const elapsed = Date.now() - dispatchStart
        const sleep = Math.max(0, intervalMs - elapsed)
        if (sleep > 0) await new Promise((r) => setTimeout(r, sleep))
      }
    })(),
  )

  await Promise.all(cameraLoops)
  const durationMs = Date.now() - t0

  const allLatencies: number[] = []
  const allInferMs: number[] = []
  let totalFrames = 0
  for (const s of cameraStates) {
    totalFrames += s.framesCompleted
    allLatencies.push(...s.latencies)
    allInferMs.push(...s.inferMs)
  }

  return {
    config,
    durationMs,
    totalFrames,
    totalFps: (totalFrames * 1000) / durationMs,
    perCamera: cameraStates,
    p50Latency: percentile(allLatencies, 0.5),
    p95Latency: percentile(allLatencies, 0.95),
    p99Latency: percentile(allLatencies, 0.99),
    p50Infer: percentile(allInferMs, 0.5),
    p95Infer: percentile(allInferMs, 0.95),
  }
}

function formatRow(s: RunStats): string {
  const perCamFps = s.totalFps / s.config.cameraCount
  const failures = s.perCamera.reduce((sum, c) => sum + c.framesFailed, 0)
  return [
    s.config.label.padEnd(28),
    `total=${s.totalFps.toFixed(1)}fps`.padEnd(15),
    `per-cam=${perCamFps.toFixed(1)}fps`.padEnd(15),
    `p50=${s.p50Latency}ms`.padEnd(11),
    `p95=${s.p95Latency}ms`.padEnd(11),
    `p99=${s.p99Latency}ms`.padEnd(11),
    `infer p50=${s.p50Infer}ms`.padEnd(15),
    `errors=${failures}`,
  ].join(' ')
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const fetchFn = ignoreTls()
  const token = await login(fetchFn)
  const imgBytes = readFileSync(IMAGE_PATH)
  const imgB64 = imgBytes.toString('base64')
  console.log(`image: ${IMAGE_PATH} (${statSync(IMAGE_PATH).size} bytes)`)
  console.log(`scenario: ${TARGET_FPS_PER_CAMERA} fps/camera target, ${DURATION_S}s per run`)
  console.log()

  const results: RunStats[] = []
  let currentBatchMode: SweepConfig['batchMode'] = '' // server-side default unknown until we set it

  // Group sweeps by batchMode so we restart the addon only when the
  // mode actually changes — restart is the dominant cost (16-18s).
  const groupedBySetting = new Map<string, SweepConfig[]>()
  for (const cfg of SWEEP) {
    const list = groupedBySetting.get(cfg.batchMode) ?? []
    list.push(cfg)
    groupedBySetting.set(cfg.batchMode, list)
  }

  for (const [batchMode, configs] of groupedBySetting) {
    if (batchMode !== currentBatchMode) {
      console.log(
        `>> switching detection-pipeline batchMode → "${batchMode || '(default)'}" (waiting for restart…)`,
      )
      await setBatchMode(fetchFn, token, batchMode as SweepConfig['batchMode'])
      currentBatchMode = batchMode as SweepConfig['batchMode']
    }
    for (const cfg of configs) {
      console.log(`>> running: ${cfg.label}`)
      // Warm-up — first iter pays cold-load. Discard.
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
  }

  // Final report.
  console.log('\n=== summary (sorted by total fps desc) ===\n')
  const sorted = [...results].sort((a, b) => b.totalFps - a.totalFps)
  for (const s of sorted) console.log(formatRow(s))

  console.log('\n=== best per camera count ===\n')
  for (const cams of [1, 3, 6]) {
    const inGroup = results.filter((r) => r.config.cameraCount === cams)
    if (inGroup.length === 0) continue
    const best = inGroup.reduce((best, r) => (r.totalFps > best.totalFps ? r : best), inGroup[0]!)
    console.log(
      `${cams} cam: ${best.config.label}  → ${best.totalFps.toFixed(1)} fps total, ${(best.totalFps / cams).toFixed(1)} per cam`,
    )
  }

  // Restore default batchMode so we don't leave a non-default value
  // hanging in the operator's settings.
  if (currentBatchMode !== '') {
    console.log('\n>> restoring detection-pipeline batchMode → "" (default)')
    await setBatchMode(fetchFn, token, '')
  }
}

main().catch((err: unknown) => {
  console.error('FATAL:', err)
  process.exit(1)
})
