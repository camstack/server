/**
 * `support_benchmark_run` and `support_benchmark_status`.
 *
 * The run measures detector latency the way the repository's benchmark
 * procedure does (D745): per model, recycle the detection pool, one cold run
 * and N warm `benchmark.runPipelineTest` runs on the node x device, median of
 * the warm `inferMs`. It loads the node (the pool restarts between models and
 * a model may be downloaded), so it is gated. The measured medians come back
 * next to the DETECTOR_PERF cell for the same hardware class, accelerator and
 * model, and say how to contribute them.
 *
 * A model whose warm runs were all shed, or that failed, is OMITTED with its
 * reason — never reported as a latency (D393).
 */
import {
  DETECTOR_PERF,
  acceleratorKindOf,
  classifyInferenceHardware,
  type AcceleratorKind,
  type HardwareClassId,
  type HardwareInfo,
} from '@camstack/types'
import {
  runGated,
  type DryRunOutcome,
  type GatedResult,
  type GatedToolSpec,
  type HubClient,
} from '@camstack/develop'
import { z } from 'zod'
import type { McpContext } from './context.js'
import { benchmarkRowFor, type BenchmarkRow } from './ops-accelerators.js'
import {
  readQuery,
  reasonOf,
  withHub,
  type NoSessionResult,
  type RefusedResult,
} from './ops-hub.js'
import { noSessionResult } from './ops-hub.js'
import type { SupportDeps } from './support-deps.js'

export const BENCHMARK_RUN_TOOL = 'support_benchmark_run'

/** The Auto-tune family (D745): YOLOv9 t/s/m at 320 and 640, in the device's native format. */
export const AUTO_TUNE_MODELS: readonly string[] = [
  'yolov9t-320',
  'yolov9t-640',
  'yolov9s-320',
  'yolov9s-640',
  'yolov9m-320',
  'yolov9m-640',
]
/** What a Coral runs by default; the only model Auto tune sizes it at (D912). */
export const CORAL_MODELS: readonly string[] = ['yolov9s-320-edgetpu']

const DETECTOR_STEP = 'object-detection'
const REFERENCE_IMAGE = '3-persons.jpg'
/** A warm run at or above this is the pool's shed deadline, not a latency. */
const SHED_MS = 2990
export const DEFAULT_WARM_RUNS = 3
export const MAX_WARM_RUNS = 10
export const MAX_MODELS = 8
const ACTIVE_RUN_STATES: readonly string[] = ['draining', 'measuring', 'restoring']

export const CONTRIBUTE_HOW: readonly string[] = [
  'The measured medians belong in the Auto-tune latency table: docs/benchmarks/detector-latency.json and packages/types/src/pipeline/auto-tune/detector-performance.ts, changed together (detector-performance.spec.ts fails until they agree), in the camstack/server repository.',
  'Use support_draft_pr with kind "benchmark", the column ("<hardwareClass>/<accelerator>") and these cells to get the branch plan and the `gh pr create` command.',
]

export interface BenchmarkRunArgs {
  readonly nodeId: string
  readonly deviceKey: string
  readonly models?: readonly string[]
  readonly warmRuns?: number
}

const HardwareSchema = z.looseObject({
  platform: z.enum(['darwin', 'linux', 'win32']),
  arch: z.enum(['arm64', 'x64']),
  cpuModel: z.string(),
  cpuCores: z.number(),
  totalRAM_MB: z.number(),
  availableRAM_MB: z.number(),
  gpu: z
    .looseObject({
      type: z.enum(['nvidia', 'amd', 'intel', 'apple']),
      name: z.string(),
    })
    .nullable(),
  npu: z.looseObject({ type: z.enum(['apple-ane', 'intel-npu', 'amd-xdna']) }).nullable(),
})

const InferenceDevicesSchema = z.looseObject({
  reachable: z.boolean(),
  devices: z.array(
    z.looseObject({
      key: z.string(),
      backend: z.string(),
      available: z.boolean(),
      enabled: z.boolean(),
    }),
  ),
})

const RunStatusSchema = z.looseObject({
  run: z
    .looseObject({
      runId: z.string(),
      nodeId: z.string(),
      state: z.string(),
      endReason: z.string().nullable().optional(),
      error: z.string().nullable().optional(),
    })
    .nullable(),
})

const ModelListSchema = z.array(
  z.looseObject({
    id: z.string(),
    formats: z.record(z.string(), z.looseObject({ downloaded: z.boolean().optional() })).optional(),
  }),
)

const PipelineTestSchema = z.looseObject({
  kind: z.string().optional(),
  detections: z
    .array(
      z.looseObject({
        debug: z
          .looseObject({
            stepLatencyMs: z.record(z.string(), z.number()).optional(),
          })
          .optional(),
      }),
    )
    .optional(),
  discarded: z.array(z.unknown()).optional(),
  debug: z
    .looseObject({
      stepTimings: z
        .array(
          z.looseObject({
            source: z.string().optional(),
            ms: z.number().optional(),
          }),
        )
        .optional(),
      predictMs: z.number().optional(),
      totalInferenceMs: z.number().optional(),
    })
    .optional(),
})

/** The model format a device backend runs. */
const FORMAT_BY_BACKEND: { readonly [backend: string]: string } = {
  openvino: 'openvino',
  onnx: 'onnx',
  cpu: 'onnx',
  coreml: 'coreml',
  edgetpu: 'edgetpu',
}

export function formatOf(backend: string): string | null {
  return FORMAT_BY_BACKEND[backend] ?? null
}

export function medianOf(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const hi = sorted[mid] ?? 0
  return sorted.length % 2 === 1 ? hi : ((sorted[mid - 1] ?? hi) + hi) / 2
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function inferMsOf(raw: unknown): {
  readonly inferMs: number | null
  readonly shed: boolean
} {
  const parsed = PipelineTestSchema.safeParse(raw)
  if (!parsed.success) return { inferMs: null, shed: false }
  const r = parsed.data
  const fromDetection = r.detections?.[0]?.debug?.stepLatencyMs?.[DETECTOR_STEP]
  const timing = r.debug?.stepTimings?.find(
    (t) => t.source === DETECTOR_STEP && typeof t.ms === 'number',
  )
  const candidates = [fromDetection, timing?.ms, r.debug?.predictMs, r.debug?.totalInferenceMs]
  const inferMs = candidates.find((c): c is number => typeof c === 'number' && c > 0) ?? null
  const shedReason = (r.discarded ?? []).some((d) =>
    /deadline|shed/i.test(String(JSON.stringify(d))),
  )
  const shed = r.kind === 'shed' || shedReason || (inferMs !== null && inferMs >= SHED_MS)
  return { inferMs, shed }
}

export interface ModelComparison {
  readonly modelId: string
  readonly measuredP50Ms: number
  readonly measuredFps: number
  /** `none`: the table has no cell for this class, accelerator and model. */
  readonly table: 'measured' | 'estimated' | 'none'
  readonly tableP50Ms: number | null
  /** Positive: slower than the table. */
  readonly deltaPct: number | null
}

export interface ModelFailure {
  readonly modelId: string
  readonly status: 'shed' | 'failed'
  readonly reason: string
}

export interface BenchmarkRunResult {
  readonly nodeId: string
  readonly deviceKey: string
  readonly column: string | null
  readonly warmRuns: number
  readonly cells: {
    readonly [modelId: string]: {
      readonly p50Ms: number
      readonly fps: number
      readonly measured: true
    }
  }
  readonly comparison: readonly ModelComparison[]
  readonly omitted: readonly ModelFailure[]
  readonly contribute: readonly string[]
}

interface NodeFacts {
  readonly hardware: HardwareInfo
  readonly hardwareClass: HardwareClassId
  readonly kind: AcceleratorKind | null
  readonly backend: string
  readonly available: boolean
  readonly enabled: boolean
}

type FactsOutcome =
  | { readonly ok: true; readonly facts: NodeFacts }
  | { readonly ok: false; readonly problem: string }

async function readFacts(client: HubClient, args: BenchmarkRunArgs): Promise<FactsOutcome> {
  const [hardware, devices] = await Promise.all([
    readQuery(client, 'platformProbe.getHardware', { nodeId: args.nodeId }, HardwareSchema),
    readQuery(
      client,
      'pipelineOrchestrator.getNodeInferenceDevices',
      { nodeId: args.nodeId },
      InferenceDevicesSchema,
    ),
  ])
  if (!hardware.ok)
    return {
      ok: false,
      problem: `the node's hardware could not be read: ${hardware.reason}`,
    }
  if (!devices.ok)
    return {
      ok: false,
      problem: `the node's devices could not be read: ${devices.reason}`,
    }
  if (!devices.value.reachable) return { ok: false, problem: 'the node is unreachable' }
  const device = devices.value.devices.find((d) => d.key === args.deviceKey)
  if (!device) {
    return {
      ok: false,
      problem: `the node has no device "${args.deviceKey}" (it offers: ${devices.value.devices.map((d) => d.key).join(', ') || 'none'})`,
    }
  }
  const hw: HardwareInfo = {
    platform: hardware.value.platform,
    arch: hardware.value.arch,
    cpuModel: hardware.value.cpuModel,
    cpuCores: hardware.value.cpuCores,
    totalRAM_MB: hardware.value.totalRAM_MB,
    availableRAM_MB: hardware.value.availableRAM_MB,
    gpu: hardware.value.gpu
      ? { type: hardware.value.gpu.type, name: hardware.value.gpu.name }
      : null,
    npu: hardware.value.npu ? { type: hardware.value.npu.type } : null,
  }
  return {
    ok: true,
    facts: {
      hardware: hw,
      hardwareClass: classifyInferenceHardware(hw).hardwareClass,
      kind: acceleratorKindOf(args.deviceKey, hw),
      backend: device.backend,
      available: device.available,
      enabled: device.enabled,
    },
  }
}

function modelsFor(args: BenchmarkRunArgs, kind: AcceleratorKind | null): readonly string[] {
  if (args.models !== undefined && args.models.length > 0) return args.models
  return kind === 'coral' ? CORAL_MODELS : AUTO_TUNE_MODELS
}

function warmRunsOf(args: BenchmarkRunArgs): number {
  return Math.min(MAX_WARM_RUNS, Math.max(1, args.warmRuns ?? DEFAULT_WARM_RUNS))
}

function columnOf(facts: NodeFacts): string | null {
  return facts.kind === null ? null : `${facts.hardwareClass}/${facts.kind}`
}

export interface BenchmarkPlan {
  readonly action: string
  readonly nodeId: string
  readonly deviceKey: string
  readonly hardwareClass: HardwareClassId
  readonly acceleratorKind: AcceleratorKind | null
  readonly column: string | null
  readonly format: string | null
  readonly models: readonly string[]
  readonly warmRuns: number
  readonly currentTableRow: BenchmarkRow | null
  readonly impact: readonly string[]
  readonly contribute: readonly string[]
}

function planOf(args: BenchmarkRunArgs, facts: NodeFacts, format: string | null): BenchmarkPlan {
  return {
    action: 'measure detector latency (warm median per model)',
    nodeId: args.nodeId,
    deviceKey: args.deviceKey,
    hardwareClass: facts.hardwareClass,
    acceleratorKind: facts.kind,
    column: columnOf(facts),
    format,
    models: modelsFor(args, facts.kind),
    warmRuns: warmRunsOf(args),
    currentTableRow: benchmarkRowFor(facts.hardwareClass, facts.kind),
    impact: [
      'The detection pool on that node is restarted before every model, so cameras detected there lose detection for a few seconds each time.',
      'A model that is not downloaded for this format is downloaded first.',
      'Run it when the node is quiet; it takes about a minute per model.',
    ],
    contribute: CONTRIBUTE_HOW,
  }
}

export async function benchmarkDryRun(
  client: HubClient,
  args: BenchmarkRunArgs,
): Promise<DryRunOutcome> {
  const refuse = (problem: string): DryRunOutcome => ({
    confirmable: false,
    describe: { problem },
  })
  const status = await readQuery(
    client,
    'pipelineOrchestrator.getNodeBenchmarkStatus',
    undefined,
    RunStatusSchema,
  )
  if (
    status.ok &&
    status.value.run !== null &&
    ACTIVE_RUN_STATES.includes(status.value.run.state)
  ) {
    return refuse(
      `a node benchmark is already ${status.value.run.state} on ${status.value.run.nodeId}; wait for it to finish`,
    )
  }
  const outcome = await readFacts(client, args)
  if (!outcome.ok) return refuse(outcome.problem)
  const { facts } = outcome
  if (!facts.available)
    return refuse(
      `${args.deviceKey} is listed but not available on ${args.nodeId}; support_diagnose_accelerator says why`,
    )
  if (!facts.enabled) {
    return refuse(
      `${args.deviceKey} is available but not enabled on ${args.nodeId}; enable it in the admin UI (a Coral or CPU device is opt-in) and run again`,
    )
  }
  const format = formatOf(facts.backend)
  if (format === null) return refuse(`no model format is known for backend "${facts.backend}"`)
  return { confirmable: true, describe: planOf(args, facts, format) }
}

type Call = (method: 'GET' | 'POST', path: string, input?: unknown) => Promise<unknown>

async function ensureDownloaded(
  call: Call,
  nodeId: string,
  modelId: string,
  format: string,
): Promise<void> {
  const list = ModelListSchema.safeParse(
    await call('GET', 'pipelineExecutor.getAddonModels', {
      nodeId,
      addonId: DETECTOR_STEP,
    }),
  )
  const entry = list.success ? list.data.find((m) => m.id === modelId) : undefined
  if (entry?.formats?.[format]?.downloaded === true) return
  await call('POST', 'pipelineExecutor.downloadModel', {
    nodeId,
    addonId: DETECTOR_STEP,
    modelId,
    format,
  })
}

async function recyclePool(call: Call, deps: SupportDeps, args: BenchmarkRunArgs): Promise<void> {
  try {
    await call('POST', 'nodes.restartAddon', {
      nodeId: args.nodeId,
      addonId: 'detection-pipeline',
    })
  } catch {
    // The restart may drop its own reply; the rearm below proves the pool is back.
  }
  await deps.sleep(deps.recycleMs)
  await call('POST', 'pipelineExecutor.rearmInferenceDevice', {
    nodeId: args.nodeId,
    deviceKey: args.deviceKey,
  })
}

async function runOnce(
  call: Call,
  args: BenchmarkRunArgs,
  modelId: string,
): Promise<ReturnType<typeof inferMsOf>> {
  const raw = await call('POST', 'addons.custom', {
    addonId: 'benchmark',
    action: 'runPipelineTest',
    input: {
      nodeId: args.nodeId,
      deviceKey: args.deviceKey,
      referenceImage: REFERENCE_IMAGE,
      plane: 'frame',
      steps: [{ addonId: DETECTOR_STEP, enabled: true, modelId, children: [] }],
    },
  })
  return inferMsOf(raw)
}

type ModelOutcome =
  | { readonly ok: true; readonly p50Ms: number; readonly fps: number }
  | { readonly ok: false; readonly failure: ModelFailure }

async function measureModel(
  call: Call,
  deps: SupportDeps,
  args: BenchmarkRunArgs,
  modelId: string,
  format: string,
  warmRuns: number,
): Promise<ModelOutcome> {
  try {
    await ensureDownloaded(call, args.nodeId, modelId, format)
    await recyclePool(call, deps, args)
    await runOnce(call, args, modelId)
    const warm: number[] = []
    for (let i = 0; i < warmRuns; i += 1) {
      const run = await runOnce(call, args, modelId)
      if (!run.shed && run.inferMs !== null) warm.push(run.inferMs)
    }
    if (warm.length === 0) {
      return {
        ok: false,
        failure: {
          modelId,
          status: 'shed',
          reason: `all ${warmRuns} warm runs were shed or returned no timing`,
        },
      }
    }
    const p50Ms = round1(medianOf(warm))
    return { ok: true, p50Ms, fps: Math.max(1, Math.round(1000 / p50Ms)) }
  } catch (err) {
    return {
      ok: false,
      failure: {
        modelId,
        status: 'failed',
        reason: reasonOf(err).slice(0, 300),
      },
    }
  }
}

function compare(
  facts: NodeFacts,
  modelId: string,
  measured: { readonly p50Ms: number; readonly fps: number },
): ModelComparison {
  const cell =
    facts.kind === null ? undefined : DETECTOR_PERF[facts.hardwareClass]?.[facts.kind]?.[modelId]
  return {
    modelId,
    measuredP50Ms: measured.p50Ms,
    measuredFps: measured.fps,
    table: cell === undefined ? 'none' : cell.measured ? 'measured' : 'estimated',
    tableP50Ms: cell === undefined ? null : cell.p50Ms,
    deltaPct:
      cell === undefined ? null : round1(((measured.p50Ms - cell.p50Ms) / cell.p50Ms) * 100),
  }
}

export async function benchmarkExecute(
  client: HubClient,
  args: BenchmarkRunArgs,
  deps: SupportDeps,
): Promise<BenchmarkRunResult> {
  const outcome = await readFacts(client, args)
  if (!outcome.ok) throw new Error(outcome.problem)
  const format = formatOf(outcome.facts.backend)
  if (format === null)
    throw new Error(`no model format is known for backend "${outcome.facts.backend}"`)
  const call: Call = (method, path, input) => client.call(method, path, input)
  const warmRuns = warmRunsOf(args)
  const cells: {
    [modelId: string]: { p50Ms: number; fps: number; measured: true }
  } = {}
  const comparison: ModelComparison[] = []
  const omitted: ModelFailure[] = []
  for (const modelId of modelsFor(args, outcome.facts.kind)) {
    const result = await measureModel(call, deps, args, modelId, format, warmRuns)
    if (result.ok) {
      cells[modelId] = { p50Ms: result.p50Ms, fps: result.fps, measured: true }
      comparison.push(compare(outcome.facts, modelId, result))
    } else {
      omitted.push(result.failure)
    }
  }
  return {
    nodeId: args.nodeId,
    deviceKey: args.deviceKey,
    column: columnOf(outcome.facts),
    warmRuns,
    cells,
    comparison,
    omitted,
    contribute: CONTRIBUTE_HOW,
  }
}

export function benchmarkRunSpec(
  client: HubClient,
  deps: SupportDeps,
): GatedToolSpec<BenchmarkRunArgs> {
  return {
    tool: BENCHMARK_RUN_TOOL,
    dryRun: (args) => benchmarkDryRun(client, args),
    execute: (args) => benchmarkExecute(client, args, deps),
  }
}

export async function supportBenchmarkRun(
  ctx: McpContext,
  deps: SupportDeps,
  args: BenchmarkRunArgs,
  confirmToken: string | undefined,
): Promise<GatedResult | NoSessionResult> {
  const outcome = await ctx.hub()
  if (!outcome.ok) return noSessionResult(outcome)
  if (outcome.connection.tier !== 'admin') {
    return {
      status: 'refused',
      reason: outcome.connection.adminHint ?? 'this credential is not admin-scoped',
    }
  }
  return runGated(ctx.gate, benchmarkRunSpec(outcome.connection.client, deps), args, confirmToken)
}

// ---------------------------------------------------------------------------
// support_benchmark_status (read)

const ResultsSchema = z.array(
  z.looseObject({
    nodeId: z.string(),
    cell: z.looseObject({
      phase: z.string(),
      deviceKey: z.string(),
      modelId: z.string(),
      p50Ms: z.number().optional(),
      fps: z.number().optional(),
    }),
  }),
)

export interface BenchmarkStatusResult {
  readonly status: 'ok'
  readonly run: {
    readonly runId: string
    readonly nodeId: string
    readonly state: string
    readonly endReason: string | null
    readonly error: string | null
  } | null
  /** Per-device latency cells the hub's own node benchmark stored (not the Auto-tune table). */
  readonly storedResults: readonly {
    readonly nodeId: string
    readonly deviceKey: string
    readonly modelId: string
    readonly p50Ms: number | null
    readonly fps: number | null
  }[]
  readonly unavailable: { readonly [part: string]: string }
  readonly note: string
}

const MAX_STORED = 60

export async function supportBenchmarkStatus(
  ctx: McpContext,
  args: { readonly nodeId?: string },
): Promise<BenchmarkStatusResult | NoSessionResult | RefusedResult> {
  return withHub(ctx, async (connection): Promise<BenchmarkStatusResult | RefusedResult> => {
    if (connection.tier !== 'admin') {
      return {
        status: 'refused',
        reason: connection.adminHint ?? 'this credential is not admin-scoped',
      }
    }
    const [status, results] = await Promise.all([
      readQuery(
        connection.client,
        'pipelineOrchestrator.getNodeBenchmarkStatus',
        undefined,
        RunStatusSchema,
      ),
      readQuery(
        connection.client,
        'pipelineOrchestrator.listNodeBenchmarkResults',
        args.nodeId !== undefined ? { nodeId: args.nodeId } : {},
        ResultsSchema,
      ),
    ])
    const unavailable: { [part: string]: string } = {}
    if (!status.ok) unavailable['run'] = status.reason
    if (!results.ok) unavailable['results'] = results.reason
    return {
      status: 'ok',
      run:
        status.ok && status.value.run !== null
          ? {
              runId: status.value.run.runId,
              nodeId: status.value.run.nodeId,
              state: status.value.run.state,
              endReason: status.value.run.endReason ?? null,
              error: status.value.run.error ?? null,
            }
          : null,
      storedResults: results.ok
        ? results.value
            .filter((r) => r.cell.phase === 'device')
            .slice(0, MAX_STORED)
            .map((r) => ({
              nodeId: r.nodeId,
              deviceKey: r.cell.deviceKey,
              modelId: r.cell.modelId,
              p50Ms: r.cell.p50Ms ?? null,
              fps: r.cell.fps ?? null,
            }))
        : [],
      unavailable,
      note: "This is the hub's own node benchmark (capacity ramp). The Auto-tune latency table is filled with support_benchmark_run.",
    }
  })
}
