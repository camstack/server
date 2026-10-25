import type { BoundingBox } from './io.js'
import type { Classification } from './detection.js'
import type { TrackedDetection, TrackedObjectState } from './tracked.js'

export type DetectionEventType =
  | 'object.detected'
  | 'object.classified'
  | 'object.entering'
  | 'object.leaving'
  | 'object.stationary'
  | 'object.loitering'
  | 'zone.enter'
  | 'zone.exit'
  | 'tripwire.cross'
  | 'audio.detected'

export type TrackEventType =
  | 'track.new'
  | 'track.update'
  | 'track.stationary'
  | 'track.moving'
  | 'track.zone-enter'
  | 'track.zone-exit'
  | 'track.zone-dwell'
  | 'track.ended'

export type AnalysisEventType = DetectionEventType | TrackEventType

export interface ZoneEvent {
  readonly type: 'zone-enter' | 'zone-exit' | 'zone-loiter' | 'tripwire-cross'
  readonly zoneId: string
  readonly zoneName: string
  readonly trackId: string
  readonly detection: TrackedDetection
  readonly direction?: 'in' | 'out' | 'left' | 'right'
  readonly timestamp: number
}

export interface EventSnapshot {
  readonly thumbnailPath: string
  readonly annotatedFramePath: string
  readonly debugThumbnails?: Readonly<Record<string, string>>
  readonly clipPath?: string
  readonly clipDurationSec?: number
}

export interface DetectionEvent {
  readonly id: string
  readonly type: DetectionEventType
  readonly timestamp: number
  readonly deviceId: string
  readonly detection: TrackedDetection
  readonly classifications: readonly Classification[]
  readonly objectState: TrackedObjectState
  readonly zoneEvents: readonly ZoneEvent[]
  readonly snapshot?: EventSnapshot
  readonly trackPath: readonly BoundingBox[]
}
