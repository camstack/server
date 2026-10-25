import type { DetectionRuntime, DetectionDevice } from '../types/config.js'
import type { EngineOutput } from '../types/engine-output.js'

/**
 * Audio inference engine — runs inference on raw waveform data.
 * Parallel to IInferenceEngine (vision/JPEG) but accepts Float32Array waveform input.
 */
export interface IAudioInferenceEngine {
  readonly runtime: DetectionRuntime
  readonly device: DetectionDevice

  /**
   * Run inference on a raw audio waveform.
   *
   * @param waveform - Float32Array of audio samples (typically 16 kHz mono)
   * @param sampleRate - Sample rate of the waveform
   */
  infer(waveform: Float32Array, sampleRate: number): Promise<EngineOutput>

  dispose(): Promise<void>
}
