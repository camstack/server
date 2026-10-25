/**
 * Wire shapes of the node benchmark (D791): the operator's plan, the
 * preflight the confirmation shows, the run the orchestrator owns, what the
 * measuring runner reports, and the result rows Auto tune and the automatic
 * shares read.
 *
 * ONE node at a time, owned by the pipeline orchestrator. While a run is
 * active the cluster is in BENCHMARK MODE for that node: it is not a
 * detection candidate, camera pins naming it are ignored so its sessions move
 * elsewhere, and both come back when the mode ends — after a crash or a hub
 * restart too (a persisted manifest, reconciled against the registry).
 *
 * Two measurements, both on the node, driven by its own runner (frames never
 * cross a process at frame rate, D9):
 *  - `device` — one accelerator × one candidate detector, root only, open
 *    loop: how many streams at the camera rate it carries inside the frame
 *    interval;
 *  - `pipeline` — the chosen detector plus the operator's detail steps
 *    (faces, plates, classifiers, CLIP…), on varied frames from the bench
 *    clip: how many parallel sessions the node carries before latency, drops,
 *    CPU, RAM or the event loop give out.
 */
import { z } from 'zod'

/** Defaults and bounds, one place. */
export const NODE_BENCHMARK_DEFAULTS = {
  fpsPerStream: 10,
  budgetMinutes: 45,
  minBudgetMinutes: 10,
  maxBudgetMinutes: 120,
  /** A result older than this no longer beats the table. */
  staleAfterDays: 30,
  /** Warm-in per ramp step (not accounted). */
  settleSec: 5,
  /** Accounted window per ramp step. */
  measureSec: 20,
  /** Longest the drain may take before the run is refused. */
  drainTimeoutSec: 120,
  /** Candidate models per device in one run. */
  maxModelsPerDevice: 6,
} as const

/** The two measurements a run can make. */
export const NodeBenchmarkPhaseSchema = z.enum(['device', 'pipeline'])
export type NodeBenchmarkPhase = z.infer<typeof NodeBenchmarkPhaseSchema>

export const NodeBenchmarkDevicePlanSchema = z.object({
  /** `<backend>:<device>` — `openvino:npu`, `coreml:all`, `cpu`. */
  deviceKey: z.string().min(1),
  /**
   * Root detector candidates for the `device` measurement, in the order
   * measured. The FIRST is the one the `pipeline` measurement runs.
   */
  modelIds: z.array(z.string().min(1)).min(1).max(NODE_BENCHMARK_DEFAULTS.maxModelsPerDevice),
})
export type NodeBenchmarkDevicePlan = z.infer<typeof NodeBenchmarkDevicePlanSchema>

/** What the operator confirmed. */
export const NodeBenchmarkPlanSchema = z.object({
  nodeId: z.string().min(1),
  devices: z.array(NodeBenchmarkDevicePlanSchema).min(1),
  /** Which measurements run. At least one. */
  phases: z.array(NodeBenchmarkPhaseSchema).min(1).default(['device', 'pipeline']),
  /**
   * Detail steps (catalog step ids under the root: faces, plates,
   * classifiers, CLIP…) the `pipeline` measurement enables. The root
   * detector always runs.
   */
  steps: z.array(z.string().min(1)).default([]),
  /** Offered rate of one stream / session. */
  fpsPerStream: z.number().int().min(1).max(30).default(NODE_BENCHMARK_DEFAULTS.fpsPerStream),
  /** Hard deadline: the mode ends and the cluster is restored when it passes. */
  budgetMinutes: z
    .number()
    .int()
    .min(NODE_BENCHMARK_DEFAULTS.minBudgetMinutes)
    .max(NODE_BENCHMARK_DEFAULTS.maxBudgetMinutes)
    .default(NODE_BENCHMARK_DEFAULTS.budgetMinutes),
  /** Keep the models the run downloaded (default: delete what was not installed before). */
  keepDownloadedModels: z.boolean().default(false),
  /** Start although the other nodes' capacity does not cover the sessions running now. */
  acceptInsufficientHeadroom: z.boolean().default(false),
})
export type NodeBenchmarkPlan = z.infer<typeof NodeBenchmarkPlanSchema>
export type NodeBenchmarkPlanInput = z.input<typeof NodeBenchmarkPlanSchema>

/** Why a run cannot start. `overridable` ones are lifted by a plan flag. */
export const NodeBenchmarkRefusalKindSchema = z.enum([
  'benchmark-active',
  'node-offline',
  'unknown-device',
  'no-phase',
  'insufficient-headroom',
])
export type NodeBenchmarkRefusalKind = z.infer<typeof NodeBenchmarkRefusalKindSchema>

export const NodeBenchmarkRefusalSchema = z.object({
  kind: NodeBenchmarkRefusalKindSchema,
  detail: z.string(),
  overridable: z.boolean(),
})
export type NodeBenchmarkRefusal = z.infer<typeof NodeBenchmarkRefusalSchema>

/** A camera whose detection leaves the node for the run. */
export const NodeBenchmarkMovingCameraSchema = z.object({
  deviceId: z.number(),
  /** Placed on the node now (a standing attach or a running session). */
  placedOnNode: z.boolean(),
  /** A node pin naming this node, ignored for the run. */
  pinnedToNode: z.boolean(),
})
export type NodeBenchmarkMovingCamera = z.infer<typeof NodeBenchmarkMovingCameraSchema>

/** A camera that cannot leave: no other node can obtain its frames. */
export const NodeBenchmarkStayingCameraSchema = z.object({
  deviceId: z.number(),
  reason: z.literal('only-frame-source'),
})
export type NodeBenchmarkStayingCamera = z.infer<typeof NodeBenchmarkStayingCameraSchema>

export const NodeBenchmarkPreflightSchema = z.object({
  nodeId: z.string(),
  online: z.boolean(),
  moving: z.array(NodeBenchmarkMovingCameraSchema).readonly(),
  /** Keep running on the node during the run; the result is flagged contaminated. */
  staying: z.array(NodeBenchmarkStayingCameraSchema).readonly(),
  estimatedDurationMs: z.number(),
  /** The run ends and the cluster is restored at the latest after this long. */
  budgetMs: z.number(),
  phases: z.array(NodeBenchmarkPhaseSchema).readonly(),
  steps: z.array(z.string()).readonly(),
  devices: z.array(NodeBenchmarkDevicePlanSchema).readonly(),
  /** Parallel sessions the cluster runs now, and what the other nodes can carry. */
  headroom: z.object({
    sessionsNow: z.number(),
    otherNodesCapacitySessions: z.number().nullable(),
  }),
  refusals: z.array(NodeBenchmarkRefusalSchema).readonly(),
  canStart: z.boolean(),
})
export type NodeBenchmarkPreflight = z.infer<typeof NodeBenchmarkPreflightSchema>

// ── Runner side ──────────────────────────────────────────────────────

/** Where the measuring runner is. */
export const NodeBenchProgressSchema = z.object({
  phase: z.enum(['preparing', 'device', 'pipeline', 'cleanup']),
  deviceKey: z.string().nullable(),
  modelId: z.string().nullable(),
  /** Streams (device) or sessions (pipeline) of the step running now. */
  load: z.number().nullable(),
  cellsDone: z.number(),
  cellsTotal: z.number(),
  message: z.string(),
})
export type NodeBenchProgress = z.infer<typeof NodeBenchProgressSchema>

/** What limited a ramp. `none` = the ramp ran out of steps still passing. */
export const NodeBenchLimitSchema = z.enum([
  'p95',
  'drops',
  'errors',
  'stall',
  'cpu',
  'ram',
  'none',
])
export type NodeBenchLimit = z.infer<typeof NodeBenchLimitSchema>

export const NodeBenchRampStepSchema = z.object({
  load: z.number(),
  pass: z.boolean(),
  p95Ms: z.number(),
  dropRatio: z.number(),
  /** Completed frames per second over the accounted window. */
  fps: z.number(),
  cpuPct: z.number().nullable(),
  ramFreePct: z.number().nullable(),
  failReasons: z.array(z.string()).readonly(),
})
export type NodeBenchRampStep = z.infer<typeof NodeBenchRampStepSchema>

/** One measured device × detector (the `device` measurement). */
export const NodeBenchDeviceCellSchema = z.object({
  phase: z.literal('device'),
  deviceKey: z.string(),
  modelId: z.string(),
  /** Single-stream latency (the K = 1 step). */
  p50Ms: z.number(),
  p95Ms: z.number(),
  p99Ms: z.number(),
  /** Frames per second sustained at the last passing step. */
  fps: z.number(),
  /** Streams at the camera rate the device carried inside the frame interval; 0 = not even one. */
  kMax: z.number(),
  limitedBy: NodeBenchLimitSchema,
  /** First call (model load + warm-up). */
  warmupMs: z.number(),
  ramp: z.array(NodeBenchRampStepSchema).readonly(),
})
export type NodeBenchDeviceCell = z.infer<typeof NodeBenchDeviceCellSchema>

/** One measured pipeline (the `pipeline` measurement) on a device. */
export const NodeBenchPipelineCellSchema = z.object({
  phase: z.literal('pipeline'),
  deviceKey: z.string(),
  modelId: z.string(),
  steps: z.array(z.string()).readonly(),
  /** Parallel sessions at the camera rate the node carried; 0 = not even one. */
  maxSessions: z.number(),
  limitedBy: NodeBenchLimitSchema,
  /** Detail steps that produced at least one result on the clip — a step that never fired measured nothing. */
  stepsFired: z.array(z.string()).readonly(),
  warmupMs: z.number(),
  ramp: z.array(NodeBenchRampStepSchema).readonly(),
})
export type NodeBenchPipelineCell = z.infer<typeof NodeBenchPipelineCellSchema>

export const NodeBenchCellSchema = z.discriminatedUnion('phase', [
  NodeBenchDeviceCellSchema,
  NodeBenchPipelineCellSchema,
])
export type NodeBenchCell = z.infer<typeof NodeBenchCellSchema>

/**
 * What a result was measured ON. A result whose fingerprint no longer matches
 * the node no longer beats the table.
 */
export const NodeBenchFingerprintSchema = z.object({
  pipelineVersion: z.string().nullable(),
  cpuModel: z.string().nullable(),
  ramGb: z.number().nullable(),
  os: z.string().nullable(),
  /** Per device: the pool the cells ran on (runtime + tuning). */
  pools: z
    .record(
      z.string(),
      z.object({
        runtime: z.string(),
        numWorkers: z.number(),
        concurrency: z.number(),
        batchMode: z.string(),
      }),
    )
    .default({}),
})
export type NodeBenchFingerprint = z.infer<typeof NodeBenchFingerprintSchema>

/** The frames the run used. */
export const NodeBenchClipSchema = z.object({
  /** `camstack-bench-v1` or `reference-images` (the fallback when the clip is not reachable). */
  id: z.string(),
  revision: z.string().nullable(),
  frames: z.number(),
  width: z.number(),
  height: z.number(),
})
export type NodeBenchClip = z.infer<typeof NodeBenchClipSchema>

export const NodeBenchRunnerInputSchema = z.object({
  runId: z.string().min(1),
  devices: z.array(NodeBenchmarkDevicePlanSchema).min(1),
  phases: z.array(NodeBenchmarkPhaseSchema).min(1),
  /** The full detail step tree root for the `pipeline` measurement is built on the node from these ids. */
  steps: z.array(z.string()).default([]),
  fpsPerStream: z.number().int().min(1).max(30),
  /** The runner stops on its own past this instant, whatever the hub does. */
  deadlineAtMs: z.number(),
  settleSec: z.number().min(0).max(60).default(NODE_BENCHMARK_DEFAULTS.settleSec),
  measureSec: z.number().min(2).max(300).default(NODE_BENCHMARK_DEFAULTS.measureSec),
  keepDownloadedModels: z.boolean().default(false),
})
export type NodeBenchRunnerInput = z.infer<typeof NodeBenchRunnerInputSchema>
export type NodeBenchRunnerInputRaw = z.input<typeof NodeBenchRunnerInputSchema>

export const NodeBenchRunnerStateSchema = z.enum(['running', 'done', 'failed', 'aborted'])
export type NodeBenchRunnerState = z.infer<typeof NodeBenchRunnerStateSchema>

export const NodeBenchRunnerStatusSchema = z.object({
  runId: z.string(),
  nodeId: z.string(),
  state: NodeBenchRunnerStateSchema,
  progress: NodeBenchProgressSchema.nullable(),
  /** Every finished cell so far — a run stopped half way keeps what it measured. */
  cells: z.array(NodeBenchCellSchema).readonly(),
  fingerprint: NodeBenchFingerprintSchema.nullable(),
  clip: NodeBenchClipSchema.nullable(),
  /** Cameras seen running on the node during the run (they share its pools). */
  activeCameraIds: z.array(z.number()).readonly(),
  /** Models the run downloaded and then deleted (not installed before). */
  deletedModels: z.array(z.string()).readonly(),
  error: z.string().nullable(),
  startedAtMs: z.number(),
  finishedAtMs: z.number().nullable(),
})
export type NodeBenchRunnerStatus = z.infer<typeof NodeBenchRunnerStatusSchema>

// ── Orchestrator side ────────────────────────────────────────────────

export const NodeBenchmarkStateSchema = z.enum([
  'draining',
  'measuring',
  'restoring',
  'done',
  'failed',
  'aborted',
])
export type NodeBenchmarkState = z.infer<typeof NodeBenchmarkStateSchema>

/** Why a run ended. */
export const NodeBenchmarkEndReasonSchema = z.enum([
  'completed',
  'operator-abort',
  'deadline',
  'node-lost',
  'runner-lost',
  'hub-restart',
  'drain-timeout',
  'failed',
])
export type NodeBenchmarkEndReason = z.infer<typeof NodeBenchmarkEndReasonSchema>

export const NodeBenchmarkRunSchema = z.object({
  runId: z.string(),
  nodeId: z.string(),
  state: NodeBenchmarkStateSchema,
  plan: NodeBenchmarkPlanSchema,
  startedAtMs: z.number(),
  deadlineAtMs: z.number(),
  finishedAtMs: z.number().nullable(),
  endReason: NodeBenchmarkEndReasonSchema.nullable(),
  error: z.string().nullable(),
  /** Cameras moved off the node for the run. */
  moved: z.array(z.number()).readonly(),
  /** Cameras that stayed (their only frame source is the node). */
  staying: z.array(z.number()).readonly(),
  /** Something else ran on the node's pools during the run. */
  contaminated: z.boolean(),
  progress: NodeBenchProgressSchema.nullable(),
  resultIds: z.array(z.string()).readonly(),
})
export type NodeBenchmarkRun = z.infer<typeof NodeBenchmarkRunSchema>

/** `getNodeBenchmarkStatus`: the active run (or the last one), and whether benchmark mode is on. */
export const NodeBenchmarkStatusSchema = z.object({
  /** The node the cluster is in benchmark mode for; null = none. */
  modeNodeId: z.string().nullable(),
  run: NodeBenchmarkRunSchema.nullable(),
})
export type NodeBenchmarkStatus = z.infer<typeof NodeBenchmarkStatusSchema>

/**
 * One stored measurement — the only authority Auto tune and the automatic
 * shares read measured capacity from. Written by the orchestrator when a run
 * ends, never by anyone else.
 */
export const NodeBenchmarkResultSchema = z.object({
  id: z.string(),
  runId: z.string(),
  nodeId: z.string(),
  cell: NodeBenchCellSchema,
  fpsPerStream: z.number(),
  fingerprint: NodeBenchFingerprintSchema.nullable(),
  clip: NodeBenchClipSchema.nullable(),
  /** Other work shared the node's pools (a camera that could not move, or the hub's own duties). */
  contaminated: z.boolean(),
  stayingCameras: z.array(z.number()).readonly(),
  /** The run ended early; the cell itself completed. */
  partialRun: z.boolean(),
  measuredAtMs: z.number(),
})
export type NodeBenchmarkResult = z.infer<typeof NodeBenchmarkResultSchema>

export const ListNodeBenchmarkResultsInputSchema = z.object({
  nodeId: z.string().optional(),
  deviceKey: z.string().optional(),
})
export type ListNodeBenchmarkResultsInput = z.infer<typeof ListNodeBenchmarkResultsInputSchema>

/** A result with its standing today: does it still beat the table? */
export const NodeBenchmarkResultViewSchema = NodeBenchmarkResultSchema.extend({
  /** `fresh` beats the table; `stale` falls back to it; `superseded` = a newer row covers the same cell. */
  standing: z.enum(['fresh', 'stale', 'superseded']),
  staleWhy: z.enum(['age', 'runtime', 'pool-tuning']).nullable(),
})
export type NodeBenchmarkResultView = z.infer<typeof NodeBenchmarkResultViewSchema>

/** The manifest persisted BEFORE benchmark mode changes anything; its presence means "restore". */
export const NodeBenchmarkManifestSchema = z.object({
  runId: z.string(),
  nodeId: z.string(),
  startedAtMs: z.number(),
  deadlineAtMs: z.number(),
  plan: NodeBenchmarkPlanSchema,
  moved: z.array(z.number()).readonly(),
  staying: z.array(z.number()).readonly(),
})
export type NodeBenchmarkManifest = z.infer<typeof NodeBenchmarkManifestSchema>

/** Candidate detectors per device, for the plan editor. */
export const NodeBenchmarkCandidatesSchema = z.object({
  nodeId: z.string(),
  reachable: z.boolean(),
  devices: z
    .array(
      z.object({
        deviceKey: z.string(),
        enabled: z.boolean(),
        available: z.boolean(),
        /** Ordered: what Auto tune would pick first, then the rest of the family by accuracy. */
        suggested: z.array(z.string()).readonly(),
        /** Every root detector the device has a build for. */
        all: z.array(z.string()).readonly(),
        /** The model the device runs now, when pinned. */
        currentModelId: z.string().nullable(),
      }),
    )
    .readonly(),
  /** Detail steps the node's catalog offers under the root (for the `pipeline` measurement). */
  steps: z.array(z.object({ id: z.string(), name: z.string(), slot: z.string() })).readonly(),
})
export type NodeBenchmarkCandidates = z.infer<typeof NodeBenchmarkCandidatesSchema>
