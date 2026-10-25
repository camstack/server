/**
 * Pure payload construction for the Detection Pipeline tab.
 *
 * The tab used to assemble these objects inline, and three knobs it drew
 * never reached the run: an `AddonGlobalSettingsForm mode="override"` with
 * no `onOverrideChange` (every edit dropped on the floor while the form
 * printed "applies to this run only"), a button labelled "Run E2E (live
 * path)" that took the `'full'` plane the live path never takes, and a card
 * titled "Benchmark (saves to history)" that never called
 * `saveBenchmarkResult`.
 *
 * Keeping construction here — pure, no React, no trpc — is what makes
 * "does this knob reach the run" a unit assertion instead of a manual pass
 * over a deployed page.
 */
import type { PipelineStepInputOutput } from './benchmark-schemas.js'

/**
 * Execution plane, mirroring `pipelineExecutor.runPipeline`'s field.
 * `'full'` (the cap's default) runs root + crop children in one call —
 * the benchmark/reference-image shape. `'frame'` is the live per-frame
 * dispatch: root-plane steps only, crop children served separately per
 * track via `runDetailSubtree`.
 */
export type BenchPlane = 'full' | 'frame'

/**
 * What the operator asked for, in the three coordinates the pipeline
 * actually works in: an image, a step tree, and a `(node, deviceKey)`
 * pair. `deviceKey` is `<backend>:<device>` — `openvino:npu`,
 * `edgetpu:usb`, `coreml:all`, `cpu`.
 */
export interface PipelineRunRequest {
  readonly steps: readonly PipelineStepInputOutput[]
  readonly imageBase64: string
  readonly nodeId: string
  readonly sessionId: string
  /** Accelerator of `nodeId`. Omitted ⇒ that node's default pool. */
  readonly deviceKey?: string
  readonly plane?: BenchPlane
}

/** The object handed to `addons.custom({addonId:'benchmark', action:'runPipelineTest'})`. */
export interface PipelineRunActionInput {
  readonly steps: readonly PipelineStepInputOutput[]
  readonly imageBase64: string
  readonly nodeId: string
  readonly sessionId: string
  readonly deviceKey?: string
  readonly plane?: BenchPlane
}

export function buildPipelineRunInput(req: PipelineRunRequest): PipelineRunActionInput {
  return {
    steps: req.steps,
    imageBase64: req.imageBase64,
    nodeId: req.nodeId,
    sessionId: req.sessionId,
    ...(req.deviceKey ? { deviceKey: req.deviceKey } : {}),
    ...(req.plane ? { plane: req.plane } : {}),
  }
}
