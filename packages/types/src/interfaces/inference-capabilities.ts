import type { ModelFormat } from '../types/models.js'

// ---------------------------------------------------------------------------
// Backend info
// ---------------------------------------------------------------------------

/** A hardware backend available for inference (e.g. CPU, CoreML, CUDA) */
export interface BackendInfo {
  /** Backend identifier — matches engine-resolver backend param */
  readonly id: string
  /** Human-readable label */
  readonly label: string
  /** Whether this backend is available on the current agent/hub */
  readonly available: boolean
  /** Device type for display */
  readonly device: string
}

/** A Python-specific backend with its associated model format */
export interface PythonBackendInfo extends BackendInfo {
  /** The model format this backend needs (coreml → .mlpackage, openvino → .xml, etc.) */
  readonly modelFormat: ModelFormat
  /** Python module required (e.g. 'coremltools', 'openvino', 'torch') */
  readonly pythonModule: string
}

// ---------------------------------------------------------------------------
// Runtime info
// ---------------------------------------------------------------------------

/** Node.js runtime — uses onnxruntime-node, always loads .onnx files */
export interface NodeRuntimeInfo {
  readonly available: true
  /** ONNX execution provider backends (cpu, coreml, cuda, tensorrt) */
  readonly backends: readonly BackendInfo[]
  /** Node.js always uses ONNX format */
  readonly modelFormat: 'onnx'
}

/** Python runtime — uses subprocess with native model formats */
export interface PythonRuntimeInfo {
  readonly available: boolean
  readonly pythonPath?: string
  /** Each Python backend uses a different model format */
  readonly backends: readonly PythonBackendInfo[]
}

/** All runtimes available on an agent/hub */
export interface RuntimeCapabilities {
  readonly node: NodeRuntimeInfo
  readonly python: PythonRuntimeInfo
}

// ---------------------------------------------------------------------------
// Model availability
// ---------------------------------------------------------------------------

/** Download status of a specific model format */
export interface ModelFormatStatus {
  readonly url: string
  readonly sizeMB: number
  readonly downloaded: boolean
  readonly filePath?: string
}

/** A model from the catalog with download status per format */
export interface ModelAvailability {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly inputSize: { readonly width: number; readonly height: number }
  readonly formats: Partial<Readonly<Record<ModelFormat, ModelFormatStatus>>>
}

// ---------------------------------------------------------------------------
// Addon capabilities
// ---------------------------------------------------------------------------

/** Detection addon with its available models */
export interface AddonCapabilityInfo {
  readonly id: string
  readonly name: string
  readonly models: readonly ModelAvailability[]
}

// ---------------------------------------------------------------------------
// Full capabilities response
// ---------------------------------------------------------------------------

/** Complete inference capabilities for an agent/hub */
export interface InferenceCapabilities {
  readonly agentId: string
  readonly agentName: string
  readonly platform: string
  readonly arch: string
  readonly addons: readonly AddonCapabilityInfo[]
  readonly runtimes: RuntimeCapabilities
  readonly modelsDir: string
  /** Platform scores from PlatformScorer — available after boot probe */
  readonly platformScores?: readonly import('./platform.js').PlatformScore[]
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/** Progress event emitted during model download */
export interface ModelDownloadProgress {
  readonly modelId: string
  readonly format: ModelFormat
  readonly downloadedBytes: number
  readonly totalBytes: number
  readonly percent: number
}
