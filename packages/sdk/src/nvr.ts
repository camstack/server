/**
 * NVR types — system-agnostic types used by providers and the SDK client.
 *
 * These are the canonical types from the proxy's providers/types.ts,
 * now owned by the SDK so both app and proxy can share them.
 */

import type { StreamSourceEntry } from '@camstack/types'

// Re-export StreamSourceEntry so consumers that previously imported StreamOption
// from this module can now import StreamSourceEntry instead.
export type { StreamSourceEntry }

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export interface NvrCamera {
  name: string
  /** Display label (may differ from internal name). */
  label?: string
  enabled: boolean
  hasAudio: boolean
  hasPtz: boolean
  /** Available stream names for this camera (e.g. ["cam_main", "cam_sub"]). */
  streams: string[]
  /** Available streaming options. */
  streamOptions: StreamSourceEntry[]
  /** Accessories/actions available on this camera (siren, floodlight, PTZ, etc.). */
  accessories?: CameraAccessory[]
}

/**
 * A camera accessory — a controllable feature attached to a camera.
 * Declared by the provider, rendered dynamically in the UI.
 */
export interface CameraAccessory {
  /** Unique accessory ID (e.g. "siren", "floodlight", "ptz", "ir_led"). */
  id: string
  /** Display label (e.g. "Siren", "Floodlight"). */
  label: string
  /** Accessory type determines UI rendering. */
  type: 'toggle' | 'button' | 'ptz' | 'slider'
  /** Lucide icon name (e.g. "siren", "lightbulb", "move", "sun"). */
  icon: string
  /** Current state (for toggles: boolean, for sliders: number). */
  state?: unknown
  /** For slider type: min/max/step. */
  min?: number
  max?: number
  step?: number
}

export interface StreamInfo {
  name: string
  /** Camera this stream belongs to (if determinable). */
  camera?: string
}

// ---------------------------------------------------------------------------
// Detection data
// ---------------------------------------------------------------------------

/** Normalized bounding box in 0–1 range (provider-agnostic). */
export interface NormalizedBoundingBox {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** Detection data attached to an event. */
export interface DetectionData {
  label: string
  subLabel?: string
  /** Confidence score 0–1. */
  score: number
  /** Best confidence score observed during the event. */
  topScore?: number
  /** Bounding box of the detected object, normalized 0–1. */
  boundingBox?: NormalizedBoundingBox
  /** Detection region, normalized 0–1. */
  region?: NormalizedBoundingBox
  /** Area as fraction of frame area (0–1). */
  area?: number
  /** Named zones the object is currently in. */
  currentZones?: string[]
  /** Named zones the object has entered during this event. */
  enteredZones?: string[]
  /** Attributes detected (e.g., { face: 0.64, glasses: 0.82 }). */
  attributes?: Record<string, number>
  /** Current estimated speed. */
  currentSpeed?: number
  /** Average estimated speed over the event. */
  averageSpeed?: number
  /** Velocity angle in degrees. */
  velocityAngle?: number
  /** License plate recognition result. */
  licensePlate?: { text: string; score: number }
}

/** Snapshot metadata associated with an event. */
export interface EventSnapshotData {
  boundingBox?: NormalizedBoundingBox
  score?: number
  /** Area as fraction of frame area (0–1). */
  area?: number
  attributes?: Record<string, number>
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface NvrEvent {
  id: string
  camera: string
  label: string
  startTime: number
  endTime: number | null
  severity?: string
  hasClip: boolean
  hasSnapshot: boolean
  thumbnailPath?: string
  snapshotPath?: string
  clipPath?: string
  detection?: DetectionData
  snapshot?: EventSnapshotData
  falsePositive?: boolean
  retainIndefinitely?: boolean
  raw?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Recordings & motion
// ---------------------------------------------------------------------------

export interface RecordingSegment {
  id: string
  camera: string
  startTime: number
  endTime: number
  duration: number
  motion?: number
  objects?: number
  dBFS?: number
}

export interface MotionBucket {
  camera: string
  startTime: number
  motion?: number
  audio?: number
}

// ---------------------------------------------------------------------------
// Live detection (single object in a frame)
// ---------------------------------------------------------------------------

/** Single object detection from a live frame. */
export interface LiveDetection {
  /** Detection class — the object type (person, car, dog, face, plate, etc.) */
  className: string
  /** Recognized identity — face name, license plate text, sub-label. */
  label?: string
  /** Detection confidence 0–1. */
  score: number
  /** Label/recognition confidence 0–1 — takes precedence over score when available. */
  labelScore?: number
  /** Named zones where the object currently is. */
  zones?: string[]
  /** Tracking/correlation ID across frames. */
  id?: string
  /** Bounding box as fractions 0–1 of frame dimensions. */
  boundingBox?: [number, number, number, number] | { x: number; y: number; w: number; h: number }
}

// ---------------------------------------------------------------------------
// Live event data (typed per event type)
// ---------------------------------------------------------------------------

export interface LiveMotionData {
  active: boolean
}

export interface LiveDetectionData {
  detections: LiveDetection[]
  /** Input frame dimensions [width, height] in pixels (for reference). */
  inputDimensions?: [number, number]
  /** Event ID from the NVR. */
  eventId?: string
  /** Provider-specific extra data. */
  [key: string]: unknown
}

export interface LiveAudioData {
  /** Audio metric type (e.g. "dBFS", "rms", "audioDetected", "audioLevel"). */
  metric: string
  /** Numeric value. */
  value?: number
  /** dBFS level. */
  dBFS?: number
  /** RMS level. */
  rms?: number
}

// ---------------------------------------------------------------------------
// Live events (discriminated union)
// ---------------------------------------------------------------------------

export type LiveEventType = 'motion' | 'detection' | 'audio' | 'event' | 'review'

interface LiveEventBase {
  camera: string
  timestamp: number
  /** Provider info — populated by onAllEvents subscription. */
  provider?: { id: string; name: string; type: string }
}

export interface LiveMotionEvent extends LiveEventBase {
  type: 'motion'
  data: LiveMotionData
}

export interface LiveDetectionEvent extends LiveEventBase {
  type: 'detection'
  data: LiveDetectionData
}

export interface LiveAudioEvent extends LiveEventBase {
  type: 'audio'
  data: LiveAudioData
}

export interface LiveGenericEvent extends LiveEventBase {
  type: 'event'
  data: Record<string, unknown>
}

export interface LiveReviewEvent extends LiveEventBase {
  type: 'review'
  data: Record<string, unknown>
}

export type LiveEvent =
  | LiveMotionEvent
  | LiveDetectionEvent
  | LiveAudioEvent
  | LiveGenericEvent
  | LiveReviewEvent

// ---------------------------------------------------------------------------
// Video clips
// ---------------------------------------------------------------------------

export interface VideoClipsQuery {
  camera: string
  after: number
  before: number
  limit?: number
  offset?: number
}

export interface NvrVideoClip {
  id: string
  camera: string
  startTime: number
  endTime: number
  duration: number
  label?: string
  hasClip: boolean
  hasSnapshot: boolean
  source: 'event' | 'recording'
}

export interface VideoClipsResult {
  clips: NvrVideoClip[]
  total: number
}

export interface VideoClipUrlResult {
  url: string
  mimeType: string
}

// ---------------------------------------------------------------------------
// Day data (provider-level, different from timeline CameraDayDataResponse)
// ---------------------------------------------------------------------------

export interface CameraDayData {
  events: NvrEvent[]
  motion: MotionBucket[]
  recordings: RecordingSegment[]
}

// ---------------------------------------------------------------------------
// Camera status (provider-level)
// ---------------------------------------------------------------------------

export interface CameraStatus {
  camera: string
  online: boolean
  recording: boolean
  detecting: boolean
  motionActive: boolean
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface EventsQuery {
  after?: number
  before?: number
  cameras?: string[]
  limit?: number
  labels?: string[]
}

export interface MotionQuery {
  after: number
  before: number
  scale?: number
  cameras?: string[]
}

export interface RecordingsQuery {
  camera: string
  after: number
  before: number
}

export interface NvrConfig {
  type: string
  version?: string
  raw?: unknown
}

// ---------------------------------------------------------------------------
// Provider configs
// ---------------------------------------------------------------------------

export interface ProviderConfigs {
  cameras: Array<{ id: string; name: string }>
  enabledDetectionSources?: string[]
}
