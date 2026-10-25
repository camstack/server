import type { ICamstackAddon } from './addon.js'
import type { FrameInput } from '../types/io.js'
import type { PipelineConfig, PipelineStatus } from '../types/pipeline.js'
import type { DetectionEvent } from '../types/events.js'
import type { FrameResult } from '../types/detection.js'
import type { KnownFace, KnownPlate } from '../types/entities.js'
import type { CameraLiveState, TrackedObjectSummary, ZoneLiveState } from '../types/live-state.js'
import type {
  TrackDetail,
  TrackFilter,
  ZoneHistoryPoint,
  HeatmapData,
  HeatmapOptions,
  TimeRangeOptions,
} from '../types/analytics.js'

export interface ICameraAnalyticsProvider {
  getLiveState(deviceId: string): CameraLiveState | null
  getTracks(deviceId: string, filter?: TrackFilter): TrackedObjectSummary[]
  getZoneState(deviceId: string, zoneId: string): ZoneLiveState | null
  getZoneHistory(
    deviceId: string,
    zoneId: string,
    options: TimeRangeOptions,
  ): Promise<ZoneHistoryPoint[]>
  getHeatmap(deviceId: string, options: HeatmapOptions): Promise<HeatmapData>
  getTrackDetail(deviceId: string, trackId: string): TrackDetail | null
  getCameraStatus(deviceId: string): PipelineStatus[]
}

/**
 * Output of `IAnalysisAddon.processFrame`: the analysis events generated
 * from the frame + an optional enriched `FrameResult` where first-level
 * detections have been tagged with `track` (tracker output: trackId,
 * moving flag, speed, firstSeen/lastSeen). When no `pipelineResult` was
 * supplied, `enrichedFrame` is `null` and the caller keeps its own frame.
 */
export interface AnalysisFrameOutput {
  readonly events: readonly DetectionEvent[]
  readonly enrichedFrame: FrameResult | null
}

export interface IAnalysisAddon extends ICamstackAddon, ICameraAnalyticsProvider {
  /**
   * Process a frame through the analysis pipeline (tracking, scene state,
   * face recognition, etc.) and emit any resulting detection events.
   *
   * The optional `pipelineResult` argument carries the raw per-frame
   * detections from the runner — the analysis pipeline reads
   * `detections[]` for tracking, zone checks, and state analysis. When
   * omitted the analysis pipeline runs on the frame alone (no detection
   * input, only motion / scene-state checks).
   *
   * Returns `{events, enrichedFrame}`: the tracker output is merged back
   * into a new `FrameResult` where each first-level `ObjectDetection`
   * carries its `TrackInfo` (trackId, moving, speed, firstSeen/lastSeen).
   * Consumers should emit `enrichedFrame` instead of the original so the
   * live UI sees track ids on the boxes.
   */
  processFrame(input: {
    deviceId: string
    frame: FrameInput
    pipelineResult?: FrameResult
  }): Promise<AnalysisFrameOutput>
  setCameraPipeline(deviceId: string, config: PipelineConfig): void
  setKnownFaces(faces: KnownFace[]): void
  setKnownPlates(plates: KnownPlate[]): void
  onLiveStateChange(deviceId: string, callback: (state: CameraLiveState) => void): () => void
}
