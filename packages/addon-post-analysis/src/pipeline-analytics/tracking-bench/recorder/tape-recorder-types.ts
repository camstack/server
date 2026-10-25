/**
 * The tape recorder's public shapes (D681), apart from the class so a reader
 * of a status or a caller building an input does not import the recorder
 * itself (`tape-status.ts`, `index.ts`, Task 12's promotion).
 */
import type { FrameResult, IScopedLogger } from '@camstack/types'
import type { FrameObservation } from '../../pipeline/frame-observation.js'
import type { StationaryEntry } from '../../pipeline/stationary/stationary-types.js'
import type { TrackDropReason, TrackFusion } from '../../pipeline/tracker-v2/index.js'
import type { TapeLighting, TapePlane, TapeScene } from '../tape-schema.js'
import type { FacePseudonymizer } from './frame-record.js'
import type { TapeSink } from './segment-writer.js'

export interface TapeRecorderDeps {
  readonly segmentFile: (deviceId: number, originMs: number) => string
  readonly openSink: (file: string) => Promise<TapeSink>
  readonly lighting: (deviceId: number, atMs: number) => Promise<TapeLighting>
  readonly stationaryEntries: (deviceId: number) => readonly StationaryEntry[]
  readonly faces: FacePseudonymizer
  readonly logger: IScopedLogger
  readonly mintTapeId: () => string
  readonly onSegmentClosed: (deviceId: number) => void
  /** This recorder's session id, minted once per start (one per boot) and
   *  stamped on every segment header — see `TapeHeaderSchema.session`. */
  readonly session: string
  readonly now: () => number
  readonly maxRawBytes?: number
}

export interface TapeFrameInput {
  readonly deviceId: number
  readonly plane: TapePlane
  readonly frame: FrameResult
  readonly injectedIds: ReadonlySet<string>
  readonly observation: FrameObservation
  readonly scene: TapeScene
}

export interface TapeSkipInput {
  readonly deviceId: number
  readonly plane: TapePlane
  readonly frame: FrameResult
}

export interface TapeDropInput {
  readonly deviceId: number
  readonly plane: TapePlane
  readonly trackId: string
  readonly atMs: number
  /** Why the processor ended the chain (D683 round 4) — 'dropped' (never
   *  linked) or 'stationary' (a promoted subject that moved; linkable). The
   *  replay must apply the SAME reason to reproduce live's close behaviour
   *  (`ProcessorTracker.applyDrop`). */
  readonly reason: TrackDropReason
}

/** An L2 fusion the live tracker committed (D683), from a frame or the sweep. */
export interface TapeFusionInput {
  readonly deviceId: number
  readonly plane: TapePlane
  readonly fusion: TrackFusion
}

/** Whether every open segment closed before `stopAll`'s deadline. */
export type TapeStopOutcome = 'stopped' | 'timed-out'

export type TapeCameraState = 'off' | 'recording' | 'failing'

export interface TapeCameraStatus {
  readonly deviceId: number
  readonly state: TapeCameraState
  readonly reason?: string
  readonly segmentOriginMs?: number
  readonly framesInSegment: number
  readonly rawBytesInSegment: number
  readonly framesSinceArmed: number
  readonly gapsSinceArmed: number
  readonly segmentsSinceArmed: number
  readonly armedSinceMs?: number
}
