import type { BoundingBox } from './io.js'
import type { SpatialDetection } from './detection.js'

export type ObjectState = 'entering' | 'moving' | 'stationary' | 'leaving' | 'loitering'

export interface TrackedDetection extends SpatialDetection {
  readonly trackId: string
  readonly trackAge: number
  readonly velocity?: { readonly dx: number; readonly dy: number }
  readonly path: readonly BoundingBox[]
  /**
   * True when this track was associated to a REAL detection on the frame that
   * produced this emission; false when the track is merely COASTING (the tracker
   * kept it alive inside its coast budget with a frozen/extrapolated bbox — the
   * subject was NOT observed this frame). Consumers that capture per-frame media
   * (thumbnail / keyFrame / snapshot) MUST treat a `false` entry as media-
   * INELIGIBLE: a coasted box is by definition not a current view of the subject,
   * so cropping it yields the empty scene ("crop del nulla", media-bugs RC-3).
   * Optional for backward compatibility — a runner that predates this field emits
   * it absent, and absent should be read as "unknown → treat as matched" so an
   * old runner is never worse than before. The SORT tracker always populates it.
   */
  readonly matchedThisFrame?: boolean
}

export interface TrackedObjectState {
  readonly trackId: string
  readonly state: ObjectState
  readonly stationarySince?: number
  readonly enteredAt: number
  readonly totalDistancePx: number
  readonly dwellTimeMs: number
}
