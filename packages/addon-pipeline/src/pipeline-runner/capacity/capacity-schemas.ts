/**
 * Zod schemas + explicit TS types for the `runCapacityRamp` /
 * `abortCapacityRamp` custom actions (open-loop capacity test, spec
 * `docs/superpowers/specs/2026-08-02-capacity-test-design.md` §4).
 *
 * Explicit interfaces alongside the schemas (not `z.infer<>`) follow the
 * bench-actions precedent: `z.infer` on customAction's stored types loses
 * precision through the spec wrapper, and callers use these types directly.
 */
import { z } from 'zod'
import { BenchStepSchema, type BenchStepShape } from '../bench-step-schema.js'
import type { CapacityRampStep } from './capacity-runner.js'

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface CapacitySloInput {
  readonly dropRatioMax?: number
  readonly e2eP95MsMax?: number
  readonly stallsMax?: number
}

export interface RunCapacityRampInput {
  /** Pinned frame from the runner's `cacheBenchFrame` (raw RGB, decoded once). */
  readonly frameId: string
  /**
   * Step tree — the node's production ROOT detector. Dispatched with
   * `plane: 'frame'` exactly like the live per-frame path, so crop children
   * are skipped by the executor itself (two-plane design).
   */
  readonly steps: readonly BenchStepShape[]
  /** Cameras per step. Spec default [2,4,8,12,16,20,24,28,32]. */
  readonly ramp?: readonly number[]
  /** Offered rate per camera. Live default 10. */
  readonly fpsPerCamera?: number
  /** Square resize of the pinned frame before the run (one time). Default 640. */
  readonly targetSize?: number
  /** Warm-in seconds per step (load runs, counters do not). Default 30. */
  readonly settleSec?: number
  /** Accounting seconds per step. Default 120. */
  readonly measureSec?: number
  /** Sequential warmup dispatches before step 1 (model load). Default 3. */
  readonly warmupCalls?: number
  /** Stop at the first failing step (spec default true). */
  readonly stopOnFirstFail?: boolean
  /** Correlation id — also the abort key for `abortCapacityRamp`. */
  readonly sessionId: string
  /**
   * Node assertion, NOT routing: when present it must equal the node this
   * runner lives on. The driver is deliberately node-local — a frame that
   * crosses a node (or process) boundary per call measures the transport,
   * not the node, and raw RGB through the hub parent relay is the exact
   * D9 failure mode that OOM'd hub-main.
   */
  readonly nodeId?: string
  /**
   * Inference-device selector (`openvino:npu`, `openvino:gpu`, …) — the only
   * pool selector; there is no engine override (D646).
   */
  readonly deviceKey?: string
  /** SLO overrides. Defaults: dropRatio ≤ 1%, e2e p95 ≤ 250ms, stalls 0. */
  readonly slo?: CapacitySloInput
  /**
   * The measurement requires a quiet node (every local camera `idle`, i.e.
   * paused via `scripts/capacity/pause-restore.mjs`). Set true to override —
   * the result is then contaminated by live traffic and says so.
   */
  readonly allowActiveCameras?: boolean
  /** Bound on waiting for in-flight calls after each step. Default 30. */
  readonly drainTimeoutSec?: number
}

const CapacitySloSchema: z.ZodType<CapacitySloInput> = z.object({
  dropRatioMax: z.number().min(0).max(1).optional(),
  e2eP95MsMax: z.number().min(1).optional(),
  stallsMax: z.number().int().min(0).optional(),
})

export const RunCapacityRampInputSchema: z.ZodType<RunCapacityRampInput> = z.object({
  frameId: z.string(),
  steps: z.array(BenchStepSchema).min(1).readonly(),
  ramp: z.array(z.number().int().min(1).max(64)).min(1).max(20).readonly().optional(),
  fpsPerCamera: z.number().min(1).max(30).optional(),
  targetSize: z.number().int().min(64).max(2048).optional(),
  settleSec: z.number().min(0).max(300).optional(),
  measureSec: z.number().min(5).max(600).optional(),
  warmupCalls: z.number().int().min(0).max(50).optional(),
  stopOnFirstFail: z.boolean().optional(),
  sessionId: z.string(),
  nodeId: z.string().optional(),
  deviceKey: z.string().optional(),
  slo: CapacitySloSchema.optional(),
  allowActiveCameras: z.boolean().optional(),
  drainTimeoutSec: z.number().min(1).max(300).optional(),
})

export const AbortCapacityRampInputSchema = z.object({ sessionId: z.string() })
export const AbortCapacityRampResultSchema = z.object({ aborted: z.boolean() })

/**
 * `runCapacityRamp` returns IMMEDIATELY with an acceptance receipt: the UDS
 * addon-call plane has a hard 60s default request timeout
 * (`DEFAULT_UDS_REQUEST_TIMEOUT_MS`) and custom actions cannot declare a
 * longer one, while a full ramp runs `steps × (settle+measure)` ≈ tens of
 * minutes. The ramp executes in the background; poll
 * `getCapacityRampStatus {sessionId}` for progress and the final result.
 */
export const RunCapacityRampAcceptedSchema = z.object({
  accepted: z.literal(true),
  sessionId: z.string(),
})
export interface RunCapacityRampAccepted {
  readonly accepted: true
  readonly sessionId: string
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface CapacityLatencyDigestShape {
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly max: number
}

export interface CapacityRampStepResult {
  readonly cameras: number
  readonly offered: number
  readonly dispatched: number
  readonly completed: number
  readonly droppedByDriver: number
  readonly shed: number
  readonly errors: number
  readonly unresolvedAtDrain: number
  readonly dropRatio: number
  readonly e2eMs: CapacityLatencyDigestShape
  readonly inferMs: { readonly avg: number; readonly p95: number }
  readonly predictMs: { readonly avg: number; readonly p95: number }
  readonly detectionsAvg: number
  readonly stallCount: number
  readonly stallMaxMs: number
  readonly stallGcMs: number
  readonly stallSyncCount: number
  readonly rssStartMb: number
  readonly rssEndMb: number
  readonly wallMs: number
  readonly pass: boolean
  readonly failReasons: readonly string[]
}

export interface RunCapacityRampResult {
  readonly perStep: readonly CapacityRampStepResult[]
  /** Last passing step's cameras; null when even the first step failed. */
  readonly nMax: number | null
  /** First failing step's cameras; null when every step passed. */
  readonly failedStep: number | null
  /** Engine descriptor from the executor (e.g. `python+openvino`). */
  readonly engineLabel: string
  /**
   * How sheds were identified: `first-class` (`FrameResult.shed` marker),
   * `zero-detections-fallback` (pre-marker executor — fragile convention),
   * `mixed`, or `none` (no sheds observed).
   */
  readonly shedSignal: 'first-class' | 'zero-detections-fallback' | 'mixed' | 'none'
  readonly frame: {
    readonly width: number
    readonly height: number
    readonly payloadBytes: number
    readonly format: 'rgb'
  }
  readonly slo: {
    readonly dropRatioMax: number
    readonly e2eP95MsMax: number
    readonly stallsMax: number
  }
  readonly fpsPerCamera: number
  readonly settleSec: number
  readonly measureSec: number
  readonly nodeId: string
  readonly deviceKey: string | null
  /** True when live cameras were NOT idle during the run (override used). */
  readonly contaminatedByActiveCameras: boolean
  readonly startedAt: string
  readonly wallMs: number
  readonly aborted: boolean
}

const CapacityLatencyDigestSchema: z.ZodType<CapacityLatencyDigestShape> = z.object({
  p50: z.number(),
  p95: z.number(),
  p99: z.number(),
  max: z.number(),
})

const CapacityAvgP95Schema = z.object({ avg: z.number(), p95: z.number() })

const CapacityRampStepResultSchema: z.ZodType<CapacityRampStepResult> = z.object({
  cameras: z.number(),
  offered: z.number(),
  dispatched: z.number(),
  completed: z.number(),
  droppedByDriver: z.number(),
  shed: z.number(),
  errors: z.number(),
  unresolvedAtDrain: z.number(),
  dropRatio: z.number(),
  e2eMs: CapacityLatencyDigestSchema,
  inferMs: CapacityAvgP95Schema,
  predictMs: CapacityAvgP95Schema,
  detectionsAvg: z.number(),
  stallCount: z.number(),
  stallMaxMs: z.number(),
  stallGcMs: z.number(),
  stallSyncCount: z.number(),
  rssStartMb: z.number(),
  rssEndMb: z.number(),
  wallMs: z.number(),
  pass: z.boolean(),
  failReasons: z.array(z.string()).readonly(),
})

export const RunCapacityRampResultSchema: z.ZodType<RunCapacityRampResult> = z.object({
  perStep: z.array(CapacityRampStepResultSchema).readonly(),
  nMax: z.number().nullable(),
  failedStep: z.number().nullable(),
  engineLabel: z.string(),
  shedSignal: z.enum(['first-class', 'zero-detections-fallback', 'mixed', 'none']),
  frame: z.object({
    width: z.number(),
    height: z.number(),
    payloadBytes: z.number(),
    format: z.literal('rgb'),
  }),
  slo: z.object({
    dropRatioMax: z.number(),
    e2eP95MsMax: z.number(),
    stallsMax: z.number(),
  }),
  fpsPerCamera: z.number(),
  settleSec: z.number(),
  measureSec: z.number(),
  nodeId: z.string(),
  deviceKey: z.string().nullable(),
  contaminatedByActiveCameras: z.boolean(),
  startedAt: z.string(),
  wallMs: z.number(),
  aborted: z.boolean(),
})

export interface AbortCapacityRampInput {
  readonly sessionId: string
}
export interface AbortCapacityRampResult {
  readonly aborted: boolean
}

// ---------------------------------------------------------------------------
// Status polling
// ---------------------------------------------------------------------------

export interface CapacityRampProgress {
  /** 0-based index of the step currently running. */
  readonly stepIndex: number
  readonly totalSteps: number
  readonly cameras: number
  readonly phase: 'warmup' | 'settle' | 'measure'
}

/**
 * `state: 'done'` covers aborted runs too — the result's own `aborted` flag
 * distinguishes a deadline finish from a stop, exactly like the sustained
 * runner's raw output.
 */
export interface CapacityRampStatus {
  readonly sessionId: string
  readonly state: 'running' | 'done' | 'failed'
  readonly progress?: CapacityRampProgress
  readonly result?: RunCapacityRampResult
  readonly error?: string
}

const round2 = (v: number): number => Math.round(v * 100) / 100
const round4 = (v: number): number => Math.round(v * 10000) / 10000

/** Flatten one evaluated ramp step into the wire result shape. */
export function toCapacityStepResult(step: CapacityRampStep): CapacityRampStepResult {
  return {
    cameras: step.cameras,
    offered: step.raw.offered,
    dispatched: step.raw.dispatched,
    completed: step.raw.completed,
    droppedByDriver: step.raw.droppedByDriver,
    shed: step.raw.shed,
    errors: step.raw.errors,
    unresolvedAtDrain: step.raw.unresolvedAtDrain,
    dropRatio: round4(step.verdict.dropRatio),
    e2eMs: {
      p50: round2(step.verdict.e2eMs.p50),
      p95: round2(step.verdict.e2eMs.p95),
      p99: round2(step.verdict.e2eMs.p99),
      max: round2(step.verdict.e2eMs.max),
    },
    inferMs: { avg: round2(step.verdict.inferMs.avg), p95: round2(step.verdict.inferMs.p95) },
    predictMs: {
      avg: round2(step.verdict.predictMs.avg),
      p95: round2(step.verdict.predictMs.p95),
    },
    detectionsAvg: round2(step.verdict.detectionsAvg),
    stallCount: step.stall.count,
    stallMaxMs: round2(step.stall.maxMs),
    stallGcMs: round2(step.stall.gcMs),
    stallSyncCount: step.stall.syncCount,
    rssStartMb: step.rssStartMb,
    rssEndMb: step.rssEndMb,
    wallMs: Math.round(step.raw.wallMs),
    pass: step.verdict.pass,
    failReasons: step.verdict.failReasons,
  }
}

export interface GetCapacityRampStatusInput {
  readonly sessionId: string
}

export const GetCapacityRampStatusInputSchema = z.object({ sessionId: z.string() })

const CapacityRampProgressSchema: z.ZodType<CapacityRampProgress> = z.object({
  stepIndex: z.number().int().min(0),
  totalSteps: z.number().int().min(1),
  cameras: z.number().int().min(1),
  phase: z.enum(['warmup', 'settle', 'measure']),
})

export const CapacityRampStatusSchema: z.ZodType<CapacityRampStatus> = z.object({
  sessionId: z.string(),
  state: z.enum(['running', 'done', 'failed']),
  progress: CapacityRampProgressSchema.optional(),
  result: RunCapacityRampResultSchema.optional(),
  error: z.string().optional(),
})

// ---------------------------------------------------------------------------
// Overview — the surface a UI needs and `getCapacityRampStatus` cannot give
// ---------------------------------------------------------------------------

/**
 * Everything a caller needs BEFORE and AFTER it holds a sessionId.
 *
 * `getCapacityRampStatus` answers only "how is session X doing", and it
 * THROWS on a sessionId it does not know. That is enough for a script that
 * owns its own id for the length of one process, and not enough for a page:
 *
 * - a ramp runs for tens of minutes, so the operator will navigate away and
 *   come back with no sessionId — without this, an in-flight ramp can be
 *   neither watched nor aborted, and the node refuses a new one ("one at a
 *   time") through an error string that has to be parsed to recover;
 * - the ramp is node-LOCAL and `addons.custom` reaches exactly one runner, so
 *   a UI must state which node it is measuring. `nodeId` here is the runner
 *   answering, not a guess — a caller that wanted another node can refuse
 *   instead of silently attributing this node's number to it;
 * - the quiet-node requirement is currently discovered by firing the ramp and
 *   reading the rejection. `quiet` / `busyCameras` make it a preflight.
 */
export interface CapacityRampOverview {
  /** The node this runner lives on — the ONLY node these actions can ramp. */
  readonly nodeId: string
  /** Retained finished runs; older ones are pruned and become unknown ids. */
  readonly maxHistory: number
  /** Every local camera is `idle` — the measurement's precondition. */
  readonly quiet: boolean
  readonly busyCameras: readonly number[]
  /** In-flight first-class: the same statuses `getCapacityRampStatus` returns. */
  readonly runs: readonly CapacityRampStatus[]
}

/**
 * `z.object({})`, never `z.void()`: the `addons.custom` envelope insists on
 * an `input` object and a `z.void()` schema rejects `{}` — such an action
 * resolves and can never be called, from a button or from `hub.mjs`.
 */
export const ListCapacityRampsInputSchema = z.object({})

export const CapacityRampOverviewSchema: z.ZodType<CapacityRampOverview> = z.object({
  nodeId: z.string(),
  maxHistory: z.number().int().min(0),
  quiet: z.boolean(),
  busyCameras: z.array(z.number()).readonly(),
  runs: z.array(CapacityRampStatusSchema).readonly(),
})
