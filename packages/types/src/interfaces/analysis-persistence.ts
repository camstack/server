/**
 * Analysis Persistence Types — interfaces for event persistence, track trails,
 * retention, session tracking, and known faces.
 *
 * These interfaces define the contracts used by the server; concrete
 * implementations live in addon-analytics and are received via CapabilityRegistry.
 */

import type { ServerTrackedDetection } from './server-analysis.js'

// ---------------------------------------------------------------------------
// Event Persistence
// ---------------------------------------------------------------------------

export interface ObjectSnapshotResult {
  readonly trackId: string
  readonly thumbnail?: Buffer
  readonly fullCrop?: Buffer
}

export interface AnnotatedSnapshotResult {
  readonly thumbnail: Buffer
  readonly full: Buffer
}

export interface PersistableEvent {
  readonly id: string
  readonly timestamp: number
  readonly deviceId: string
  readonly category: string
  readonly className: string
  readonly score: number
  readonly trackId: string
  readonly severity: string
  readonly description: string
  readonly data: Record<string, unknown>
  readonly mediaFiles: readonly string[]
}

export interface EventBufferStatus {
  readonly eventCount: number
  readonly mediaCount: number
  readonly mediaSizeMB: number
}

export type TrackMediaType =
  | 'crop-thumb'
  | 'crop-full'
  | 'debug-annotated-thumb'
  | 'debug-annotated-full'
  | 'original'
  | 'original-thumb'
  | 'inline-crop'
  | 'unknown'

export interface TrackMediaFile {
  readonly path: string
  readonly type: TrackMediaType
  readonly data: Buffer
  readonly source: 'buffer' | 'storage'
}

// ---------------------------------------------------------------------------
// Track Trail
// ---------------------------------------------------------------------------

// F15c: `enabled` removed — trail capture on/off lives on the
// `track-trail` wrapper binding. See capabilities/track-trail.cap.ts.
export interface TrackCaptureConfig {
  readonly snapshotIntervalMs: number
  readonly maxTrailLength: number
  readonly saveThumbnails: boolean
  readonly thumbnailSize: { readonly width: number; readonly height: number }
}

export interface TrackPosition {
  readonly x: number
  readonly y: number
  readonly timestamp: number
  readonly bbox: [number, number, number, number]
}

export interface TrackSnapshot {
  readonly timestamp: number
  readonly position: TrackPosition
  readonly thumbnailPath: string
}

export interface TrackTrail {
  readonly trackId: string
  readonly deviceId: number
  readonly className: string
  readonly label?: string
  readonly firstSeen: number
  readonly lastSeen: number
  readonly positions: readonly TrackPosition[]
  readonly snapshots: readonly TrackSnapshot[]
  readonly totalDistance: number
  readonly zonesVisited: readonly string[]
  readonly active: boolean
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

export interface RetentionConfig {
  readonly cleanupIntervalMs: number
  readonly detectionEventsDays: number
  readonly audioLevelsDays: number
  /** @deprecated — snapshots are tied to events, use detectionEventsDays */
  readonly snapshotsDays: number
  readonly deviceOverrides?: Readonly<
    Record<
      string,
      Partial<Pick<RetentionConfig, 'detectionEventsDays' | 'audioLevelsDays' | 'snapshotsDays'>>
    >
  >
}

export const DEFAULT_RETENTION: RetentionConfig = {
  cleanupIntervalMs: 60 * 60 * 1000,
  detectionEventsDays: 30,
  audioLevelsDays: 7,
  snapshotsDays: 14,
}

export interface RetentionReport {
  readonly deletedEvents: number
  readonly deletedAudioRecords: number
  readonly deletedSnapshots: number
}

// ---------------------------------------------------------------------------
// Session Tracker
// ---------------------------------------------------------------------------

export interface SessionTrack {
  readonly trackId: string
  readonly deviceId: string
  readonly className: string
  readonly label?: string
  readonly firstSeen: number
  readonly lastSeen: number
  readonly totalFrames: number
  readonly lastDetection: ServerTrackedDetection
  readonly state: string
  readonly positions: ReadonlyArray<{ readonly x: number; readonly y: number; readonly t: number }>
  readonly embedding?: Float32Array
  readonly globalId?: string
  readonly bestCrop?: Buffer
}

export interface GlobalIdentity {
  readonly globalId: string
  readonly embedding: Float32Array
  readonly label?: string
  readonly firstSeen: number
  readonly lastSeen: number
  readonly deviceIds: ReadonlyArray<string>
}

// ---------------------------------------------------------------------------
// Known Faces
// ---------------------------------------------------------------------------

export interface ClipRecognizer {
  getEmbedding(imageBuffer: Buffer): Promise<Float32Array>
}

export interface KnownFaceEntry {
  readonly id: string
  readonly label: string
  readonly group?: string
  readonly embedding: readonly number[]
  readonly cropBase64: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly source?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

// ---------------------------------------------------------------------------
// Recording Addon (generic interface for recording engine access)
// ---------------------------------------------------------------------------

/**
 * Interface for the recording addon — the server uses this instead of
 * importing RecordingAddon directly from addon-recording.
 */
export interface IRecordingAddon {
  getCoordinator(): IRecordingCoordinator
  getRecordingDb(): IRecordingDb
}

/**
 * Minimal coordinator interface for the server's recording router.
 */
export interface IRecordingCoordinator {
  enableRecording(
    deviceId: string,
    options: {
      policy: unknown
      ffmpegOverrides?: unknown
    },
  ): Promise<void>
  disableRecording(deviceId: string): Promise<void>
  isRecording(deviceId: string): boolean
  readonly playlistGenerator: {
    generate(
      deviceId: string,
      streamId: string,
      startTime: number,
      endTime: number,
      options?: { live?: boolean },
    ): unknown
  }
  readonly storageEstimator: {
    estimateForDevice(
      deviceId: string,
      motionInput?: { avgEventsPerDay: number; avgDurationSec: number },
    ): { totalEstimatedGb: number; [key: string]: unknown }
  }
}

/**
 * Minimal recording database interface for the server's recording router.
 */
export interface IRecordingDb {
  upsertStorageConfig(config: {
    deviceId: string
    dataCategory: string
    storageName: string
    subDirectory: string
    retentionDays: number | null
    retentionGb: number | null
  }): void
  getPolicy(
    deviceId: string,
  ): { readonly enabled: boolean; readonly mode: string; [key: string]: unknown } | null
  getEnabledPolicies(): Array<{ deviceId: string; [key: string]: unknown }>
  querySegments(deviceId: string, streamId: string, startTime: number, endTime: number): unknown
  getAvailability(deviceId: string, startTime: number, endTime: number): unknown
  getStorageUsage(deviceId: string, streamId: string): unknown
  upsertPolicy(policy: unknown): void
  findNearestThumbnail(deviceId: string, timestamp: number, category: string): unknown
  getMotionStats(
    deviceId: string,
    startTime: number,
    endTime: number,
  ): {
    avgEventsPerDay: number
    avgDurationSec: number
    dutyCyclePercent: number
    totalEvents: number
  }
  resolveStorageConfig(deviceId: string, dataCategory: string): unknown
}

// ---------------------------------------------------------------------------
// Sub-service interfaces — used by the server's thin NestJS wrappers
// to receive delegates via CapabilityRegistry.
// ---------------------------------------------------------------------------

export interface IEventPersistence {
  start(): void
  stop(): void
  saveDetectionCrops(eventId: string, crops: readonly ObjectSnapshotResult[]): void
  saveAnnotatedFrame(eventId: string, result: AnnotatedSnapshotResult): void
  saveOriginalFrame(
    eventId: string,
    frame: import('./camera-pipeline.js').VideoFrame,
  ): Promise<void>
  getEventMedia(eventId: string): Promise<readonly TrackMediaFile[]>
  getTrackMedia(trackId: string): Promise<readonly TrackMediaFile[]>
  getDeviceMedia(
    deviceId: string,
    since?: number,
    until?: number,
  ): Promise<readonly TrackMediaFile[]>
  getBufferStatus(): { pendingEvents: number; pendingMedia: number; lastFlush?: number }
  flush(): Promise<void>
}

export interface ITrackTrail {
  setConfig(deviceId: string, config: Partial<TrackCaptureConfig>): void
  getConfig(deviceId: string): TrackCaptureConfig
  recordFrame(ctx: unknown): Promise<void>
  getActiveTrail(trackId: string): TrackTrail | null
  getActiveTrails(deviceId: string): readonly TrackTrail[]
  getPersistedTrail(trackId: string): Promise<TrackTrail | null>
  getTrail(trackId: string): Promise<TrackTrail | null>
  listTrails(
    deviceId: string,
    options?: {
      since?: number
      until?: number
      limit?: number
      className?: string
    },
  ): Promise<readonly TrackTrail[]>
}

export interface IRetention {
  start(): void
  stop(): void
  runCleanup(): Promise<unknown>
  setConfig(update: Partial<RetentionConfig>): void
  getConfig(): unknown
  forceCleanup(): Promise<unknown>
}

export interface ISessionTracker {
  updateFromAnalysis(deviceId: string, ctx: unknown): void
  getActiveTracks(deviceId: string): readonly SessionTrack[]
  getAllActiveTracks(): readonly SessionTrack[]
  getTrack(deviceId: string, trackId: string): SessionTrack | undefined
  getTrackCounts(): Record<string, number>
  clearDevice(deviceId: string): void
  clearAll(): void
  getGlobalPool(): unknown
}

export interface KnownFaceSummary {
  readonly id: string
  readonly label: string
  readonly group?: string
  readonly cropBase64: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly source?: string
  readonly sourceType?: string
  readonly count?: number
}

export interface IKnownFaces {
  register(entry: KnownFaceEntry): Promise<void>
  listAll(): Promise<readonly KnownFaceSummary[]>
  delete(id: string): Promise<void>
  update(id: string, updates: Partial<Pick<KnownFaceEntry, 'label' | 'group'>>): Promise<void>
  recalculateEmbedding(id: string, clipRecognizer: ClipRecognizer): Promise<void>
  findMatch(embedding: Float32Array, threshold: number): Promise<unknown>
  batchRegister(
    entries: ReadonlyArray<{
      readonly label: string
      readonly cropBase64: string
      readonly group?: string
    }>,
    clipRecognizer: ClipRecognizer,
  ): Promise<unknown>
}

/**
 * Composite interface exposed via CapabilityRegistry as the
 * 'analysis-data-persistence' singleton. Each sub-service is wired
 * individually to the corresponding NestJS wrapper service.
 */
export interface IAnalysisDataPersistence {
  readonly eventPersistence: IEventPersistence
  readonly knownFaces: IKnownFaces
  readonly sessionTracker: ISessionTracker
  readonly retention: IRetention
  readonly trackTrail: ITrackTrail
}

// ---------------------------------------------------------------------------
// Provider Connection Testing
// ---------------------------------------------------------------------------

export interface TestConnectionResult {
  readonly success: boolean
  readonly version?: string
  readonly cameraCount?: number
  readonly error?: string
}

/**
 * Generic interface for testing provider connections.
 * Each provider addon can expose a connection tester.
 */
export interface IProviderConnectionTester {
  testConnection(): Promise<TestConnectionResult>
}
