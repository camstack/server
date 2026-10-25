import type { FrameInput, AudioChunkInput } from '../types/io.js'
import type {
  CropInput,
  DetectorOutput,
  CropperOutput,
  ClassifierOutput,
  RefinerOutput,
} from '../types/detection.js'

export interface IVisionEngine {
  process(
    input: FrameInput | CropInput,
  ): Promise<DetectorOutput | CropperOutput | ClassifierOutput | RefinerOutput>
}

export interface IAudioClassificationEngine {
  classifyAudio(input: AudioChunkInput): Promise<ClassifierOutput>
}

export type InferenceEngine = IVisionEngine | IAudioClassificationEngine
