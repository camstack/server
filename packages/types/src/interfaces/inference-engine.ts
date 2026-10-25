import type { DetectionRuntime, DetectionDevice } from '../types/config.js'
import type { EngineOutput } from '../types/engine-output.js'
import type { RawFrameFormat } from '../types/io.js'

/**
 * Discriminated input type for `IInferenceEngine.infer`. The engine
 * implementation picks the path based on `kind`:
 *
 * - `jpeg` — encoded JPEG bytes. Backwards-compatible path; the
 *           Python pool decodes via PIL before preprocess.
 * - `raw`  — packed pixel buffer (RGB / BGR / GRAY) with dimensions
 *           and format. Skips the JPEG decode entirely on the Python
 *           side; saves ~10–20ms/frame on the inference hot path.
 *
 * Engine implementations that cannot serve `raw` (e.g. legacy ONNX
 * runtimes that only accept JPEG) should fall back to encoding the
 * raw buffer to JPEG internally rather than throwing — `infer()` must
 * always succeed for either kind.
 */
/**
 * Fields every `InferenceInput` variant carries regardless of pixel transport.
 */
interface InferenceInputCommon {
  /**
   * The camera this frame belongs to — **diagnostic only**. It changes no
   * dispatch decision, no deadline and no shed rule; it exists so an inference
   * failure inside a SHARED pool can name the camera that paid for it.
   *
   * A `SharedInferencePool` serves every camera on its
   * `(node, runtime, device)`, so its `inference request timed out` and
   * `worker saturated` lines could describe the pool and nothing else — and
   * "why is 102 worse than 101?" is the question those lines always get asked.
   *
   * Omitted by callers with no camera (commands, model loads, the benchmark);
   * the failure line then carries no `deviceId` tag rather than a fabricated
   * one.
   */
  readonly deviceId?: number
}

export type InferenceInput =
  | ({ readonly kind: 'jpeg'; readonly data: Buffer } & InferenceInputCommon)
  | ({
      readonly kind: 'raw'
      readonly data: Buffer
      readonly width: number
      readonly height: number
      readonly format: RawFrameFormat
    } & InferenceInputCommon)

export interface IInferenceEngine {
  readonly runtime: DetectionRuntime
  readonly device: DetectionDevice
  infer(input: InferenceInput): Promise<EngineOutput>
  /** Raw tensor run — optional, used by embeddings and other non-detection models */
  run?(input: Float32Array, inputShape: readonly number[]): Promise<Float32Array>
  dispose(): Promise<void>
}
