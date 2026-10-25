export { AudioAnalyzerAddon, AudioAnalyzerProvider } from './addons/analyzer/index.js'
export type {
  IAudioPipeline,
  AudioChunk,
  AudioPipelineOptions,
  AudioBackend,
  AudioClassificationResult,
} from './audio-pipeline.js'
export { createAudioPipeline } from './audio-pipeline.js'

// Default export — kernel addon-loader prefers mod.default
import { AudioAnalyzerAddon } from './addons/analyzer/index.js'
export default AudioAnalyzerAddon
