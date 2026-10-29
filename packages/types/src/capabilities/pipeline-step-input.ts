/**
 * The pipeline step-input shape and the run-result bridge, in a module that
 * imports nothing but zod and types.
 *
 * WHY A SEPARATE FILE (addon footprint, D28): both were declared in
 * `pipeline-executor.cap.ts`, whose import evaluates the whole executor schema
 * graph. An addon that only needs these two (the benchmark's `runPipelineTest`
 * action) paid ~130 MB of heap at load. `pipeline-executor.cap.ts` re-exports
 * them, so every existing import keeps working; addon server code takes them
 * from `@camstack/types/addon`.
 */
import { z } from 'zod'
import type { FrameResult } from '../types/detection.js'

// ── Pipeline run input (UI-facing) ──
// Phase 7: dropped generic `confidence`. Per-step thresholds live in
// `settings` (each step declares its own field in `configSchema`); the
// runtime executor falls back to `StepDefinition.defaultConfidence`
// when settings don't override.
export type PipelineStepInputOutput = {
  readonly addonId: string
  readonly modelId?: string
  readonly enabled: boolean
  readonly children?: readonly PipelineStepInputOutput[]
  readonly settings?: Readonly<Record<string, unknown>>
  /**
   * Step-tree device jump (same-node, phase 1). Operator manual override
   * carried from the per-(node,device) BASE
   * (`inferenceDevices[node][deviceKey].steps[step].jumpDeviceKey`): run THIS
   * enrichment step (and its inherited children) on a DIFFERENT enabled device
   * of the SAME node — `<backend>:<device>` (e.g. `openvino:npu`). Absent ⇒ the
   * runner AUTO-jumps only when the effective device's format cannot run the
   * step's model, else the step inherits the effective device. Same-node only.
   */
  readonly jumpDeviceKey?: string
}

export const PipelineStepInputSchema: z.ZodType<PipelineStepInputOutput> = z.lazy(() =>
  z.object({
    addonId: z.string(),
    modelId: z.string().optional(),
    enabled: z.boolean().default(true),
    children: z.array(PipelineStepInputSchema).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    jumpDeviceKey: z.string().optional(),
  }),
)

/** Typed bridge to the recursive `FrameResult` graph; validation is structural. */
export const PipelineRunResultBridge = z.custom<FrameResult>()
