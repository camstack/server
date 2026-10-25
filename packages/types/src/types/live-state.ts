import type { BoundingBox } from './io.js'
import type { ObjectState } from './tracked.js'
import type { DetectionEvent } from './events.js'
import type { PipelineStatus } from './pipeline.js'

export interface TrackedObjectSummary {
  readonly trackId: string
  readonly class: string
  readonly originalClass: string
  readonly state: ObjectState
  readonly bbox: BoundingBox
  readonly velocity: { readonly dx: number; readonly dy: number }
  readonly dwellTimeMs: number
  readonly inZones: readonly string[]
  readonly identity?: string
  readonly plateText?: string
  readonly subClass?: string
}

export interface ZoneLiveState {
  readonly zoneId: string
  readonly zoneName: string
  readonly occupied: boolean
  readonly objectCount: number
  readonly objectsByClass: Readonly<Record<string, number>>
  readonly trackIds: readonly string[]
  readonly avgDwellTimeMs: number
  readonly totalEntrancesToday: number
  readonly totalExitsToday: number
  readonly loiteringTracks: readonly string[]
}

export interface CameraLiveState {
  readonly deviceId: string
  readonly lastFrameTimestamp: number
  readonly activeObjects: number
  readonly movingObjects: number
  readonly stationaryObjects: number
  readonly objectCounts: Readonly<Record<string, number>>
  readonly tracks: readonly TrackedObjectSummary[]
  readonly zones: readonly ZoneLiveState[]
  readonly lastEvent?: DetectionEvent
  readonly pipelineStatus: readonly PipelineStatus[]
  readonly avgPipelineMs: number
  readonly currentFps: number
}
