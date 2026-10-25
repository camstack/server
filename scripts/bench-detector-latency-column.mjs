#!/usr/bin/env node
/**
 * Fill one Auto-tune detector-latency column (hardwareClass/accelerator).
 *
 * Method (locked in docs/benchmarks/detector-latency.json `_about`):
 *   - models = YOLOv9 t/s/m × 320/640 (plain ONNX) unless --models overrides
 *   - per model: restartAddon(detection-pipeline) → rearm → 1 cold + N warm
 *     runPipelineTest (plane:frame, alone) → p50 = median of warm inferMs
 *   - fps = round(1000 / p50) for single-request columns
 *   - shed / crash → cell omitted (recorded in output.failed)
 *
 * Auth / hub: the `camstack login` session through the shared resolver
 * (scripts/hub/credentials.mjs, same chain as scripts/hub/hub.mjs); run
 * `camstack login <host>` once. --server / --token-file are explicit overrides.
 *
 * Usage:
 *   node scripts/bench-detector-latency-column.mjs \
 *     --node agent-b --device onnx:webgpu \
 *     --column amd-phoenix/amd-igpu \
 *     --out scratchpad/detector-latency-amd-igpu.json
 *
 * Apply into docs + TS is a separate step (skill camstack-benchmark-detection).
 */
import { resolveHubAuth } from './hub/credentials.mjs'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Agent, setGlobalDispatcher } from 'undici'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
setGlobalDispatcher(
  new Agent({ connect: { timeout: 60_000 }, headersTimeout: 600_000, bodyTimeout: 600_000 }),
)

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const AUTO_TUNE_YOLOV9 = [
  'yolov9t-320',
  'yolov9t-640',
  'yolov9s-320',
  'yolov9s-640',
  'yolov9m-320',
  'yolov9m-640',
]

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return fallback
  return process.argv[i + 1] ?? fallback
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`)
}

const { server: HUB, token: TOK } = await resolveHubAuth({
  server: arg('server') ?? undefined,
  tokenFile: arg('token-file') ?? undefined,
})
const NODE = arg('node')
const DEVICE = arg('device')
const COLUMN = arg('column')
const STEP = arg('step', 'object-detection')
const FORMAT = arg('format', 'onnx')
const REF = arg('ref', '3-persons.jpg')
const WARM = Math.max(1, Number(arg('warm', '3')) || 3)
const RECYCLE_MS = Math.max(2000, Number(arg('recycle-ms', '8000')) || 8000)
const OUT = resolve(
  ROOT,
  arg('out', `scratchpad/detector-latency-${COLUMN?.replace('/', '-') ?? 'out'}.json`),
)
const modelsArg = arg('models')
const MODELS = modelsArg
  ? modelsArg
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : AUTO_TUNE_YOLOV9

if (!HUB || !TOK || !NODE || !DEVICE || !COLUMN) {
  console.error(
    'required: --node, --device, --column (and a `camstack login <host>` session)\n' +
      'example: node scripts/bench-detector-latency-column.mjs --node agent-b --device onnx:webgpu --column amd-phoenix/amd-igpu',
  )
  process.exit(2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function median(nums) {
  const a = [...nums].sort((x, y) => x - y)
  const mid = Math.floor(a.length / 2)
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2
}

async function call(method, path, input) {
  const h = { 'content-type': 'application/json', authorization: `Bearer ${TOK}` }
  let url = `${HUB}/trpc/${path}`
  const opt = { method, headers: h }
  if (method === 'POST') opt.body = JSON.stringify({ json: input })
  else if (input !== undefined)
    url += `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`
  let lastErr
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const r = await fetch(url, opt)
      const j = await r.json()
      if (j?.error) {
        throw new Error(String(j.error?.json?.message ?? JSON.stringify(j.error)))
      }
      return j?.result?.data?.json
    } catch (e) {
      lastErr = e
      await sleep(2000 * attempt)
    }
  }
  throw lastErr
}

async function recyclePool() {
  console.log('  restartAddon detection-pipeline…')
  try {
    await call('POST', 'nodes.restartAddon', { nodeId: NODE, addonId: 'detection-pipeline' })
  } catch (e) {
    console.log('  restart err:', String(e.message).slice(0, 160))
  }
  await sleep(RECYCLE_MS)
  try {
    const r = await call('POST', 'pipelineExecutor.rearmInferenceDevice', {
      nodeId: NODE,
      deviceKey: DEVICE,
    })
    console.log('  rearm →', JSON.stringify(r))
  } catch (e) {
    console.log('  rearm err:', String(e.message).slice(0, 160))
  }
}

async function ensureDownloaded(modelId) {
  const list = await call('GET', 'pipelineExecutor.getAddonModels', {
    nodeId: NODE,
    addonId: STEP,
  })
  const entry = Array.isArray(list) ? list.find((m) => m.id === modelId) : null
  const fmt = entry?.formats?.[FORMAT]
  if (fmt?.downloaded) return
  console.log(`  download ${STEP}/${modelId} ${FORMAT}…`)
  await call('POST', 'pipelineExecutor.downloadModel', {
    nodeId: NODE,
    addonId: STEP,
    modelId,
    format: FORMAT,
  })
}

function extractInferMs(result) {
  const first = result?.detections?.[0]
  const fromDet = first?.debug?.stepLatencyMs?.[STEP]
  if (typeof fromDet === 'number' && fromDet > 0) return fromDet
  const timings = result?.debug?.stepTimings
  if (Array.isArray(timings)) {
    const hit = timings.find((t) => t?.source === STEP && typeof t.ms === 'number')
    if (hit && hit.ms > 0) return hit.ms
  }
  const predict = result?.debug?.predictMs
  if (typeof predict === 'number' && predict > 0) return predict
  const total = result?.debug?.totalInferenceMs
  if (typeof total === 'number' && total > 0) return total
  return null
}

async function runOnce(modelId) {
  const t0 = Date.now()
  const result = await call('POST', 'addons.custom', {
    addonId: 'benchmark',
    action: 'runPipelineTest',
    input: {
      nodeId: NODE,
      deviceKey: DEVICE,
      referenceImage: REF,
      plane: 'frame',
      steps: [{ addonId: STEP, enabled: true, modelId, children: [] }],
    },
  })
  const inferMs = extractInferMs(result)
  const timingMs = result?.debug?.stepTimings?.[0]?.ms
  const shed =
    result?.kind === 'shed' ||
    (typeof timingMs === 'number' && timingMs >= 2990) ||
    (typeof inferMs === 'number' && inferMs >= 2990) ||
    (Array.isArray(result?.discarded) &&
      result.discarded.some((d) => /deadline|shed/i.test(String(d?.reason ?? d))))
  return {
    totalMs: Date.now() - t0,
    inferMs,
    det: Array.isArray(result?.detections) ? result.detections.length : 0,
    kind: result?.kind ?? null,
    shed: Boolean(shed),
    shedReason: shed ? 'deadline-or-shed' : null,
  }
}

function classifyError(msg) {
  if (/SIGSEGV|pool death|pool worker is not ready|is backoff/i.test(msg)) return 'crash'
  return 'fail'
}

async function measureModel(modelId) {
  console.log(`=== ${modelId} ===`)
  await ensureDownloaded(modelId)
  await recyclePool()
  let cold
  try {
    cold = await runOnce(modelId)
    console.log(`  cold infer=${cold.inferMs} det=${cold.det} shed=${cold.shed}`)
  } catch (e) {
    const msg = String(e.message)
    return { modelId, status: classifyError(msg), error: msg.slice(0, 400) }
  }
  const warms = []
  for (let i = 0; i < WARM; i += 1) {
    try {
      const w = await runOnce(modelId)
      warms.push(w)
      console.log(`  warm${i + 1} infer=${w.inferMs} det=${w.det} shed=${w.shed}`)
    } catch (e) {
      const msg = String(e.message)
      return {
        modelId,
        status: classifyError(msg),
        error: msg.slice(0, 400),
        cold,
        warms,
      }
    }
  }
  const warmOk = warms.filter((w) => !w.shed && typeof w.inferMs === 'number')
  if (warmOk.length === 0) {
    return { modelId, status: 'shed', cold, warms }
  }
  const p50Ms = Math.round(median(warmOk.map((w) => w.inferMs)) * 10) / 10
  const fps = Math.max(1, Math.round(1000 / p50Ms))
  return {
    modelId,
    status: 'ok',
    cold,
    warms,
    cell: { p50Ms, fps, measured: true },
  }
}

async function main() {
  if (hasFlag('help')) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').slice(0, 1200))
    return
  }
  console.log({ HUB, NODE, DEVICE, COLUMN, FORMAT, WARM, MODELS, OUT })
  const results = []
  for (const modelId of MODELS) {
    results.push(await measureModel(modelId))
  }
  const cells = {}
  const failed = []
  for (const r of results) {
    if (r.status === 'ok' && r.cell) cells[r.modelId] = r.cell
    else failed.push({ modelId: r.modelId, status: r.status, error: r.error ?? null })
  }
  const payload = {
    column: COLUMN,
    nodeId: NODE,
    deviceKey: DEVICE,
    format: FORMAT,
    stepId: STEP,
    referenceImage: REF,
    warmRuns: WARM,
    method:
      'restartAddon(detection-pipeline); rearm; 1 cold + N warm runPipelineTest plane=frame alone; p50=median(warm inferMs); fps=round(1000/p50)',
    measuredAt: new Date().toISOString(),
    cells,
    failed,
    results,
  }
  writeFileSync(OUT, JSON.stringify(payload, null, 2))
  console.log('\n=== cells ===')
  console.log(JSON.stringify(cells, null, 2))
  if (failed.length) {
    console.log('\n=== failed / omitted ===')
    console.log(JSON.stringify(failed, null, 2))
  }
  console.log('\nwrote', OUT)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
