import type { DetectionRuntime, DetectionDevice } from '../types/config.js'

/**
 * Raw tensor inference engine — runs inference on pre-processed tensor data.
 * Used by addons that need custom preprocessing (e.g. CLIP embedding encoder).
 *
 * Unlike IInferenceEngine (JPEG in → EngineOutput out), this accepts
 * raw Float32Array tensors with explicit shapes.
 */
export interface IRawTensorEngine {
  readonly runtime: DetectionRuntime
  readonly device: DetectionDevice

  /** Run inference on a pre-processed tensor */
  run(input: Float32Array, inputShape: readonly number[]): Promise<Float32Array>

  dispose(): Promise<void>
}
