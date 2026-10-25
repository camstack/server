/**
 * Timeline & event types — shared between CamStack app and proxy.
 *
 * Names are unified: the proxy's naming convention is canonical.
 * The app re-exports aliases for backward compatibility where needed.
 */

// ---------------------------------------------------------------------------
// Event severity & motion fragment types
// ---------------------------------------------------------------------------

/** Severity: alert = notable, detection = regular. */
export type TimelineEventSeverity = 'alert' | 'detection'

/** Motion fragment type: start/end from event boundaries, update from motion API. */
export type MotionFragmentType = 'start' | 'end' | 'update'

// ---------------------------------------------------------------------------
// Core timeline types
// ---------------------------------------------------------------------------

/**
 * A detection event for timeline display and grouping.
 * Unified from app's TimelineDetectionEvent and proxy's DetectionEvent.
 */
export interface DetectionEvent {
  id?: string
  timestamp: number
  source?: string
  classes?: string[]
  /** @deprecated Use `classes` instead. Kept for backward compat with some app code. */
  detectionClasses?: string[]
  label?: string
  thumbnailUrl?: string
  imageUrl?: string
  videoUrl?: string
  gifUrl?: string
  severity?: TimelineEventSeverity
  deviceName?: string
  deviceId?: string
  ruleType?: string
  croppedThumbnailUrl?: string
  [key: string]: unknown
}

/**
 * Motion on/off item for timeline bar.
 * Unified from app's TimelineMotionItem and proxy's MotionItem.
 */
export interface MotionItem {
  timestamp: number
  deviceId?: string
  motion: 'on' | 'off'
  /** Fragment type or "motion" | "audio" (AN audio thresholds). */
  type?: MotionFragmentType | 'motion' | 'audio' | string
  /** For type "audio": level 1–5 (threshold crossed). */
  level?: number
  /** For type "audio": dBFS at threshold crossing. */
  dBFS?: number
}

/**
 * Rule artifact for timeline.
 * Unified from app's TimelineArtifactItem and proxy's TimelineArtifact.
 */
export interface TimelineArtifact {
  ruleName: string
  ruleType?: string
  timestamp: number
  imageUrl?: string
  gifUrl?: string
  videoUrl?: string
}

/** Audio level segment for timeline bar. */
export interface AudioLevelSegment {
  start: number
  end: number
  level: number
  dBFS?: number
}

/** Recording segment for timeline bar (where recording exists). */
export interface TimelineRecordingSegment {
  start: number
  end: number
}

// ---------------------------------------------------------------------------
// Day data responses
// ---------------------------------------------------------------------------

/** Day data for timeline (events, motion, artifacts). */
export interface CameraDayDataResponse {
  events: DetectionEvent[]
  motion: MotionItem[]
  artifacts: TimelineArtifact[]
  recordings?: TimelineRecordingSegment[]
}

/** Clustered day data response (server-side bucketing). */
export interface ClusteredDayDataResponse {
  clusters: TimelineCluster[]
  motion: MotionItem[]
  artifacts: TimelineArtifact[]
  motionSegments?: TimelineRecordingSegment[]
  audioLevelSegments?: AudioLevelSegment[]
  recordings?: TimelineRecordingSegment[]
}

// ---------------------------------------------------------------------------
// Clusters & groups
// ---------------------------------------------------------------------------

/** A time-bucketed cluster of detection events. */
export interface TimelineCluster {
  events: DetectionEvent[]
  representative: DetectionEvent
  classes: string[]
  labels: string[]
  startMs: number
  endMs: number
}

/** A group of related detection events with a representative. */
export interface DetectionGroup {
  events: DetectionEvent[]
  representative: DetectionEvent
  classes: string[]
  labels: string[]
}

// ---------------------------------------------------------------------------
// Query types
// ---------------------------------------------------------------------------

/** Query for clustered day data. */
export interface ClusteredDayDataQuery {
  camera: string
  days: string[]
  bucketMs?: number
  enabledClasses?: string[]
  classFilter?: string
}

/** Query for grouped events. */
export interface GroupedEventsQuery {
  after?: number
  before?: number
  limit?: number
  offset?: number
  cameras?: string[]
  detectionClasses?: string[]
  eventSource?: string
  filter?: string
  groupingRange?: number
}

/** Result of grouped events query. */
export interface GroupedEventsResult {
  groups: DetectionGroup[]
  total: number
  ruleArtifacts?: DetectionGroup[]
}

/** Query for events within a cluster time range. */
export interface ClusterEventsQuery {
  camera: string
  startMs: number
  endMs: number
}

/** Result of cluster events query. */
export interface ClusterEventsResult {
  events: DetectionEvent[]
}

// ---------------------------------------------------------------------------
// Reel types
// ---------------------------------------------------------------------------

/** A reel event (carousel-friendly). All timestamps are in **seconds** (Unix epoch). */
export interface ReelEvent {
  id: string
  camera: string
  cameraName: string
  label: string
  /** Unix timestamp in **seconds** (not milliseconds). */
  startTime: number
  thumbnail?: string
  croppedThumbnailUrl?: string
  hasClip?: boolean
  gifUrl?: string
  videoUrl?: string
  imageUrl?: string
  classes?: string[]
}

/** Query for reel events. */
export interface ReelEventsQuery {
  limit?: number
  offset?: number
  cameras?: string[]
  eventSource?: string
  detectionClasses?: string[]
}

/** Result of reel events query. */
export interface ReelEventsResult {
  events: ReelEvent[]
  total: number
}
