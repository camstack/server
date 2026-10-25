import type { DetectorOutput, CropperOutput, ClassifierOutput, RefinerOutput } from './detection.js'
import type { ModelFormat } from './models.js'

export type PipelineSlot = 'detector' | 'cropper' | 'classifier' | 'refiner' | 'audio-classifier'

/**
 * The selected inference environment — one per pipeline process.
 * User picks this; all pipeline steps run within it.
 */
export interface PipelineEngineChoice {
  /** Every model runs in a Python pool; the `'node'` runtime is gone. */
  readonly runtime: 'python'
  readonly backend: string
  readonly format: ModelFormat
  /** Target hardware device within the backend (e.g., 'cpu', 'gpu', 'npu', 'ane', 'auto', 'all') */
  readonly device?: string
}

/** Available devices for a specific engine backend */
export interface EngineDeviceInfo {
  readonly id: string
  readonly label: string
  readonly description?: string
}

export interface PipelineNode {
  readonly step: string
  readonly addon: string
  /** Per-step overrides — only modelId + confidence. Runtime/backend come from engine. */
  readonly configOverride?: Readonly<Record<string, unknown>>
  readonly children?: readonly PipelineNode[]
}

export interface PipelineConfig {
  /** The inference environment for ALL video steps in this pipeline */
  readonly engine: PipelineEngineChoice
  readonly video: readonly PipelineNode[]
  readonly audio?: PipelineNode
  /** Independent engine for audio classification (audio pipeline has its own runtime) */
  readonly audioEngine?: PipelineEngineChoice
}

export interface PipelineStatus {
  readonly addon: string
  readonly slot: PipelineSlot
  readonly state: 'initializing' | 'ready' | 'running' | 'error'
  readonly error?: string
  readonly lastRunMs?: number
}

export interface StepError {
  readonly code: string
  readonly message: string
  readonly childrenSkipped: boolean
}

export interface StepResult {
  readonly addon: string
  readonly slot: PipelineSlot
  readonly output: DetectorOutput | CropperOutput | ClassifierOutput | RefinerOutput
  readonly parentResultId?: string
  readonly resultId: string
  readonly inferenceMs: number
  readonly preprocessMs: number
  readonly totalMs: number
  readonly error?: StepError
}

export interface PipelineResult {
  readonly results: readonly StepResult[]
  readonly totalMs: number
  readonly timings: Readonly<Record<string, number>>
  readonly frameTimestamp: number
}
