import type { DetectionEventType } from './events.js'

export type DetectionRuntime = 'onnx' | 'coreml' | 'pytorch' | 'openvino' | 'tflite'
export type DetectionDevice = 'cpu' | 'gpu-cuda' | 'gpu-mps' | 'npu' | 'coral-edgetpu' | 'tensorrt'
export type ProbeCapability = 'fp32' | 'fp16' | 'int8' | 'batch-inference'

export interface ProbeResult {
  readonly available: boolean
  readonly runtime: DetectionRuntime
  readonly device: DetectionDevice
  readonly capabilities: readonly ProbeCapability[]
  readonly estimatedMemoryMB?: number
}

export interface CameraAnalysisConfig {
  readonly tracker: {
    readonly maxAge: number
    readonly minHits: number
    readonly iouThreshold: number
  }
  readonly stateAnalyzer: {
    readonly stationaryThresholdSec: number
    readonly loiteringThresholdSec: number
    readonly velocityThreshold: number
  }
  readonly snapshots: {
    readonly enabled: boolean
    readonly saveThumbnail: boolean
    readonly saveAnnotatedFrame: boolean
    readonly saveDebugThumbnails: boolean
    readonly clipPreSec: number
    readonly clipPostSec: number
  }
  readonly events: {
    readonly minTrackAge: number
    readonly cooldownSec: number
    readonly enabledTypes: readonly DetectionEventType[]
  }
}
