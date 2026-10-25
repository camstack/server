/**
 * How a synthetic bench call is shaped, and which path it may take.
 *
 * Pure, so both rules below are unit-assertable instead of buried in the
 * runner's 200-line `runSyntheticBench`.
 */
import type { FrameInput } from '@camstack/types'
import type { BenchStepShape } from './bench-step-schema.js'

/** Raw frame the bench pins once and replays. */
export type BenchFrame = FrameInput

/** The subset of `runSyntheticBench`'s input that selects a dispatch path. */
export interface BenchPathInput {
  readonly simulatePipeline?: boolean
  readonly deviceKey?: string
  readonly plane?: 'full' | 'frame'
}

/**
 * Why the cached fast path is unavailable, or `null` if nothing blocks it.
 *
 * The fast path is `cacheFrameInPool` once + `inferCached` per call, and
 * NEITHER cap method takes a `deviceKey` or a `plane` — only `runPipeline`
 * does. Forwarding a device selector into it would scope the WARMUP
 * `runPipeline` to the chosen accelerator and leave every TIMED call on the
 * node's default pool: a measurement of the wrong device, reported as the
 * right one. Refusing the fast path costs a slower bench and buys a true
 * number.
 */
export function fastPathRefusalReason(input: BenchPathInput): string | null {
  if (input.deviceKey) {
    return `deviceKey '${input.deviceKey}' requested — inferCached has no device selector, so the timed calls would land on the node's default pool; using the runPipeline path instead`
  }
  if (input.plane) {
    return `plane '${input.plane}' requested — inferCached has no plane selector; using the runPipeline path instead`
  }
  return null
}

/**
 * The cached fast path is only for a plain, single-step, default-device,
 * default-plane inference bench.
 */
export function canUseCachedFastPath(isSingleStep: boolean, input: BenchPathInput): boolean {
  return isSingleStep && !input.simulatePipeline && fastPathRefusalReason(input) === null
}

export interface BenchRunPipelineRequest {
  readonly steps: readonly BenchStepShape[]
  readonly frame: BenchFrame
  readonly deviceKey?: string
  readonly plane?: 'full' | 'frame'
}

export interface BenchRunPipelineInput {
  /**
   * A fresh MUTABLE copy, never the caller's array. The generated
   * `runPipeline` router types `steps` as `unknown[]` and will not accept a
   * `readonly` array; copying satisfies it without handing the router a
   * reference the bench loop still holds.
   */
  readonly steps: BenchStepShape[]
  readonly frame: BenchFrame
  readonly deviceKey?: string
  readonly plane?: 'full' | 'frame'
}

/**
 * Build the `pipelineExecutor.runPipeline` argument for one bench call.
 *
 * Every optional is ABSENT when unset rather than present-and-undefined: an
 * omitted `deviceKey` means "the runner's default device" and an omitted
 * `plane` means the cap's `'full'` default, and the two are not the same as
 * an explicit `undefined` on a `.loose()` router input.
 */
export function buildBenchRunPipelineInput(req: BenchRunPipelineRequest): BenchRunPipelineInput {
  return {
    steps: [...req.steps],
    frame: req.frame,
    ...(req.deviceKey ? { deviceKey: req.deviceKey } : {}),
    ...(req.plane ? { plane: req.plane } : {}),
  }
}

/** Which pool a bench measured — the node it was pinned to, and the device pool. */
export interface BenchPoolTarget {
  readonly nodeId: string
  /** Absent ⇒ the node-default pool. */
  readonly deviceKey?: string
}

/** The `pipelineExecutor.getEffectiveTuning` call for {@link BenchPoolTarget}. */
export interface BenchTuningQuery {
  /** Routing: the node whose pool was measured (passed as `nodePin`). */
  readonly nodeId: string
  readonly input: { readonly deviceKey?: string }
}

/**
 * The tuning query for the pool a bench MEASURED (D646). It asked the node
 * default of whatever node answered first, so an NPU run was recorded beside
 * the onnx pool's `concurrency: 4`. Absent `deviceKey`, never
 * present-and-undefined, for the same `.loose()` reason as
 * {@link buildBenchRunPipelineInput}.
 */
export function buildBenchTuningQuery(target: BenchPoolTarget): BenchTuningQuery {
  return {
    nodeId: target.nodeId,
    input: target.deviceKey ? { deviceKey: target.deviceKey } : {},
  }
}
