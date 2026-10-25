import type { BoundingBox } from './io.js'
import type { ObjectState } from './tracked.js'
import type { DetectionEvent, EventSnapshot } from './events.js'

export interface TrackFilter {
  readonly class?: readonly string[]
  readonly state?: readonly ObjectState[]
  readonly inZone?: string
  readonly minDwellMs?: number
}

export interface TimeRangeOptions {
  readonly from: number
  readonly to: number
  readonly resolution: 'minute' | '5min' | 'hour'
}

export interface ZoneHistoryPoint {
  readonly timestamp: number
  readonly objectCount: number
  readonly objectsByClass: Readonly<Record<string, number>>
  readonly entrances: number
  readonly exits: number
}

export interface HeatmapOptions {
  readonly from: number
  readonly to: number
  readonly class?: string
  readonly resolution: number
}

export interface HeatmapData {
  readonly width: number
  readonly height: number
  readonly gridSize: number
  readonly cells: Float32Array
  readonly maxCount: number
}

export interface TrackDetail {
  readonly trackId: string
  readonly class: string
  readonly originalClass: string
  readonly state: ObjectState
  readonly firstSeen: number
  readonly lastSeen: number
  readonly totalDwellMs: number
  readonly path: ReadonlyArray<{
    readonly timestamp: number
    readonly bbox: BoundingBox
    readonly velocity: { readonly dx: number; readonly dy: number }
  }>
  readonly identity?: {
    readonly name: string
    readonly confidence: number
    readonly matchedAt: number
  }
  readonly plateText?: {
    readonly text: string
    readonly confidence: number
    readonly readAt: number
  }
  readonly subClass?: { readonly class: string; readonly confidence: number }
  readonly zoneTransitions: ReadonlyArray<{
    readonly zoneId: string
    readonly zoneName: string
    readonly entered: number
    readonly exited?: number
    readonly dwellMs: number
  }>
  readonly bestSnapshot?: EventSnapshot
  readonly events: readonly DetectionEvent[]
}
