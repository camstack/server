import type { FrameInput, AudioChunkInput } from '../types/io.js'
import type {
  CropInput,
  DetectorOutput,
  CropperOutput,
  ClassifierOutput,
  RefinerOutput,
} from '../types/detection.js'
import type {
  PipelineConfig,
  PipelineResult,
  StepResult,
  PipelineStatus,
} from '../types/pipeline.js'

export interface IPipelineRunner {
  run(frame: FrameInput, config?: PipelineConfig): Promise<PipelineResult>
  runSingle(
    addonId: string,
    input: FrameInput | CropInput,
    config?: Record<string, unknown>,
  ): Promise<StepResult>
  getStatus(): PipelineStatus[]
}

export interface ValidationIssue {
  readonly step?: string
  readonly addon?: string
  readonly message: string
  readonly severity: 'error' | 'warning'
}

export interface ValidationResult {
  readonly valid: boolean
  readonly errors: readonly ValidationIssue[]
  readonly warnings: readonly ValidationIssue[]
}

export interface IPipelineValidator {
  validate(config: PipelineConfig): ValidationResult
}

/** Output type from any inference addon */
export type InferenceOutput = DetectorOutput | CropperOutput | ClassifierOutput | RefinerOutput

/** Callable addon instance — the result of resolving an addon */
export interface IAddonCaller {
  /** Run inference on a frame or crop */
  process(input: FrameInput | CropInput): Promise<InferenceOutput>
  /** Classify an audio chunk (optional — only audio addons implement this) */
  classifyAudio?(input: AudioChunkInput): Promise<ClassifierOutput>
}

/** Resolves addon IDs to callable instances — abstracts transport (in-process, forked, remote) */
export interface IAddonResolver {
  /** Get a callable addon for the given ID and config */
  resolve(addonId: string, config: Record<string, unknown>): Promise<IAddonCaller>
  /** Shutdown all resolved addons */
  shutdownAll(): Promise<void>
}
