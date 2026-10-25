/**
 * Detection Analysis Pipeline -- types for tracked detections, sub-detections,
 * recognition results, and audio classification.
 */

import type { VideoFrame } from './camera-pipeline.js'

/**
 * A single detection entry consumed by the analysis pipeline (tracking,
 * zones, session aggregation).
 *
 * Intentionally DIFFERENT from `SpatialDetection` (the engine-level
 * detector output in `types/detection.ts`):
 *   - `SpatialDetection` is raw model output: `{class, bbox:{x,y,w,h},
 *     landmarks?, mask?}`.
 *   - `AnalysisDetection` is the pipeline's view: tuple-bbox
 *     `[x1,y1,x2,y2]`, optional enrichment (`id`, `label`, `zones`,
 *     `previousZones`) added by upstream stages.
 *
 * Renamed from the ambiguous `Detection` on 2026-04-14 to disambiguate
 * from the other Detection types in the codebase (`ObjectDetection`
 * for UI payloads, `SpatialDetection` for engine output).
 */
export interface AnalysisDetection {
  className: string
  score: number
  boundingBox?: [number, number, number, number]
  id?: string
  label?: string
  labelScore?: number
  zones?: string[]
  previousZones?: string[]
}

// --- Detection type const unions ---

export const SUB_DETECTION_TYPES = ['face', 'plate'] as const
export type SubDetectionType = (typeof SUB_DETECTION_TYPES)[number]

export const RECOGNITION_TYPES = ['face', 'plate', 'clip', 'custom'] as const
export type RecognitionType = (typeof RECOGNITION_TYPES)[number]

// --- Analysis Context ---

export interface AnalysisContext {
  readonly deviceId: string
  readonly frame: VideoFrame
  readonly timestamp: number
  readonly rawDetections: readonly AnalysisDetection[]
  readonly trackedDetections: readonly ServerTrackedDetection[]
  readonly events: readonly AnalysisEvent[]
  readonly metadata: Readonly<Record<string, unknown>>
}

// --- Tracked Detection ---

export interface ServerTrackedDetection {
  readonly trackId: string
  readonly detection: AnalysisDetection
  readonly crop?: Buffer
  readonly tracking: TrackingInfo
  readonly subDetections: readonly SubDetection[]
  readonly recognitions: readonly RecognitionResult[]
  readonly zones: readonly string[]
  readonly previousZones: readonly string[]
}

export interface TrackingInfo {
  readonly age: number
  readonly state: 'moving' | 'stationary' | 'new' | 'lost'
  readonly stationaryDuration: number
  readonly velocity: { readonly dx: number; readonly dy: number }
  readonly positionHistory: ReadonlyArray<{
    readonly x: number
    readonly y: number
    readonly t: number
  }>
}

// --- Sub-Detection ---

export interface SubDetection {
  readonly detectionType: SubDetectionType
  readonly boundingBox: readonly [number, number, number, number]
  readonly score: number
  readonly crop?: Buffer
}

// --- Recognition ---

export interface RecognitionResult {
  readonly recognitionType: RecognitionType
  readonly label: string
  readonly score: number
  readonly embedding?: readonly number[]
  readonly metadata?: Readonly<Record<string, unknown>>
}

// --- Analysis Events ---

export interface AnalysisEvent {
  readonly category: string
  readonly severity: 'info' | 'warning' | 'alert'
  readonly detection: ServerTrackedDetection
  readonly description: string
  readonly data: Readonly<Record<string, unknown>>
}

// --- Audio Classifier ---
//
// The canonical `IAudioClassifier` lives in `./audio-analyzer.ts` and is
// derived from the capability definition. The legacy interface that lived
// here had a different shape (readonly ready + release()) and was never
// actually consumed outside of this file — removed to avoid confusion.
