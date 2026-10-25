/**
 * Synthetic-bench custom actions for pipeline-runner.
 *
 * Lets the admin UI drive a production-realistic detection benchmark:
 * the runner — already co-located with detection-pipeline in the
 * `pipeline` group — invokes `api.pipelineExecutor.runPipeline` directly
 * (in-process via localProviderLink, no Moleculer hop), N workers
 * concurrent × M iterations. Returns aggregate stats.
 *
 * Why this exists: the older bench path (UI → benchmark addon → pipeline
 * addon) crosses TWO Moleculer process boundaries that the production
 * camera path does NOT have (broker / runner / detection-pipeline are
 * all in the same group). Running the loop from inside the runner gives
 * fps numbers that match what real cameras achieve.
 */

import { customAction, defineCustomActions } from '@camstack/types'
import { z } from 'zod'
import { BenchStepSchema, type BenchStepShape } from './bench-step-schema.js'
import {
  AbortCapacityRampInputSchema,
  AbortCapacityRampResultSchema,
  CapacityRampOverviewSchema,
  CapacityRampStatusSchema,
  GetCapacityRampStatusInputSchema,
  ListCapacityRampsInputSchema,
  RunCapacityRampAcceptedSchema,
  RunCapacityRampInputSchema,
} from './capacity/capacity-schemas.js'

interface CacheBenchFrameInputShape {
  readonly imageBase64: string
  readonly ttlSeconds?: number
}
interface CacheBenchFrameResultShape {
  readonly frameId: string
  readonly width: number
  readonly height: number
  readonly expiresAt: number
}
export const CacheBenchFrameInputSchema: z.ZodType<CacheBenchFrameInputShape> = z.object({
  imageBase64: z.string(),
  ttlSeconds: z.number().int().positive().optional(),
})
export const CacheBenchFrameResultSchema: z.ZodType<CacheBenchFrameResultShape> = z.object({
  frameId: z.string(),
  width: z.number(),
  height: z.number(),
  expiresAt: z.number(),
})

interface ReleaseBenchFrameInputShape {
  readonly frameId: string
}
interface ReleaseBenchFrameResultShape {
  readonly released: boolean
}
export const ReleaseBenchFrameInputSchema: z.ZodType<ReleaseBenchFrameInputShape> = z.object({
  frameId: z.string(),
})
export const ReleaseBenchFrameResultSchema: z.ZodType<ReleaseBenchFrameResultShape> = z.object({
  released: z.boolean(),
})

interface SyntheticBenchInputShape {
  readonly frameId: string
  readonly steps: readonly BenchStepShape[]
  readonly parallel: number
  readonly iterations: number
  readonly warmup?: number
  /**
   * Correlation id: every `pipeline.progress` line of the run carries it, and
   * it is the key `getSyntheticBenchStatus` / `abortSyntheticBench` are asked
   * by. REQUIRED — a start-then-poll run nobody can name cannot be polled.
   */
  readonly sessionId: string
  /** When true, forces the full runPipeline path (1.2MB pipe transfer per
   * call) instead of the cached inferCached fast path. Simulates the real
   * camera detection pipeline cost including IPC overhead. */
  readonly simulatePipeline?: boolean
  /** Pin every inference (cache + warmup + timed calls) to this node's
   * detection-pipeline provider via `nodePin`. Without it the cap call resolves
   * to the DEFAULT provider and can fail over to another node mid-run (a crash
   * on one device then poisons the measurement). Defaults to the runner's own
   * node, so the bench stays co-located unless an explicit node is requested. */
  readonly nodeId?: string
  /**
   * Inference-device selector of `nodeId`, `<backend>:<device>` — selects
   * WHICH device pool of that node answers. One node can host accelerators
   * whose formats share nothing (`edgetpu:usb` and `openvino:npu` on the
   * same box), so "how fast is this tree on this node" is not a question
   * with one answer. The ONLY pool selector a bench has: the engine override
   * that used to sit beside it swapped the executor's shared engine state
   * under live cameras and is gone (D646).
   *
   * ⚠️ Setting this DISABLES the cached fast path. `cacheFrameInPool` and
   * `inferCached` have no device selector — only `runPipeline` does — so a
   * fast-path bench would device-scope the warmup and leave every timed
   * call on the default pool. See `bench-dispatch.ts`.
   */
  readonly deviceKey?: string
  /**
   * Execution plane forwarded to `runPipeline`. `'frame'` is the live
   * per-frame dispatch (root plane only); omitted is the cap's `'full'`
   * default (root + crop children in one call), which is the benchmark
   * shape, NOT the live one. Also disables the fast path.
   */
  readonly plane?: 'full' | 'frame'
}
export const StartSyntheticBenchInputSchema: z.ZodType<SyntheticBenchInputShape> = z.object({
  frameId: z.string(),
  steps: z.array(BenchStepSchema).min(1),
  parallel: z.number().int().min(1).max(32),
  iterations: z.number().int().min(1).max(10_000),
  warmup: z.number().int().min(0).max(100).optional(),
  sessionId: z.string().min(1),
  simulatePipeline: z.boolean().optional(),
  nodeId: z.string().optional(),
  deviceKey: z.string().optional(),
  plane: z.enum(['full', 'frame']).optional(),
})

interface TimingSplitShape {
  readonly mean: number
  readonly p50: number
  readonly p95: number
  readonly p99: number
}
const TimingSplitSchema: z.ZodType<TimingSplitShape> = z.object({
  mean: z.number(),
  p50: z.number(),
  p95: z.number(),
  p99: z.number(),
})

/**
 * The pool the bench MEASURED — node, device pool, and that pool's resolved
 * provisioning (`pipelineExecutor.getEffectiveTuning {deviceKey}` on that
 * node). `null` fields are "the read failed", never a default (D393).
 */
interface BenchPoolShape {
  readonly nodeId: string
  readonly deviceKey: string | null
  readonly runtime: string | null
  readonly numWorkers: number | null
  readonly concurrency: number | null
  readonly batchMode: string | null
  readonly maxBatchSize: number | null
}
const BenchPoolSchema: z.ZodType<BenchPoolShape> = z.object({
  nodeId: z.string(),
  deviceKey: z.string().nullable(),
  runtime: z.string().nullable(),
  numWorkers: z.number().nullable(),
  concurrency: z.number().nullable(),
  batchMode: z.string().nullable(),
  maxBatchSize: z.number().nullable(),
})

interface SyntheticBenchResultShape {
  readonly runs: number
  readonly wallSec: number
  readonly fps: number
  readonly detectionsPerSec: number
  readonly avgDetections: number
  readonly callMs: TimingSplitShape
  readonly inferMs: number
  readonly preprocessMs: number
  readonly predictMs: number
  readonly batchSizeMean: number
  readonly batchSizeMax: number
  readonly pool: BenchPoolShape
  readonly path: string
}
export const SyntheticBenchResultSchema: z.ZodType<SyntheticBenchResultShape> = z.object({
  runs: z.number(),
  wallSec: z.number(),
  fps: z.number(),
  detectionsPerSec: z.number(),
  avgDetections: z.number(),
  callMs: TimingSplitSchema,
  inferMs: z.number(),
  preprocessMs: z.number(),
  predictMs: z.number(),
  batchSizeMean: z.number(),
  batchSizeMax: z.number(),
  pool: BenchPoolSchema,
  path: z.string(),
})

interface SyntheticBenchProgressShape {
  readonly runs: number
  readonly totalRuns: number
}

/** `startSyntheticBench` answers at once; the run continues in the background. */
export const StartSyntheticBenchAcceptedSchema = z.object({
  accepted: z.literal(true),
  sessionId: z.string(),
})
export const SyntheticBenchKeySchema = z.object({ sessionId: z.string() })

interface SyntheticBenchStatusShape {
  readonly sessionId: string
  readonly state: 'running' | 'done' | 'failed' | 'aborted'
  readonly startedAtMs: number
  readonly finishedAtMs: number | null
  readonly progress: SyntheticBenchProgressShape | null
  readonly result: SyntheticBenchResultShape | null
  readonly error: string | null
}
export const SyntheticBenchStatusSchema: z.ZodType<SyntheticBenchStatusShape | null> = z
  .object({
    sessionId: z.string(),
    state: z.enum(['running', 'done', 'failed', 'aborted']),
    startedAtMs: z.number(),
    finishedAtMs: z.number().nullable(),
    progress: z.object({ runs: z.number(), totalRuns: z.number() }).nullable(),
    result: SyntheticBenchResultSchema.nullable(),
    error: z.string().nullable(),
  })
  .nullable()

export const pipelineRunnerBenchActions = defineCustomActions({
  cacheBenchFrame: customAction(CacheBenchFrameInputSchema, CacheBenchFrameResultSchema, {
    kind: 'mutation',
  }),
  releaseBenchFrame: customAction(ReleaseBenchFrameInputSchema, ReleaseBenchFrameResultSchema, {
    kind: 'mutation',
  }),
  /**
   * START a synthetic bench and return at once (D646). Up to 32 parallel ×
   * 10 000 iterations does not fit the UDS addon-call plane's 60 s request
   * timeout, and a synchronous call was abandoned by its caller while it kept
   * loading the node. Poll `getSyntheticBenchStatus {sessionId}`; stop early
   * with `abortSyntheticBench {sessionId}`. One bench per runner at a time —
   * the measurement owns the pool.
   */
  startSyntheticBench: customAction(
    StartSyntheticBenchInputSchema,
    StartSyntheticBenchAcceptedSchema,
    { kind: 'mutation', auth: 'admin' },
  ),
  getSyntheticBenchStatus: customAction(SyntheticBenchKeySchema, SyntheticBenchStatusSchema),
  abortSyntheticBench: customAction(SyntheticBenchKeySchema, z.object({ aborted: z.boolean() }), {
    kind: 'mutation',
    auth: 'admin',
  }),
  /**
   * OPEN-loop capacity ramp (spec `2026-08-02-capacity-test-design.md` §4):
   * paced N×`fpsPerCamera` single-frame `runPipeline` calls with raw RGB —
   * the exact production dispatch shape (`frame` field, `plane: 'frame'`,
   * per-call sharp encode in the executor) — driven from INSIDE the
   * detection process so frames never cross a process boundary (D9).
   *
   * Fire-and-poll: the ramp runs `steps × (settle+measure)` ≈ tens of
   * minutes, far past the UDS addon-call plane's 60s request timeout, so
   * this action validates + STARTS the run and returns immediately. Poll
   * `getCapacityRampStatus {sessionId}` for progress + the final result;
   * stop early with `abortCapacityRamp {sessionId}`.
   */
  runCapacityRamp: customAction(RunCapacityRampInputSchema, RunCapacityRampAcceptedSchema, {
    kind: 'mutation',
  }),
  getCapacityRampStatus: customAction(GetCapacityRampStatusInputSchema, CapacityRampStatusSchema),
  /**
   * Which node am I, is it quiet, and what ramps does it know about?
   *
   * `getCapacityRampStatus` needs a sessionId and throws without one, which
   * is fine for a script and useless for a page: a ramp outlives the tab that
   * started it, and the node then refuses a second one. This makes recovery,
   * the node assertion and the quiet-node precondition READABLE instead of
   * discovered through a rejection string. Read-only — no `kind: 'mutation'`.
   */
  listCapacityRamps: customAction(ListCapacityRampsInputSchema, CapacityRampOverviewSchema),
  abortCapacityRamp: customAction(AbortCapacityRampInputSchema, AbortCapacityRampResultSchema, {
    kind: 'mutation',
  }),
})

export type PipelineRunnerBenchActions = typeof pipelineRunnerBenchActions

// Explicit TypeScript types — z.infer<> on customAction's stored input/output
// types loses precision through the spec wrapper. Caller code uses these.
export interface BenchStep {
  readonly addonId: string
  readonly modelId: string
  readonly enabled: boolean
  readonly children?: readonly BenchStep[]
}
export interface CacheBenchFrameInput {
  readonly imageBase64: string
  readonly ttlSeconds?: number
}
export interface CacheBenchFrameResult {
  readonly frameId: string
  readonly width: number
  readonly height: number
  readonly expiresAt: number
}
export interface ReleaseBenchFrameInput {
  readonly frameId: string
}
export interface ReleaseBenchFrameResult {
  readonly released: boolean
}
export type SyntheticBenchInput = SyntheticBenchInputShape
export type SyntheticBenchResult = SyntheticBenchResultShape
export type SyntheticBenchPool = BenchPoolShape
export type SyntheticBenchProgress = SyntheticBenchProgressShape
export type SyntheticBenchStatus = SyntheticBenchStatusShape
