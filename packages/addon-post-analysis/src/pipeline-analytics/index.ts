// Host-resolved (`@camstack/system` is external to every addon bundle): this
// process gets the monitor from the installed server closure, not from its own
// dist. Deploy order is closure first, addon second. The `/addon-utils` subpath
// and never the barrel — the barrel drags the whole kernel (~64MB of heap) into
// a runner. See D417.
import { startEventLoopStallMonitor } from '@camstack/system/addon-utils'
import {
  createDisplayPalettePainter,
  readDisplayPalette,
} from '../shared/display-palette-painter.js'
import type {
  AddonContext,
  AddonDataPlaneHandle,
  AddonInitResult,
  AddRetrainFrameFromRecordingResult,
  AudioEvent,
  AudioEventDraft,
  ClearTrackRelationInput,
  ClearTrackRelationResult,
  ConfigSectionWithValues,
  ConfigUISchemaWithValues,
  DetailStepAnnounce,
  DetectionSource,
  DeviceProxy,
  DurableState,
  EventDensityForDevice,
  EventKindDescriptor,
  EventKindsForDevice,
  FrameHandle,
  FrameResult,
  InferenceOccasion,
  IPipelineAnalyticsProvider,
  IScopedLogger,
  KeyEvent,
  KeyEventsForDevice,
  ListTrackRelationsInput,
  ListTrackRelationsResult,
  LtsBucket,
  MediaFile,
  MediaFileInfo,
  MediaFileKind,
  MediaFileRef,
  MediaOwnerType,
  MediaPresenceOwnerKind,
  MotionAnalysisPayload,
  MotionEvent,
  MotionEventDraft,
  MotionOnMotionChangedPayload,
  NativeCropBbox,
  ObjectDetection,
  ObjectEvent,
  ObjectEventDraft,
  PeerBytesTicket,
  PipelineAnalyticsFaceGalleryChangedPayload,
  PipelineAnalyticsPlateGalleryChangedPayload,
  PipelineAnalyticsTrackLifecyclePayload,
  PipelineAudioInferenceResultPayload,
  ProviderRegistration,
  RecentTracksPage,
  RecordsAccess,
  RetrainAnnotation,
  RetrainAnnotationDraft,
  RetrainArchiveResult,
  RetrainArchiveTarget,
  RetrainAssistProfile,
  RetrainAssistResult,
  RetrainCorpusFilter,
  RetrainCorpusKpi,
  RetrainCorpusPage,
  RetrainDismissed,
  RetrainExportFilter,
  RetrainExportLayout,
  RetrainFrameList,
  RetrainFrameSelection,
  RetrainLlmAssistResult,
  RetrainMacroClass,
  RetrainOrigin,
  RetrainTrack,
  RetrainTrainingCorpusResolveResult,
  RetrainTrainingCorpusSelection,
  RetrainTransitionResult,
  RetrainCollection as RetrainWireCollection,
  RetrainCollectionCreateResult as RetrainWireCollectionCreateResult,
  RetrainCollectionRenameResult as RetrainWireCollectionRenameResult,
  RetrainFrame as RetrainWireFrame,
  RunStatelessStepInput,
  RunStatelessStepResult,
  SceneMonitorStatus,
  ScoredObjectEvent,
  SensorEvent,
  SetTrackPurityInput,
  SetTrackPurityResult,
  SetTrackRelationInput,
  SettingsStoreClient,
  Track,
  TrackedDetection,
  TrackProjection,
  TrackRelation,
  TrackSource,
  TrackZoneFilter,
  Unsubscribe,
} from '@camstack/types'
import {
  addonWidgetsSourceCapability,
  armRemovalReconcile,
  audioMetricsCapability,
  BaseAddon,
  type CapCaller,
  type ClipSearchStrictness,
  DeviceType,
  deviceRemovalHookCapability,
  EVENT_KIND_BY_CAP,
  EventCategory,
  errMsg,
  faceGalleryCapability,
  failureContributionCapability,
  type IDeviceRemovalHookProvider,
  type IStorageOccupancyProvider,
  isEventOwnerType,
  MAX_TRACK_PURITIES,
  MAX_TRACK_RELATIONS,
  memoizePinnedFfmpeg,
  nodePin,
  notificationRulesCapability,
  pipelineAnalyticsCapability,
  plateGalleryCapability,
  readMotionTriggeredBy,
  type StorageOccupancyReport,
  sceneMonitorCapability,
  sensorRaisedOf,
  sleep,
  startMoverUnderClearance,
  storageOccupancyCapability,
  zoneAnalyticsCapability,
} from '@camstack/types'
import { MotionEpisodeTracker } from './motion-episode-tracker.js'

/** The `storage-occupancy` request shape, derived from the cap's provider
 *  interface — never an inline object type on a signature. */
type StorageOccupancyInput = Parameters<IStorageOccupancyProvider['getOccupancy']>[0]

import { NcActionPlane } from '../notification-center/action-plane.js'
import { buildActionUrl } from '../notification-center/action-token.js'
import { NcAlarmPanelDevice } from '../notification-center/alarm/alarm-panel-device.js'
import { NcArtifactIndex } from '../notification-center/artifact-index.js'
import { artifactShelfRefusal } from '../notification-center/artifact-locality.js'
import { NcArtifactPlane } from '../notification-center/artifact-plane.js'
import { NcArtifactReadPlane } from '../notification-center/artifact-read-plane.js'
import { ARTIFACTS_MEDIA_LOCATION, NcArtifactStore } from '../notification-center/artifact-store.js'
import { type ArtifactEndpoint, pickArtifactBaseUrl } from '../notification-center/artifact-url.js'
import { notificationLinkEndpoints } from '../notification-center/link-endpoints.js'
import {
  PRUNE_SETTING_KEYS,
  type PruneWindows,
  resolvePruneWindows,
} from '../notification-center/prune-windows.js'
import { ncAudioSampleFromFrame } from './audio-classify-outcome.js'
import { resolveCondition } from './scene/condition-resolver.js'
import { downscaleSceneCrop, SceneConfirmGate } from './scene/scene-confirm-gate.js'
import { SceneEngine } from './scene/scene-engine.js'
import { SceneMonitorProvider } from './scene/scene-monitor-provider.js'
import { SceneStore } from './scene/scene-store.js'

/** This addon's manifest id — the owner of the fixed Notification Center
 *  integration and of the alarm device under it. */
/**
 * How long the active encoder's model id is trusted without re-asking.
 *
 * `embeddingEncoder.getInfo` measured 1.42s on the live hub — a cross-process
 * call into an addon busy with live inference — for a value that changes only
 * when an operator swaps encoders. A minute is short enough that a swap takes
 * effect without a restart and long enough that no search pays for it twice.
 */
const ENCODER_INFO_TTL_MS = 60_000

/**
 * Rows of the vector index one orphan pass may examine.
 *
 * Bounded so a retention tick cannot turn into a full-index scan; the rest is
 * left for the next tick, resumed from a cursor. Orphans are not urgent, they
 * are dead weight the search has to skip.
 *
 * **This number is now real.** It used to be handed to a KNN as `topK`, where
 * sqlite-vec silently clamped it to 4,096 — so the audit saw 18.5% of a 22,128-
 * row index and reported `examined: 4096` as if it had walked the whole thing.
 * The pass enumerates through `vectorStore.scan` instead, which has no `k`
 * ceiling because it computes no distance. See `embedding-orphan-scan.ts`.
 */
const EMBEDDING_ORPHAN_SCAN_LIMIT = 20_000

/**
 * Tracks fetched per page while rebuilding.
 *
 * The page size is NOT the caller's `maxTracks`: that bounds the whole pass,
 * this bounds one round trip. Conflating them is what made the rebuild
 * re-embed the same newest N tracks on every call.
 */
const REBUILD_PAGE_SIZE = 200
/**
 * The node a rebuild falls back to when the cluster's node list is unreadable.
 *
 * The hub, because it is the one node guaranteed to exist and to be reachable
 * from here. A rebuild that ran on nothing because a list read failed would be
 * indistinguishable from a rebuild with nothing to do.
 */
const REBUILD_FALLBACK_NODE_ID = 'hub'

/** In-memory state of the detached rebuild. */
interface RebuildJobState {
  running: boolean
  /** The pinned CLIP model and the index it fills — kept after the pass ends. */
  modelId?: string
  index?: string
  startedAtMs?: number
  finishedAtMs?: number
  progress?: RebuildProgress
  complete?: boolean
  error?: string
  /** The pass re-embeds only in-space tracks (D664). */
  force?: boolean
}

interface MediaReclaimJobState {
  running: boolean
  mode: 'report' | 'reclaim' | null
  totalExamined: number
  totalEligible: number
  totalReclaimed: number
  totalBytesReclaimed: number
  totalRefused: number
  devicesDone: number
  complete: boolean | null
  startedAtMs: number | null
  finishedAtMs: number | null
  error: string | null
}

const IDLE_MEDIA_RECLAIM: MediaReclaimJobState = {
  running: false,
  mode: null,
  totalExamined: 0,
  totalEligible: 0,
  totalReclaimed: 0,
  totalBytesReclaimed: 0,
  totalRefused: 0,
  devicesDone: 0,
  complete: null,
  startedAtMs: null,
  finishedAtMs: null,
  error: null,
}

interface OrphanAuditJobState {
  running: boolean
  mode: 'report' | 'reclaim' | null
  complete: boolean | null
  totalOrphans: number
  totalReclaimed: number
  totalBytesReclaimed: number
  startedAtMs: number | null
  finishedAtMs: number | null
  error: string | null
}

const IDLE_ORPHAN_AUDIT: OrphanAuditJobState = {
  running: false,
  mode: null,
  complete: null,
  totalOrphans: 0,
  totalReclaimed: 0,
  totalBytesReclaimed: 0,
  startedAtMs: null,
  finishedAtMs: null,
  error: null,
}

/** Wire shape of `getObjectEmbeddingRebuildStatus`. */
interface RebuildStatusOut {
  readonly running: boolean
  readonly scanned: number
  readonly rebuilt: number
  readonly missingKeyFrame: number
  /** Tracks with no object event — its own number since D664, never summed in. */
  readonly missingEvent: number
  readonly missingBbox: number
  /** Which rule placed each judged track's box (D664). */
  readonly boxSource: RebuildBoxSourceCounts
  /** Tracks skipped because their vector was already in the pinned space. */
  readonly alreadyInSpace: number
  /** Whether the current / last pass was a `force` pass; `null` before any. */
  readonly force: boolean | null
  /** In-space tracks a `force` pass selected for re-embedding. */
  readonly forcedInSpace: number
  /** Refused by the executing node (unreadable key frame / bad box), not broken. */
  readonly notRunnable: number
  /** The pass STOPPED — no node could serve the pinned model. */
  readonly noCapableNode: number
  readonly failed: number
  readonly complete: boolean | null
  readonly startedAtMs: number | null
  readonly finishedAtMs: number | null
  readonly error: string | null
  readonly modelId: string | null
  readonly index: string | null
}

/** Artefact index ⇄ shelf reconcile cadence. Hourly: the two only drift on the
 *  bounds' own timescale (14 days / 2000 entries / 2 GiB). */
const NC_ARTIFACT_PRUNE_INTERVAL_MS = 3600_000

/** How often the tape shelf's 24 h age sweep runs even when no segment closes
 *  (every camera switched off): the bound is 24 h, not "24 h after the next
 *  close" (D681). */
const TAPE_SWEEP_INTERVAL_MS = 3600_000

/** How often open tape segments push their pending gzip output to disk
 *  without rotating (D681 follow-up): a silent camera otherwise keeps its
 *  tail only in the zlib buffer until the next frame or the 10-minute cut. */
const TAPE_FLUSH_INTERVAL_MS = 60_000

import { randomBytes, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { type NcTimelapseRenderPorts, NotificationCenter } from '../notification-center/index.js'
import type { NcLinkedStills } from '../notification-center/linked-stills.js'
import {
  makeNcActionHandlers,
  type NcActionHandlers,
  type NcActions,
  ncActions,
} from '../notification-center/nc-actions.js'
import {
  boundRuleMosaics,
  type SummaryMosaicPorts,
} from '../notification-center/summary/summary-mosaic.js'
import type { NcSummaryPorts } from '../notification-center/summary/summary-producer.js'
import { type AlarmPanelConvergence } from './alarm-panel-convergence.js'
import { NC_ARTIFACT_READ_PREFIX_REF, planeAccess } from './data-plane-access.js'
import {
  DEFAULT_STATIONARY_CANDIDATES,
  type DebugAnalyzeInput,
  type DebugListTracksInput,
  type DebugLtsInput,
  type DebugLtsOutput,
  type DebugStationaryInput,
  type DebugStationaryOutput,
  type DebugStoreCensusInput,
  type DebugStoreCensusOutput,
  debugActions,
  MAX_CENSUS_SITES,
} from './debug/debug-actions.js'
import { DEBUG_EXPORT_PREFIX } from './debug/debug-bundle.js'
import { createDebugExportHandler } from './debug/debug-export-handler.js'
import {
  analyzeDebugTracks,
  buildDebugBundlePlan,
  type DebugServiceDeps,
  listDebugTracks,
} from './debug/debug-service.js'
import { gtActions } from './debug/gt-actions.js'
import {
  type DebugTapeDeleteOutput,
  type DebugTapeIdInput,
  type DebugTapeListInput,
  type DebugTapeListItem,
  type DebugTapeListOutput,
  type DebugTapePromoteInput,
  type DebugTapePromoteOutput,
  type DebugTapeReleaseOutput,
  type DebugTapeReviewInput,
  type DebugTapeReviewOutput,
  type DebugTapeStatusInput,
  type DebugTapeStatusOutput,
  type DebugTapeTracksOutput,
  tapeActions,
} from './debug/tape-actions.js'
import {
  createTapeExportHandler,
  TAPE_EXPORT_PREFIX,
  type TapeBundleLoad,
  type TapeBundlePeek,
} from './debug/tape-export-handler.js'
// Re-export the rule-bridge action catalog — the tRPC contract Group B (the
// viewer) consumes against `addonId: 'pipeline-analytics'`.
// The hub's forked-addon harvest imports the ENTRY module and reads the
// `customActions` NAMED export (see addon-registry loadForkedCustomActionCatalog).
import {
  type AuditFaceEmbeddingsInput,
  type AuditFaceEmbeddingsResult,
  type BackfillPhotoSourcesInput,
  type BackfillPhotoSourcesResult,
  type EmbeddingRebuildInput,
  type EmbeddingRebuildStarted,
  embeddingActions,
  type FaceAlignmentStatusWire,
  type ReembedFacesInput,
  type ReembedFacesResult,
  type ReembedFacesStatus,
  type ReembedSamplesInput,
  type ReembedSamplesResult,
  type ReenrolPhotosInput,
  type ReenrolPhotosResult,
  type ResetToCoreInput,
  type ResetToCoreResult,
  requireCompleteWipe,
  type SourceFrameStatsResult,
  WIPE_STORE_UNAVAILABLE,
} from './embedding-actions.js'
import { FaceAlignmentJobs } from './face-alignment-jobs.js'
import {
  AUDIT_MISMATCH_MAX_COSINE,
  AUDIT_OK_MIN_COSINE,
  auditFaceEmbeddings,
  DEFAULT_AUDITED_FACE_MODEL,
} from './face-embedding-audit.js'
import { FaceGalleryProvider, LEGACY_MODEL_ID } from './face-gallery-provider.js'
import { FACE_GALLERY_PRUNE_INTERVAL_MS } from './face-gallery-prune.js'
import {
  buildFaceRescoreReport,
  type FaceRescoreParams,
  persistRescoreResult,
} from './face-rescore.js'
import {
  type FaceReembedRefusal,
  type FaceReembedReport,
  type FaceRescoreActionInput,
  type FaceRescoreActionResult,
  faceRescoreActions,
} from './face-rescore-actions.js'
import type { FaceRescoreJobStatus } from './face-rescore-job-status.js'
import { FACE_RESCORE_TICK_MS } from './face-rescore-scheduler.js'
import { buildFaceRescoreRuntime, type FaceRescoreRuntime } from './face-rescore-wiring.js'
import { reembedFaceSamples } from './face-sample-reembed.js'
import { FaceSourceStats } from './face-source-stats.js'
import { decideBirthFirstFrameCapture } from './pipeline/birth-first-frame-gate.js'
import { ClosedRowMediaGate } from './pipeline/closed-row-media-gate.js'
import { findCoMovingPairs } from './pipeline/co-moving-subjects.js'
import type { FrameObservation } from './pipeline/frame-observation.js'
import {
  type FrameProcessor,
  isIdleTrackerStats,
  type TrackedDetectionOut,
} from './pipeline/frame-processor.js'
import {
  createFrameProcessor,
  type FrameProcessorInputs,
} from './pipeline/frame-processor-config.js'
import {
  PendingPreviewUpgrades,
  type PreviewUpgradeDerived,
  type PreviewUpgradeDeriveInput,
} from './pipeline/preview-upgrade.js'
import { TrackCloser } from './pipeline/track-close.js'
import { trackPlacementOf } from './pipeline/track-placement.js'
import { trackProvenanceOf } from './pipeline/track-provenance.js'
import { type IdleResident, TrackResidentState } from './pipeline/track-resident-state.js'
import {
  type CalibrationTrack,
  calibrateStillnessSpeed,
  collectStillnessSamples,
  DEFAULT_STILLNESS_CALIBRATION_LIMITS,
  describeStillnessCalibration,
} from './pipeline/tracker/stillness-scale.js'
import { TrackerSweep, TTL_SWEEP_INTERVAL_MS } from './pipeline/tracker-sweep.js'
import type { EventLedgerWiringDeps } from './store/event-ledger-wiring.js'
import {
  wireBirthDecisionLedger,
  wireDebugNoteArchiveLedger,
  wireOpsLogLedger,
  wirePlateLedger,
  wireRetrainFrameLedger,
  wireTrackingTapeLedger,
  wireTrackPurityLedger,
  wireTrackRelationsLedger,
} from './store/event-ledger-wiring.js'
import { FaceRescoreStateStore } from './store/face-rescore-state-store.js'

/** How often the resident-vs-live-track heartbeat line is written. */
const RESIDENT_HEARTBEAT_INTERVAL_MS = 5 * 60_000
/** A resident idle this long that nothing carries is an orphan. */
const RESIDENT_ORPHAN_IDLE_MS = 2 * 60_000

import {
  confirmedPredecessorRejections,
  type LinkDecisionFacts,
  type TrackFusion,
} from './pipeline/tracker-v2/index.js'
import { PlateGalleryProvider } from './plate-gallery-provider.js'
import {
  type DiscardStartInput,
  locationDiscardActions,
} from './retention/location-discard-actions.js'
import {
  createDiscardJob,
  type DiscardJob,
  IDLE_DISCARD,
} from './retention/location-discard-job.js'
import {
  type MediaForgetInput,
  type MediaForgetResult,
  mediaForgetActions,
} from './retention/media-forget-actions.js'
import {
  DEFAULT_MEDIA_RECLAIM_LIMITS,
  MEDIA_RECLAIM_SCOPES,
  type MediaReclaimLimits,
  type MediaReclaimScope,
  runMediaReclaim,
} from './retention/media-reclaim.js'
import {
  type MediaReclaimActionInput,
  MediaReclaimActionInputSchema,
  mediaReclaimActions,
} from './retention/media-reclaim-actions.js'
import { forgetMissingMediaRows, type MediaForgetDeps } from './retention/media-row-forget.js'
import {
  type OrphanAuditActionInput,
  type OrphanAuditOverrides,
  type OrphanAuditStartResult,
  type OrphanAuditStatus,
  orphanAuditActions,
} from './retention/orphan-audit-actions.js'
import {
  type StillnessCalibrateInput,
  type StillnessCalibrateResult,
  stillnessCalibrationActions,
} from './stillness-calibration-actions.js'
import {
  resolveStillnessSettings,
  resolveStillSpeedFracPerSec,
  type StillnessSettings,
} from './stillness-settings.js'
import { TrackingTapeIndexStore } from './store/tracking-tape-index-store.js'
import {
  buildTrackLifecyclePayload,
  DEFAULT_UPDATE_GATE_CONFIG,
  evaluateTrackLifecycleUpdate,
  resolveLifecycleUpdateLabel,
} from './track-lifecycle.js'
import { exportGroundTruth } from './tracking-bench/ground-truth.js'
import { hubFacePseudonymizer } from './tracking-bench/recorder/frame-record.js'
import { lightingFromCondition } from './tracking-bench/recorder/lighting.js'
import { openGzipFileSink } from './tracking-bench/recorder/segment-writer.js'
import { TapeOperationQueue } from './tracking-bench/recorder/tape-operation-queue.js'
import {
  buildTapeDeleteDeps,
  buildTapePinDeps,
  deleteOrUnavailable,
  reconcileOrUnavailable,
  releaseOrUnavailable,
  reviewOrNotFound,
  type TapeDepsSources,
} from './tracking-bench/recorder/tape-operations.js'
import { reconcileTapePins, type TapePinDeps } from './tracking-bench/recorder/tape-pin-ledger.js'
import {
  promoteTapeWindow,
  type TapePromotionDeps,
} from './tracking-bench/recorder/tape-promotion.js'
import { TapeRecorder } from './tracking-bench/recorder/tape-recorder.js'
import { tapeSceneOf } from './tracking-bench/recorder/tape-scene.js'
import {
  logTapeSweepReport,
  type TapeSegmentListing,
  TapeShelf,
} from './tracking-bench/recorder/tape-shelf.js'
import {
  defaultTapeStatusCameras,
  describeTapeStatus,
  type TapeNodeRefusal,
  tapeNodeRefusal,
} from './tracking-bench/recorder/tape-status.js'
import { readTapeFile } from './tracking-bench/tape-codec.js'
import { TapePlaneSchema } from './tracking-bench/tape-schema.js'

export { ncActions } from '../notification-center/nc-actions.js'

/**
 * The FULL action catalog for this addon.
 *
 * Must contain every action, not just the notification-center ones: the hub
 * harvests THIS named export, so an action registered only in what
 * `onInitialize` returns is invisible to the bridge and answers 404. That is
 * exactly what the embedding buttons did on their first deploy.
 */
export const customActions = {
  ...ncActions,
  ...embeddingActions,
  ...debugActions,
  ...tapeActions,
  ...gtActions,
  ...orphanAuditActions,
  ...mediaReclaimActions,
  ...locationDiscardActions,
  ...mediaForgetActions,
  ...photoEnrollActions,
  ...faceRescoreActions,
  ...stillnessCalibrationActions,
}

import type {
  ArchivedDebugNote,
  BirthDecisionQueryInput,
  BirthDecisionRecord,
  EventMediaKindBreakdown,
  EventPruneCounts,
  EventStoreFootprint,
  OpsLogEntry,
  OpsLogReason,
  RelocatableMediaCount,
  RelocatableMediaCountInput,
  RelocateJob,
  RelocateMediaInput,
  StorageMigrationMediaMoveInput,
  TrackCascadeCounts,
  TrackFlags,
  TrackFlagsPatch,
  TrainingExportSummary,
  UnstampedEventMediaCount,
  Zone,
  ZoneRule,
} from '@camstack/types'
import type { NcEventMedia, NcEventMediaRequest } from '../notification-center/dispatcher.js'
import { EventMediaService } from '../notification-center/event-media/event-media-service.js'
import {
  cutRecordedClip,
  type NcRecordedClipRequest,
  type NcRecordedClipResult,
} from '../notification-center/recorded-clip.js'
import { drawBoxedFrame } from '../shared/frame/box-drawer.js'
import { extractCropRaw } from '../shared/frame/crop-extractor.js'
import {
  createDebugCropCapture,
  type DebugCropCaptureFn,
  type DebugCropCaptureInput,
} from './pipeline/debug-crop-capture.js'

/**
 * Width cap on the ONE full frame a debug crop is cut from.
 *
 * A debug crop is a picture for a person, and the plan has already widened the
 * window to a neighbourhood — past this width the extra pixels buy nothing and
 * a 4K native surface would cross the transport for every marked track.
 */
const DEBUG_CROP_FETCH_MAX_WIDTH = 1280

/** How long a queued debug-crop frame fetch is still worth executing. Past
 *  this the handle's frame has aged out of the runner's retention and the next
 *  decision will ask again with a young one, so the queued entry is dead
 *  weight in a lane real media is waiting in. */
const DEBUG_CROP_FETCH_STALE_MS = 2_000

import { decodeJpegToRgb } from '../shared/frame/encode-crop.js'
import { cropWideCentralSquareFromRgb } from '../shared/frame/keyframe-wide-thumbnail.js'
import { makeSquareThumb } from '../shared/frame/square-thumb.js'
import { deriveThumbnailSmall } from '../shared/frame/subject-crop-variants.js'
import type { GetEventMediaInput, ListEventMediaInput } from './analytics-query-facade.js'
import { AnalyticsQueryFacade } from './analytics-query-facade.js'
import { emptyAudioConfirmState, observeAudioConfirm } from './audio-confirm-window.js'
import {
  type AudioDetectionSettings,
  resolveAudioDetectionSettings,
} from './audio-detection-settings.js'
import {
  type AudioEpisodeKnobs,
  type AudioEpisodeRef,
  emptyAudioEpisodeState,
  observeAudioEpisode,
} from './audio-episode-hysteresis.js'
import { classifyAudioFrame } from './audio-event-router.js'
import { emptyLevelState, observeLevel } from './audio-level-detector.js'
import { AudioMetricsProvider } from './audio-metrics-provider.js'
import {
  type ConfirmationGateSettings,
  resolveConfirmationGateSettings,
} from './confirmation-gate-settings.js'
import { TrackDetailDispatcher, type TrackDetailFrame } from './detail-dispatcher.js'
import {
  type DetectionSensitivitySettings,
  resolveDetectionSensitivitySettings,
} from './detection-sensitivity-settings.js'
import {
  DEVICE_ALERT_DEFAULTS,
  type DeviceAlertSettings,
  DeviceAlertSettingsSchema,
} from './device-alert-settings.js'
import { createAnalyticsRemovalHook } from './device-removal-hook.js'
import { DeviceSettingsCacheHub } from './device-settings-cache.js'
import { DeviceZoneResolver } from './device-zone-resolver.js'
import { DEFAULT_EMBEDDING_CONFIG } from './embedding/embedding-config.js'
import type { EmbeddingEncoderClient } from './embedding/embedding-dispatcher.js'
import { EmbeddingDispatcher } from './embedding/embedding-dispatcher.js'
import {
  DEFAULT_REBUILD_PACING_MS,
  type RebuildBoxSourceCounts,
  type RebuildDeps,
  type RebuildProgress,
  rebuildObjectEmbeddings,
  rebuildTrackPageQuery,
} from './embedding-rebuild.js'
import {
  createEventMediaHandler,
  type EventMedia,
  type EventMediaVariant,
  type MediaAddress,
} from './event-media-handler.js'
import {
  collectCropForcedMedia,
  collectDefaultEventMedia,
  type RankableMediaRow,
  type ResolvedMediaBytes,
  readWinningBlob,
  resolveCropForcedMedia,
} from './event-thumbnail-resolver.js'
import { type FaceIdentityVerdict, FaceRecognizer } from './face-recognizer.js'
import {
  deriveSuggestionMinCosine,
  FACE_DEFAULTS,
  type FaceSettings,
  FaceSettingsSchema,
  resolveFaceSettings,
  SUGGESTION_BAND_FACTOR,
} from './face-settings.js'
import { FrameState } from './frame/frame-state.js'
import { FrameLagObserver } from './frame-lag-observer.js'
import { hydrateWithInheritedGlobals } from './inherited-device-values.js'
import {
  type LocationAwareMediaBlobStorage,
  type MediaBlobStorage,
} from './location-aware-media-storage.js'
import { MediaWriteGate } from './media-write-gate.js'
import { injectSecondarySubjects } from './pipeline/secondary-subjects.js'
import {
  type RetrainAnnotation as RetrainAnnotationRow,
  RetrainAnnotationStore,
} from './retrain/retrain-annotation-store.js'
import { serveRetrainArchive } from './retrain/retrain-archive-offer.js'
import { openRetrainUploadSink } from './retrain/retrain-archive-upload.js'
import {
  type RetrainCropCutter,
  type RetrainExportPlan,
  writeRetrainArchiveTo,
} from './retrain/retrain-archive-writer.js'
import type { AssistSubject } from './retrain/retrain-assist.js'
import { RetrainCollectionService } from './retrain/retrain-collection-service.js'
import { RetrainCollectionStore } from './retrain/retrain-collection-store.js'
import { cutRetrainCrop, resizeRetrainJpeg } from './retrain/retrain-crop-cut.js'
import { datasetAnnotationHash, datasetStats } from './retrain/retrain-dataset.js'
import {
  buildRetrainManifest,
  exportNeedsFullCorpus,
  filterRetrainExport,
  RETRAIN_CROP_CONVENTION,
  RETRAIN_CROP_MAX_SIDE,
  RETRAIN_EXPORT_PREFIX,
} from './retrain/retrain-export.js'
import {
  createRetrainExportHandler,
  type RetrainExportRequest,
  retrainExportQuery,
} from './retrain/retrain-export-handler.js'
import { createRetrainFrameHandler, RETRAIN_FRAME_PREFIX } from './retrain/retrain-frame-handler.js'
import {
  RETRAIN_MEDIA_LOCATION,
  type RetrainFrame as RetrainFrameRow,
  RetrainFrameStore,
} from './retrain/retrain-frame-store.js'
import { RetrainLlmAssistService } from './retrain/retrain-llm-service.js'
import { RetrainService } from './retrain/retrain-service.js'
import {
  exportFilterForTrainingCorpus,
  keepTrainingCorpusFrame,
} from './retrain/retrain-training-corpus.js'
import type { AliasResolveFailure } from './track-alias-resolution.js'
import {
  resolveMediaOwnerId,
  resolveTrackOwnerIds,
  resolvingTrackIds,
  trackIdTakingMethods,
} from './track-alias-resolution.js'
import { ZoneCatalogueCache } from './zone-catalogue-cache.js'

/**
 * Assist threshold when the caller does not pin one. Packages have their own
 * (0.35, on the zone crop only — `retrain/retrain-assist.ts`); everything else
 * starts here and the operator drops the ones they do not want.
 */
const DEFAULT_ASSIST_MIN_SCORE = 0.3

/**
 * Ceiling on the annotations one export pass carries, per device. Staging is
 * bounded at 500 tracks per camera (D81) and a track contributes a handful of
 * frames, so this is far above any real selection — it exists so a runaway
 * cannot page the whole table into memory to build a manifest.
 */
const RETRAIN_EXPORT_MAX = 20_000

import { AnalyticsLtsSeriesSchema } from '@camstack/types'
import { BUILTIN_CLIP_MODELS } from '../shared/clip/clip-model-registry.js'
import { encodeClipQuery, pinClipRebuild, resolveClipSearchPlan } from './clip-space-plan.js'
import {
  CLIP_EMBEDDING_STEP_ID,
  FACE_EMBEDDING_STEP_ID,
  readClusterModelPinStrict,
  resolveClusterModelPin,
} from './cluster-model-pin.js'
import { EventMediaWriteLocator } from './event-media-write-location.js'
import {
  type FaceReembedResult,
  faceReembedProgress,
  reembedFaceGallery,
} from './face-reembed-pass.js'
import { type ClusterPinCaller, ClusterPinConfirmer } from './face-reembed-trigger.js'
import { FaceReembedEmbedder, shouldAutoReembed } from './face-reembed-wiring.js'
import { MediaCaptureLogAggregator } from './media-capture-log.js'
import { MediaRelocateEngine } from './media-relocate-engine.js'
import { type MediaSettings, resolveMediaSettings } from './media-settings.js'
import { ourRecordingAvailability } from './our-recording-availability.js'
import { buildOverlayDetections } from './overlay-frame-builder.js'
import { OverlayDetailStateStore } from './overlay-state.js'
import {
  PACKAGE_DROP_DEFAULTS,
  type PackageDropSettings,
  resolvePackageDropSettings,
} from './package-settings.js'
import {
  type PhotoAnalyzeInput,
  type PhotoAnalyzeResult,
  type PhotoDiscardInput,
  type PhotoDiscardResult,
  type PhotoEnrollActionInput,
  type PhotoEnrollActionResult,
  photoEnrollActions,
} from './photo-enroll-actions.js'
import {
  analyzePhotoFaces,
  enrollPhotoFace,
  PHOTO_ENROLL_DEVICE_ID,
  PHOTO_FACE_DETECTION_STEP_ID,
  PHOTO_FACE_EMBEDDING_STEP_ID,
  PhotoAnalysisSessions,
  type PhotoFace,
  type PhotoPipelineResult,
  toWireFace,
} from './photo-enrollment.js'
import { normalizePhotoOrientation } from './photo-orientation.js'
import {
  type AnalyticsCascadeStores,
  absentCascadeLegs,
  buildAnalyticsCascadeRegistry,
  buildAnalyticsFusionRegistry,
  runTrackCascadeBatch,
  type TrackScopedStore,
} from './pipeline/delete-track-cascade.js'
import type { DisplayCropFn } from './pipeline/display-crop.js'
import { dropoutEvidenceCount, shouldSkipDropoutFrame } from './pipeline/dropout-skip.js'
import { buildEventChildCrops } from './pipeline/event-child-crops.js'
import { type PeakLookup, rankKeyEvents } from './pipeline/key-event-query.js'
import { selectKeyFrameCaptures } from './pipeline/key-frame-capture.js'
import { KeyFrameCaptureLog } from './pipeline/key-frame-metrics.js'
import { createKeyFrameCrop } from './pipeline/keyframe-crop.js'
import { displayLabel, patchDisplayLabel, refusalLogMeta } from './pipeline/label-tier.js'
import {
  isClipObjectEmbedding,
  resolveSearchThumbnailUrl,
} from './pipeline/object-embedding-selection.js'
import { PackageBackgroundRegistry } from './pipeline/package/package-background.js'
import { pickupInstantOf } from './pipeline/package/package-collector-mirror.js'
import { nextPackageLookDropEpisodes } from './pipeline/package/package-look-drop-log.js'
import { packageLookEvidence } from './pipeline/package/package-look-evidence.js'
import {
  type PackageLookDropReason,
  type PackageLookRawKept,
  packageLookSightings,
} from './pipeline/package/package-look-sightings.js'
import { packageReferenceArea } from './pipeline/package/package-reference-area.js'
import type { PackageReferenceZone } from './pipeline/package/package-reference-area.js'
import { PackageSceneCoordinator } from './pipeline/package/package-scene-coordinator.js'
import type { PackageSceneDelivery } from './pipeline/package/package-scene-coordinator.js'
import type { PackageSceneNativeQuery } from './pipeline/package/package-scene-fetch.js'
import { planPackageSceneFrame } from './pipeline/package/package-scene-plan.js'
import { confirmPackageWithLlm } from './pipeline/package/package-llm-confirm.js'
import type {
  PackageLlmConfirmOutcome,
  PackageLlmGenerateRequest,
} from './pipeline/package/package-llm-confirm.js'
import {
  type PackageStillnessBridgeInput,
  sweepPackageStillness,
} from './pipeline/package/package-stillness-sweep.js'
import {
  collectPackageZoneIds,
  isDelivererInPackageZone,
  type PackageOptionRule,
} from './pipeline/package/package-zone-activity.js'
import { PackageDropDetector } from './pipeline/package-drop-detector.js'
import { personOverVehicle } from './pipeline/person-over-vehicle.js'
import { PhantomCellRegistry } from './pipeline/stationary/phantom-cells.js'
import {
  executePromotionEffects,
  type PromotionEffects,
  type PromotionPlan,
  type PromotionSource,
  planForPersistedSource,
  planPromotion,
  planPromotionEffects,
} from './pipeline/stationary/promotion-plan.js'
import { boxAreaFraction } from './pipeline/stationary/stationary-birth-guard.js'
import {
  type StationaryEvidenceRow,
  type StationaryObservation,
  stillnessVerdictFor,
  trackOffersEvidence,
} from './pipeline/stationary/stationary-evidence.js'
import { StationaryEvidenceLedger } from './pipeline/stationary/stationary-evidence-ledger.js'
import {
  bboxMatchesParkedEntry,
  DEFAULT_SESSION_STILLNESS_CONFIG,
  OVERSIZE_AREA_FRAC,
  trackIsStill,
} from './pipeline/stationary/stationary-match.js'
import { StationaryObjectRegistry } from './pipeline/stationary/stationary-registry.js'
import {
  disposeStationaryTracks,
  entryHeldMediaOf,
  planStationaryTrackDisposal,
  type SparingMediaLeaf,
  sparingEntryHeldMedia,
} from './pipeline/stationary/stationary-track-disposal.js'
import type {
  StationaryEntry,
  StationaryMatchConfig,
} from './pipeline/stationary/stationary-types.js'
import { computeStationaryEntryZones } from './pipeline/stationary/stationary-zones.js'
import { planeRunsStationary } from './pipeline/stationary-planes.js'
import { applyTrackFlags } from './pipeline/track-flags.js'
import type {
  TrackFusibleStore,
  TrackFusionMediaPort,
  TrackLeafStore,
} from './pipeline/track-fusion-leaf.js'
import { TrackFusionService } from './pipeline/track-fusion-service.js'
import {
  clearTrackRelation,
  firstTrackFacts,
  listTrackRelations,
  setTrackPurity,
  setTrackRelation,
  type TrackFacts,
  type TrackRelationsDeps,
} from './pipeline/track-relations.js'
import { PlateRecognizer } from './plate-recognizer.js'
import { readSliceOnce } from './read-slice.js'
import { REBUILD_DETAIL_STEP_ID } from './rebuild-detail-request.js'
import { NodeRotation } from './rebuild-node-rotation.js'
import { loadRebuildSource } from './rebuild-source-loader.js'
import { RebuildStepDispatcher } from './rebuild-step-dispatch.js'
import { RecordedStillService } from './recorded-still.js'
import { buildRecordedStillPorts, RECOVERED_KEY_FRAME_MAX_WIDTH } from './recorded-still-ports.js'
import { scanEmbeddingOrphans } from './retention/embedding-orphan-scan.js'
import { FACE_VECTOR_ORPHAN_SCOPE, faceVectorOrphanDeps } from './retention/face-vector-orphans.js'
import {
  DEFAULT_GALLERY_RECLAIM_CEILING,
  DEFAULT_GALLERY_RECONCILE_GRACE_MS,
  reconcileGallerySamples,
} from './retention/gallery-reconcile.js'
import {
  buildOrphanScopes,
  DEFAULT_ORPHAN_LIMITS,
  MEDIA_AUDIT_SHARD_KINDS,
  type OrphanAuditDeps,
  type OrphanAuditLimits,
  type OrphanAuditReport,
  type OrphanCursor,
  runOrphanAudit,
} from './retention/orphan-audit.js'
import {
  auditCollectionPorts,
  orphanAuditLedgers,
  plateDeleter,
} from './retention/orphan-audit-ledgers.js'
import {
  ORPHAN_AUDIT_DEFAULTS,
  ORPHAN_AUDIT_INTERVAL_SETTING,
  ORPHAN_AUDIT_MODE_SETTING,
  ORPHAN_AUDIT_PAGE_SIZE_SETTING,
  OrphanAuditIntervalHoursSchema,
  OrphanAuditModeSchema,
  OrphanAuditPageSizeSchema,
  type OrphanAuditSettings,
} from './retention/orphan-audit-settings.js'
import { buildOrphanReclaimer, settingsRowDeleterOf } from './retention/orphan-reclaimers.js'
import { RetentionSweepRunner } from './retention/retention-sweep-runner.js'
import { RetiredSettingsPurge } from './retention/retired-settings-purge.js'
import { TrackPruneRunner } from './retention/track-prune-runner.js'
import { BindingCache } from './runtime/binding-cache.js'
import {
  CaptureScheduler,
  captureCoalesceKey,
  deriveFrameDispatchKind,
} from './runtime/capture-scheduler.js'
import { DetectionCoverageCache } from './runtime/detection-coverage-cache.js'
import {
  AnalyticsFailureReport,
  REASON_PERSON_OVER_VEHICLE,
  REASON_QUEUE_OVERFLOW,
  REASON_STALE_DROP,
} from './runtime/failure-report.js'
import type { NativeFrameTransport } from './runtime/native-frame-transport.js'
import { createNativeFrameTransport } from './runtime/native-frame-transport.js'
import { NodeLivenessMirror } from './runtime/node-liveness.js'
import { createParkedFrameClient, type ParkedFrameClient } from './runtime/parked-frame-client.js'
import { createAnalyticsWidgetsProvider } from './runtime/widget-manifest.js'
import type { BindingsChangedData, SensorStateChangedData } from './runtime/wire-subscriptions.js'
import { wireSubscriptions } from './runtime/wire-subscriptions.js'
import { type AudioMarkerConfig, AudioMarkerProjector } from './services/audio-marker-projector.js'
import { CameraIndexUnknownDrops } from './services/camera-index-unknown-drops.js'
import type {
  SensorIngestDropReason,
  SensorNotificationCameras,
  UnownedSensorEvent,
} from './services/event-kinds.js'
import {
  composeEventKinds,
  composeEventKindsForDevices,
  ingestSensorStateChange,
  LinkedCamerasCache,
  NO_SENSOR_NOTIFICATION_CAMERAS,
  resolveSensorNotificationCameras,
  sensorSliceRecord,
} from './services/event-kinds.js'
import {
  type EmittableFromConfig,
  emittableFromPipelineConfig,
  NO_EMITTABLE,
} from './services/event-kinds-config.js'
import { prefetchDeviceTopology } from './services/event-kinds-prefetch.js'
import type {
  EventMediaTarget,
  RasterFallbackCandidate,
  TrackFrameTarget,
} from './services/event-media-dispatcher.js'
import { EventMediaDispatcher } from './services/event-media-dispatcher.js'
import { MotionEventSnapshotCapturer } from './services/motion-event-snapshot.js'
import { projectSensorMarkers } from './services/sensor-marker-projector.js'
import { SensorTransitionGate } from './services/sensor-transition-gate.js'
import { SyntheticTrackMaterializer } from './services/synthetic-track.js'
import {
  buildGlobalSettingsSchema,
  EMBEDDING_ENABLED_DEFAULT,
  formatSuggestionThresholdReadout,
  POST_PROCESSING_NODE_DEFAULT,
  retagDetectionSections,
  retagRetentionSection,
  SUGGESTION_THRESHOLD_READOUT_KEY,
  stripDeviceOnlyFields,
  stripGlobalOnlyFields,
  toAnalyticsDeviceSections,
} from './settings-schema.js'
import {
  resolveStationarySettings,
  STATIONARY_DEFAULTS,
  type StationarySettings,
} from './stationary-settings.js'
import { AnalyticsHistoryProducer } from './store/analytics-history-producer.js'
import { AUDIO_TRACK_CLASS } from './store/audio-track-class.js'
import { BirthDecisionLedgerStore } from './store/birth-decision-ledger-store.js'
import { DebugNoteArchiveStore } from './store/debug-note-archive-store.js'
import {
  convertJsonEmbeddings,
  type EmbeddingConversionDeps,
} from './store/embedding-json-conversion.js'
import { type EventDensityBucket, EventStore } from './store/event-store.js'
import { type FaceRecord, FaceStore } from './store/face-store.js'
import { IdentityStore } from './store/identity-store.js'

type AnalyticsLtsSeries = z.infer<typeof AnalyticsLtsSeriesSchema>

import { BirthCandidates } from './birth/birth-candidates.js'
import { BirthGate } from './birth/birth-gate.js'
import { BirthLedger } from './birth/birth-ledger.js'
import { BirthVerdict } from './birth/birth-verdict.js'
import type {
  AnalyticsApi,
  AnalyticsCapProviders,
  AnalyticsStores,
  MotionEpisodeRowData,
} from './boot/boot-types.js'
import {
  KEYFRAME_CROP_MAX_SAMPLE_GAP_MS,
  KEYFRAME_CROP_MAX_SKEW_MS,
  KEYFRAME_CROP_MIN_SUBJECT_IOU,
} from './boot/boot-types.js'
import { BuildAlarmPanel } from './boot/build-alarm-panel.js'
import { BuildAnalyticsProviders } from './boot/build-analytics-providers.js'
import { BuildDetailDispatcher } from './boot/build-detail-dispatcher.js'
import { BuildNotificationCenter } from './boot/build-notification-center.js'
import { BuildRecognizers } from './boot/build-recognizers.js'
import { BuildStores } from './boot/build-stores-events.js'
import { BuildNotificationPorts } from './boot/build-timelapse-ports.js'
import { DeclareCollections } from './boot/declare-collections.js'
import { ResolveMediaStorage } from './boot/resolve-media-storage.js'
import { DetailRoute } from './frame/detail-route.js'
import { EnrichmentFanout } from './frame/enrichment-fanout.js'
import { FrameAdmission } from './frame/frame-admission.js'
import { ENRICHMENT_CAPTURE_STALE_MS } from './media/capture-timing.js'
import { FrameMediaCapture } from './media/frame-media-capture.js'
import { SemanticBestShot } from './media/semantic-best-shot.js'
import { SnapshotTargetPlanner } from './media/snapshot-targets.js'
import {
  GALLERY_MEDIA_LOCATION,
  GALLERY_TENANT_SUBPATH,
  isMediaOwnerKind,
  MEDIA_COLLECTION,
  MediaStore,
} from './store/media-store.js'
import { ObjectEmbeddingStore } from './store/object-embedding-store.js'
import { OpsLogStore } from './store/ops-log-store.js'
import { PlateStore } from './store/plate-store.js'
import { censusApi, logCensus, StoreReadCensus } from './store/read-census.js'
import { SensorEventStore } from './store/sensor-event-store.js'
import { RawDeviceBlobMirror, RawGlobalStoreMirror } from './store/settings-raw-mirror.js'
import { isShortMotionlessTrack, netDisplacementPx } from './store/short-motionless.js'
import { SweepCursorStore } from './store/sweep-cursor-store.js'
import { TrackAliasStore } from './store/track-alias-store.js'
import { TrackRelationsStore } from './store/track-relations-store.js'
import { TrackStore } from './store/track-store.js'
import { tapeLanes, tapeTrackFacts } from './tracking-bench/tape-lanes.js'
import { resolveTrackingSettings, type TrackingSettings } from './tracking-settings.js'
import {
  buildTrainingExportPlan,
  TRAINING_EXPORT_MAX_TRACKS,
  type TrainingExportPlan,
} from './training-export/dataset-plan.js'
import {
  createTrainingExportHandler,
  TRAINING_EXPORT_PREFIX,
} from './training-export/training-export-handler.js'
import { ZoneAnalyticsProvider } from './zone-analytics-provider.js'

/**
 * Pipeline Analytics addon — subscribes to `PipelineInferenceResult` +
 * `PipelineAudioInferenceResult` on the bus, refines raw detections
 * into tracks + per-kind events + persisted media, and emits canonical
 * events (`onFrameTracked` / `onTrackStarted` / `onTrackEnded` /
 * `onDetectionEvent`) for downstream consumers.
 *
 * Pure subscriber architecture: no `processFrame` cap method. Per-
 * device gating via the `pipeline-analytics` wrapper binding in
 * `device-manager.setWrapperActive` — BindingsTab is the single
 * surface to turn the refinement pipeline on/off for a camera.
 */

/**
 * How long shutdown waits for the sensor handlers already running. Just above
 * the marker's bounded snapshot fetch (`SENSOR_MARKER_SNAPSHOT_TIMEOUT_MS`,
 * 2.5 s), the one long await a handler makes, and BELOW the kernel's SIGKILL
 * fallback (process-service.ts: 3 s after SIGTERM on the stop-all path, 5 s on
 * the others) — a longer drain would be killed mid-way and log nothing.
 */
const SENSOR_HANDLER_DRAIN_MS = 2_700

/** What {@link PipelineAnalyticsAddon.handOffLinkedSensorEvent} needs of one state change. */
interface LinkedSensorHandOff {
  readonly data: SensorStateChangedData
  readonly timestamp: number
  /** Every camera linking the sensor, primary first — unfiltered. */
  readonly mediaCameraIds: readonly number[]
  /** The timeline rows the ingest wrote (the opted-in cameras). */
  readonly persisted: readonly SensorEvent[]
  readonly markerByCamera: ReadonlyMap<number, SensorMarkerRef>
  readonly linkedStills?: NcLinkedStills
}

/** The marker one camera's projection landed for a state change. */
interface SensorMarkerRef {
  readonly trackId: string
  readonly hasMedia: boolean
}
/**
 * How often the addon asks "is a gallery sample outside the cluster face
 * space?". A flip is rare and the check is two cheap reads — a minute keeps
 * the recognition gap after a model change short without polling noise.
 */
const FACE_REEMBED_AUTO_CHECK_MS = 60_000
/**
 * Samples one AUTOMATIC re-embed pass may rewrite (D651). A pass holds the
 * re-embed flag and the photo/reset jobs off for its whole run; bounding it
 * keeps that window short on a gallery of hundreds, and the next tick (one
 * minute later) resumes where it stopped. The operator's `embedding.reembedFaces`
 * takes its own `maxSamples`.
 */
const FACE_AUTO_REEMBED_MAX_SAMPLES = 200

// How long per-device audio-detection settings are cached before re-reading
// the device store. Balances freshness (operator tuning) with read overhead
// at ~30 Hz frame rate.
const SETTINGS_CACHE_TTL_MS = 5_000

/** The confirmation crop cap — `birth/birth-redetect.ts`. Re-exported so a test
 *  recognises a confirmation round trip by the real constant. */
export { CONFIRMATION_CROP_MAX_WIDTH } from './birth/birth-redetect.js'

/** What `processFrame` hands the tape recorder for one observed frame (D681). */
interface TapeFrameWiring {
  readonly deviceId: number
  readonly source: DetectionSource
  /** The runner's frame — injected secondary subjects are the tail of `trackerFrame`. */
  readonly frame: FrameResult
  readonly trackerFrame: FrameResult
  readonly observation: FrameObservation
  readonly liveZones: readonly Zone[]
  readonly liveRules: readonly ZoneRule[]
  readonly zoneMembershipMinOverlap: number
  readonly lowScoreFloor: number | null
}

/** S6: pure per-kind settings resolve applied to one raw device-store read. */
type SettingsResolver<T> = (raw: Record<string, unknown>) => T
/** Reconcile cadence for the per-device `zones` / `zoneRules` slice handles.
 *  The `device.state-changed` push reaches a forked child through
 *  `createEventBusSliceSource` (the DeviceProxy no longer waits on
 *  `live.onEvent`). Events are still lossy telemetry (D8); this timer
 *  is the RPC reconcile, not the mechanism. Five minutes matches the
 *  viewer's `RECONCILE_MS`. */
const ZONE_SLICE_RECONCILE_MS = 300_000
/** How often the evaluating node re-reads the central scene set. */
const SCENE_RELOAD_INTERVAL_MS = 30_000
/** How long the install coordinates are trusted between settings reads. */
const SITE_COORDS_TTL_MS = 300_000

/** getKeyEvents: max completed tracks pulled from a window before importance
 *  ranking. Ordering is by importance (not firstSeen) and legacy rows score on
 *  read, so we over-fetch candidates and trim to `limit` after sorting. */
const KEY_EVENT_CANDIDATE_CAP = 500
/** getKeyEvents: default page size when the caller omits `limit`. */
const KEY_EVENT_DEFAULT_LIMIT = 50

/** Durable-handle schema for `postProcessingNodeId`: a non-empty string.
 *  Absent / empty / non-string all fall back to the hub default — the exact
 *  narrowing the old raw read applied inline. */
const PostProcessingNodeIdSchema = z.string().min(1)
/** Per-install HMAC secret behind the signed artifact links (minted once). */
const NcArtifactSecretSchema = z.string()
const EmbeddingEnabledSchema = z.boolean()
// Level below which audio frames are treated as silence and never trigger
// a level-path event. Expressed in dBFS (0 = digital full-scale).
//
// ⚠ This number crosses the D459 audio-scale epoch. Until 2026-09-11 a native
// G.711 camera reported levels 12.04 dB (PCMU) / 18.06 dB (PCMA) low, so this
// floor silently admitted 12-18 dB LESS of the world on those cameras than on
// an AAC/Opus one. With the decoder corrected, the two populations are finally
// on one scale — and this floor now means the same thing everywhere.
//
// **It stays at -55, and D460 is the argument for why** (the earlier note here
// said "one constant serves two populations", which was true for one day and
// is now the wrong reason — after the epoch there is only ONE population).
//
// The right question is not which population is bigger. It is what kind of
// number this is. `-55 dBFS is near silence` is a STATEMENT ABOUT THE SCALE:
// it was true before the epoch and it is true after, on any correct decoder.
// It was never calibrated by watching the 19 mis-decoded cameras — and the
// proof is that it has meant exactly this, unchanged, on the 5 AAC and 1 L16
// cameras for its whole life, with no complaint about either.
//
// So the defect was never in this number. The defect was that 19 cameras did
// not OBEY it. Shifting it to -43 would take a correct value and make it
// wrong, in order to preserve the behaviour of a bug — and it would make the
// six cameras that were always right newly deaf. What actually happens at the
// epoch is that the 19 converge on the behaviour the 6 always had.
//
// The numbers that DO convert are the ones somebody measured through the old
// decoder. There is exactly one of those with recorded provenance, and it is
// `NC_AUDIO_DB_OFFERED`. See D460.
//
// @dbfs-era itu
const SILENCE_FLOOR_DBFS = -55
const RETENTION_SWEEP_INTERVAL_MS = 5 * 60_000

/** How often closed history buckets are flushed. See `analytics-history-producer.ts`. */
const LTS_FLUSH_INTERVAL_MS = 60_000

/**
 * How long the events ops-log is kept when the cluster has said nothing. 30
 * days: long enough to answer "what deleted my footage last month", short
 * enough that the audit never becomes the largest thing the node stores.
 *
 * A FALLBACK since D485. The authority is `opsLogRetentionDays` on the LOGGING
 * settings document (`system.getLoggingSettings`), not this addon's own form —
 * the operator's call, so that every log-ish window is configured in one place.
 * This constant is what a node uses when it cannot reach that document, which
 * is the one case where guessing beats deleting.
 */
const OPS_LOG_RETENTION_FALLBACK_MS = 30 * 24 * 60 * 60_000
/** Throttle for the "overlay synthesis failed" warn — one line / minute / device. */
const OVERLAY_SYNTHESIS_WARN_THROTTLE_MS = 60_000
/** How recently a spatial track must have been alive to count as "visual
 *  happening" — stamp audio labels on that track instead of opening a
 *  synthetic audio episode. */
const AUDIO_EPISODE_VISUAL_QUIET_MS = 2_000
/** Persist lastSeen on an open synthetic audio track at most this often. */
const AUDIO_EPISODE_PERSIST_MS = 2_000
/**
 * Coalescing window for classified audio inserts when episodes are OFF.
 *
 * With `audioEpisodeEnabled: false` there is no hysteresis to collapse a sound
 * into one row, but the classifier still fires at ~30 Hz — so the pre-episode
 * rule applies again: while the SAME class persists, one row per heartbeat;
 * a class change inserts immediately. The knob turns off the grouping, never
 * the persistence (D62).
 */
const AUDIO_EVENT_HEARTBEAT_MS = 5_000
// Motion no longer uses a heartbeat (D475): one row per EPISODE
// (`MotionEpisodeTracker`), opened on the first rising edge and UPDATEd once
// at close with `durationMs` + `edges` — see `motion-episode.ts` and
// `motion-episode-tracker.ts`. `MOTION_CLOSE_AFTER_MS` (`@camstack/types`,
// `motion.cap.ts`) is the close delay; there is no separate heartbeat
// constant to keep in sync with it any more.

/**
 * Stored media kinds that carry NO drawn bounding box, in fallback preference
 * order. The reel forces `?kind=crop`; when a track has no crop the endpoint may
 * degrade only to one of these CLEAN frames — never `fullFrameBoxed` /
 * `lastFrame` / `firstFrame` / `snapshot` (all server-boxed).
 *
 * `thumbnail` joined the clean set on 2026-07-17: the track best-thumbnail is
 * now a subject-centered crop (event-media-dispatcher), and for DEGENERATE
 * tracks (no object event → no `crop`) it is the ONLY subject-centered media.
 *
 * Full-scene kinds (`fullFrame`, `keyFrame`, `keyFrameSmall`) stay out of
 * this list so a crop is preferred when one exists. `resolveCropForcedMedia`
 * then falls through to those full-scene kinds — a keyFrame beats an icon.
 * An *explicit* `?kind=keyFrame` / `?kind=snapshot` still matches exactly, so
 * videoclips and other kind-specific fetches keep working.
 *
 * The retired-but-still-stored kind (`crop`) stays listed so old rows resolve.
 */
const CLEAN_MEDIA_KINDS: readonly MediaFileKind[] = ['crop', 'thumbnail', 'thumbnailSmall']

/**
 * Pick media for a crop-forced request: the exact `preferKind` when present
 * (so `?kind=snapshot` still serves a snapshot), else the first available
 * subject crop in {@link CLEAN_MEDIA_KINDS}. Returns undefined when no crop
 * is in the list — the caller then falls through to any remaining image
 * (`resolveCropForcedMedia`); the class icon is only for a total miss.
 */
export function pickCleanMedia<T extends RankableMediaRow>(
  files: readonly T[],
  preferKind: string,
): T | undefined {
  const exact = files.find((f) => f.kind === preferKind)
  if (exact) return exact
  for (const kind of CLEAN_MEDIA_KINDS) {
    const found = files.find((f) => f.kind === kind)
    if (found) return found
  }
  return undefined
}

// S5 (refactor spec 2026-07-22): the global settings-form schema literal and
// the pure per-device section transforms moved VERBATIM to
// `settings-schema.ts`. Re-exported here so existing importers (tests) keep
// the `../index.js` import path unchanged.
export {
  DETECTION_PIPELINE_SECTION_IDS,
  retagDetectionSections,
  retagRetentionSection,
  stripDeviceOnlyFields,
  stripGlobalOnlyFields,
  toAnalyticsDeviceSections,
} from './settings-schema.js'

/** Grid the spawn point is quantised to, so respawns whose boxes never repeat
 *  to the pixel still land in one cell. */
const PHANTOM_CELL_PX = 32
/** How long a cell remembers its closes. */
const PHANTOM_CELL_WINDOW_MS = 6 * 60 * 60_000

/** `pipelineAnalytics.selectRetrainFrames` input (D482: a media row is
 *  addressed by its own id, never the owning track/owner id). */
interface SelectRetrainFramesInput {
  readonly deviceId: number
  readonly trackId: string
  readonly mediaIds: number[]
}

/** Cadence of the per-camera tracker v2 summary line (D683). */
const TRACKER_SUMMARY_INTERVAL_MS = 60_000
/** Who asked for a summary: a frame, or the silence sweep (review LOW-N1). */
type TrackerSummaryPath = 'frame' | 'sweep'
/** Tracker v2 facts that fire per frame in a crowd (splits) or per re-send
 *  (`ignored` link facts) log their first N, then one in N, with the running
 *  count on every line — the refusal stream's cadence. */
const TRACKER_FACT_LOG_ALWAYS_FIRST = 10
const TRACKER_FACT_LOG_SAMPLE_EVERY = 10
/** Facts that fire once per PIECE — every tentative a flickering false
 *  positive spawns (review M1: ~1 750 `new` decisions per camera per hour) —
 *  are sampled harder; the per-minute summary carries their exact counts. */
const TRACKER_PIECE_LOG_SAMPLE_EVERY = 50

/** Out-of-order frames (follow-up 102, F1: ~1 % of frames) log the first N,
 *  then one in this many — every line carries the count; the per-minute
 *  summary carries the exact `outOfOrderFrames`. */
const TRACKER_OUT_OF_ORDER_LOG_SAMPLE_EVERY = 50
/** Clock-step WARNs past the first ten (fix round 3, MEDIUM-1). */
const TRACKER_CLOCK_STEP_LOG_SAMPLE_EVERY = 50

/** First N, then one in `every` — the refusal stream's cadence (D391). */
function sampledTrackerFact(count: number, every: number = TRACKER_FACT_LOG_SAMPLE_EVERY): boolean {
  return count <= TRACKER_FACT_LOG_ALWAYS_FIRST || count % every === 0
}

/** What `trackRelationsDeps` needs from either a live or a persisted track —
 *  both satisfy this structurally (D681). */
interface TrackFactsLike {
  readonly trackId: string
  readonly deviceId: number
  readonly firstSeen: number
  readonly lastSeen: number
}

/** `deleteTracks`' answer; `sparedMediaIds` names rows a live stationary
 *  entry kept out of the cascade (D683 Task 14, R6). */
interface DeleteTracksResult {
  readonly deleted: number
  readonly failed: readonly string[]
  readonly sparedMediaIds: readonly number[]
}

/** How long `onShutdown` waits for queued fusion re-points (D683 Task 18) —
 *  well inside the runner's 3 s SIGTERM budget. */
const FUSION_SHUTDOWN_SETTLE_MS = 1_000

/** The track-leaf stores as the cascade and the fusion both compose them (D683). */
interface TrackLeafStoreSet {
  readonly stores: AnalyticsCascadeStores
  /** The media leg, sparing what a live stationary entry vouches for. */
  readonly mediaLeg: SparingMediaLeaf
}

export default class PipelineAnalyticsAddon
  extends BaseAddon
  implements IPipelineAnalyticsProvider
{
  /** The per-frame / per-camera state the frame path shares — `frame/frame-state.ts`. */
  private readonly frameState = new FrameState()
  private trackStore: TrackStore | null = null
  /** D683: the alias collection behind an L2 fusion — an absorbed id resolves
   *  to its survivor forever, and widens every track cascade to reach rows a
   *  late writer left under it (review H4). Null until onInitialize. */
  private trackAliasStore: TrackAliasStore | null = null
  /** D683 review H2 (Task 20 fix round 1): a sampled WARN for an alias-store
   *  lookup that THREW rather than answering — every `resolvingTrackIds`/
   *  `resolveMediaOwnerId` call site shares this ONE bounded memo (keyed
   *  `method:id`), so a persistent outage logs once per failing read rather
   *  than once per call. Built alongside `trackAliasStore`; null until then. */
  private aliasResolveFailureLogger: ((failure: AliasResolveFailure) => void) | null = null
  /** Parked-object registry: promotes a track that stopped moving into a
   *  lightweight entry, suppresses its detections from re-spawning tracks, and
   *  wakes it when the object departs. Null until onInitialize. */
  private stationaryRegistry: StationaryObjectRegistry | null = null
  /** Phantom-cell memory — the half of {@link noteShortMotionlessTrack} that
   *  SURVIVES the track. Repeated short-motionless closes in one cell raise the
   *  confirmation gate's bar there; one moving track clears it. Null until
   *  onInitialize. */
  private phantomCells: PhantomCellRegistry | null = null
  /** Repeated-sighting evidence — the ONLY thing that creates a stationary
   *  entry. Two producers may feed it; only the motion session does today. */
  private stationaryEvidence: StationaryEvidenceLedger | null = null
  private mediaStore: MediaStore | null = null
  /** The enrolled gallery's rows. Retained so the photo-enrollment bridge can
   *  reach them without going back through the cap surface. Null until S7. */
  private identityStore: IdentityStore | null = null
  private faceGalleryProvider: FaceGalleryProvider | null = null
  /** One face re-embed pass at a time; the gallery is small but the fleet is shared. */
  private faceReembedRunning = false
  /**
   * Passes that rewrite an index pin only the orchestrator's OWN answer
   * (`getClusterModelChoice`), read twice in a row and agreeing (D651, D49).
   * One confirmer per caller, so each logs its own state changes. Lazy: they
   * need `ctx.api`.
   */
  private readonly clusterPinConfirmers = new Map<ClusterPinCaller, ClusterPinConfirmer>()
  /** Sample ids the LAST pass probed and found pixel-less — the only honest `unrecoverable`. */
  private faceReembedPixelless: ReadonlySet<string> = new Set()
  private faceReembedAutoTimer: ReturnType<typeof setInterval> | null = null
  /**
   * D643: the photo re-enrol pass, the old-alignment prune and their status.
   * Null until the gallery stores exist (hub only).
   */
  private faceAlignmentJobs: FaceAlignmentJobs | null = null
  private faceGalleryPruneTimer: ReturnType<typeof setInterval> | null = null
  /** D866: the whole-archive rescore job + its change-gated hourly scheduler. */
  private faceRescoreRuntime: FaceRescoreRuntime | null = null
  private faceRescoreState: FaceRescoreStateStore | null = null
  private faceRescoreTimer: ReturnType<typeof setInterval> | null = null
  /**
   * Analysed photographs waiting to be named, held between `photo.analyze` and
   * `photo.enroll`. Bounded and expiring — the value held is a whole
   * photograph, so an unbounded map would let uploads decide how much of
   * hub-main's heap they use.
   */
  private readonly photoSessions = new PhotoAnalysisSessions()
  private eventStore: EventStore | null = null
  /** Events-domain ops-log (footprint/prune/manual-delete audit). Null until onInitialize. */
  private eventsOpsLog: OpsLogStore | null = null
  /**
   * The archived operator debug notes (D405). Null until onInitialize — and
   * `applyTrackFlags` treats null as "no archive wired": the flag write the
   * operator asked for never depends on this addon's own bookkeeping.
   */
  private debugNoteArchive: DebugNoteArchiveStore | null = null
  /** The durable birth-decision ledger (D409) — measurement, never a gate. */
  private birthDecisionLedger: BirthDecisionLedgerStore | null = null
  /** Ground-truth marks for the tracking bench (D681) — hub only, like the
   *  debug-note archive above. */
  private trackRelations: TrackRelationsStore | null = null
  /** Event-media relocation engine (entity-routing Phase 4). */
  private mediaRelocate: MediaRelocateEngine | null = null
  private mediaLocationStorage: LocationAwareMediaBlobStorage | null = null
  /**
   * Where NEW `eventMedia` writes land. Its pick is cached per location-set
   * generation and dropped by the `StorageLocationsChanged` doorbell (D387) and
   * by `refreshStorageLocationsForMigration`, so a mode change or a repoint takes
   * effect without a restart.
   */
  private eventMediaWriteLocator: EventMediaWriteLocator | null = null
  private eventMediaLocationDoorbellUnsub: (() => void) | null = null
  private readonly mediaWriteGate = new MediaWriteGate()
  private storageMigrationLeaseId: string | null = null
  /** Per-camera history of LINKED-device sensor state changes (Part B). */
  private sensorEventStore: SensorEventStore | null = null
  /** Ingest-side reverse index (sensor device → linked camera ids), TTL-cached
   *  so the DeviceStateChanged handler stays cheap. */
  private linkedCamerasCache: LinkedCamerasCache | null = null
  /**
   * Whether a mapped sensor cap's slice carried a real TRANSITION.
   *
   * `DeviceStateChanged` is emitted on a slice diff, and a contact slice
   * carries `lastChangedAt` beside `entryOpen` — so an availability flap or a
   * provider-side device rebuild re-emits with the boolean unmoved. Every one
   * of those became a `SensorEvent` row and a synthetic track until this gate
   * existed. Built in the field initializer: `startedAtMs` is the moment this
   * process began watching, which is the floor for a first sighting that is
   * already active. See `services/sensor-transition-gate.ts`.
   */
  private readonly sensorTransitions = new SensorTransitionGate({
    startedAtMs: Date.now(),
    now: () => Date.now(),
  })
  /** `camera-index-unknown` drops, summarised per window — see the file. */
  private readonly cameraIndexUnknownDrops = new CameraIndexUnknownDrops({ nowMs: Date.now() })
  /** The ONE projector of non-spatial events into synthetic snapshot-carrying
   *  tracks — linked sensor/control state changes AND audio markers. */
  private syntheticTracks: SyntheticTrackMaterializer | null = null
  /** Still for a motion row that has no track (events-mode recording without
   *  a detection). Lands as event-owned `kind: 'snapshot'` so videoclip
   *  thumbnails resolve through the existing event-media plane. */
  private motionEventSnapshots: MotionEventSnapshotCapturer | null = null
  /** Decides which audio frames deserve a synthetic marker (D62). */
  private audioMarkers: AudioMarkerProjector | null = null
  private faceStore: FaceStore | null = null
  private faceRecognizer: FaceRecognizer | null = null
  private plateStore: PlateStore | null = null
  private plateRecognizer: PlateRecognizer | null = null
  private objectEmbeddingStore: ObjectEmbeddingStore | null = null
  /** Live state of the detached embedding rebuild — see `rebuildObjectEmbeddings`. */
  private rebuildState: RebuildJobState = { running: false }
  /** CLIP indexes whose size the status poll could not read — the warn fires
   *  on the transition, not on every poll. */
  private readonly unreadableClipIndexes = new Set<string>()
  /** Cached active-encoder model id — see `resolveEncoderModelId`. */
  private encoderInfoCache: { modelId: string; at: number } | null = null
  /** Two-plane detail scheduler/dispatcher: per-track on-demand face/clip/
   *  classifier/plate enrichment via `pipelineRunner.runDetailSubtree`. Replaces
   *  the per-frame child consumption the executor no longer emits. */
  private detailDispatcher: TrackDetailDispatcher | null = null
  /** Per-track detail geometry for the live-overlay synthesis (two-plane). */
  private readonly overlayState = new OverlayDetailStateStore()
  /** Frame-based event/track media (crop + boxed full-frame) from the
   *  detection-pipeline DECODED frame — the ONLY image source (never the
   *  snapshot cap). Null when shm frame access is unavailable. */
  private eventMediaDispatcher: EventMediaDispatcher | null = null
  /** Object/face embedding dispatcher — migrated from the retired
   *  enrichment-engine addon. Runs ONLY on the post-processing node; on each
   *  detection it resolves the frame, crops the ROI, and calls the
   *  embedding-encoder cap (which persists the vector for the search/face
   *  path). Null on non-post-processing nodes or when disabled. */
  private embeddingDispatcher: EmbeddingDispatcher | null = null
  private bindingCache: BindingCache | null = null
  /** Alarm-coverage mirror the NC device directory reads — WHICH devices carry
   *  a wrapped `detection-pipeline` binding. Fleet-seeded ONCE, then per-device
   *  updates off `DeviceBindingsChanged`, so the 30 s rule-reload tick stops
   *  sweeping `getAllBindings` over the whole fleet. See
   *  `runtime/detection-coverage-cache.ts`. */
  private detectionCoverage: DetectionCoverageCache | null = null
  private zoneAnalytics: ZoneAnalyticsProvider | null = null
  private audioMetrics: AudioMetricsProvider | null = null
  /**
   * Per-device {@link DeviceProxy} used to read live zones +
   * detection rules off the kernel runtime-state mirror. Replaces
   * the manual DeviceStateChanged subscription + per-cap-name caches
   * — `proxy.state.zones.value` and `proxy.state.zoneRules.value`
   * stay warm as long as the slice handles are subscribed.
   */
  private readonly proxies = new Map<number, DeviceProxy>()
  /** Slice subscription pins for cache warmth + pushed updates into
   *  the per-device FrameProcessor. */
  private readonly proxyUnsubs = new Map<number, ReadonlyArray<() => void>>()

  /** All bus subscriptions installed by `wireSubscriptions` (S7) — the
   *  processing set (post-processing node only) + the lifecycle set (every
   *  node). `onShutdown` iterates and clears. */
  private subscriptionUnsubs: readonly Unsubscribe[] = []
  private ttlSweepTimer: ReturnType<typeof setInterval> | null = null
  private retentionSweepTimer: ReturnType<typeof setInterval> | null = null

  /** Handle for the event-media data-plane listener (dispose on shutdown). */
  private eventMediaDataPlane: AddonDataPlaneHandle | null = null
  /** Handle for the training-export data-plane listener (dispose on shutdown). */
  private trainingExportDataPlane: AddonDataPlaneHandle | null = null
  /** Handle for the retrain-export data-plane listener (dispose on shutdown). */
  private retrainExportDataPlane: AddonDataPlaneHandle | null = null
  /** Handle for the retrain-frame data-plane listener (dispose on shutdown). */
  private retrainFrameDataPlane: AddonDataPlaneHandle | null = null
  /** Handle for the debug-export data-plane listener (dispose on shutdown). */
  private debugExportDataPlane: AddonDataPlaneHandle | null = null
  /** Handle for the tape-export data-plane listener (dispose on shutdown). */
  private tapeExportDataPlane: AddonDataPlaneHandle | null = null
  /** The retrain curation surface — see `retrain/retrain-service.ts`. Null
   *  until the stores are built. */
  private retrain: RetrainService | null = null
  private retrainCollections: RetrainCollectionService | null = null
  private retrainLlmAssist: RetrainLlmAssistService | null = null
  private retrainCollectionStore: RetrainCollectionStore | null = null
  private retrainFrames: RetrainFrameStore | null = null
  private retrainAnnotations: RetrainAnnotationStore | null = null
  /** The NC artifact plane (signed public links for notification media) and its
   *  data-plane handle. Null until served / when the facility is absent. */
  private ncArtifactPlane: NcArtifactPlane | null = null
  private ncArtifactDataPlane: AddonDataPlaneHandle | null = null
  /** This node's PINNED ffmpeg (D540), asked once and shared by every site in
   *  this addon that spawns one — the timelapse preview and the recovered
   *  still. It rejects rather than naming PATH; each caller logs its refusal. */
  private readonly pinnedFfmpeg = memoizePinnedFfmpeg(() => this.ctx.deps.ensureFfmpeg())
  /** The viewer's artefact library (task #36): the index, its authenticated
   *  bytes route, and the store the two share. Null until served. */
  private ncArtifactIndex: NcArtifactIndex | null = null
  private ncArtifactStore: NcArtifactStore | null = null
  /** Tracking tapes (D681) — hub only; null on a node that does not own the
   *  `artifacts` location or does not post-process. */
  private tapeShelf: TapeShelf | null = null
  private tapeRecorder: TapeRecorder | null = null
  /** Why this node records no tapes, reported per switched-on camera. */
  private tapeRefusal: TapeNodeRefusal | null = null
  private ncArtifactReadDataPlane: AddonDataPlaneHandle | null = null
  private ncArtifactPruneTimer: NodeJS.Timeout | null = null
  private tapeSweepTimer: NodeJS.Timeout | null = null
  private tapeFlushTimer: NodeJS.Timeout | null = null
  /** Why `startTrackingTapes` threw on a node that was allowed to record —
   *  reported `failing` per switched-on camera, never as `recording`. */
  private tapeStartFailure: string | null = null
  /** The index of PROMOTED tape windows (D681) — a hub collection, so it is
   *  constructed on every node; only a recording node promotes into it. */
  private tapeIndex: TrackingTapeIndexStore | null = null
  /** Promote / release / delete / reconcile, one at a time, each under a
   *  deadline (tape-operation-queue.ts). Built on first use. */
  private tapeOpsQueue: TapeOperationQueue | null = null
  /**
   * Roadmap 4b: ONE cut of an event, in every container the rule asked for.
   *
   * Built on first use — a hub whose rules never attach footage never
   * constructs it, and constructing it costs nothing until `cut`.
   */
  private ncEventMedia: EventMediaService | null = null

  /**
   * The dispatcher's single media dep.
   *
   * ONE call for the gif and the mp4, deliberately: rendering them separately
   * is what produced a gif around the event and a video seven seconds after it
   * (D85's `eventToDialMs=7054`). The service picks the camera's best H.264
   * slot, asks the broker's own prebuffer ring for the window at that slot's
   * own width in real time — which is what makes the broker COPY rather than
   * re-encode — and derives the gif from those same bytes.
   */
  /**
   * Cut an OLD moment from the recordings, because the pre-buffer cannot
   * reach it — the ONE recorded-cut wiring, shared by the dispatcher's
   * footage (D682/D686) and a departure's still (D691 review M2).
   */
  private cutNotificationRecordedClip(req: NcRecordedClipRequest): Promise<NcRecordedClipResult> {
    const api = this.ctx.api
    return cutRecordedClip(
      {
        logger: this.ctx.logger.child('RecordedClip'),
        now: () => Date.now(),
        sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
        getAvailability: (input) => ourRecordingAvailability(api, input),
        // The cap input carries an index signature the port's own shape
        // does not; spreading satisfies it without a cast.
        createExport: (input) => api.recordingExport.createExport.mutate({ ...input }),
        getExport: (input) => api.recordingExport.getExport.query(input),
        readExportBytes: (input) => api.recordingExport.readExportBytes.query(input),
        deleteExport: (input) => api.recordingExport.deleteExport.mutate(input),
        cancelExport: (input) => api.recordingExport.cancelExport.mutate(input),
      },
      req,
    )
  }

  private async renderEventMedia(req: NcEventMediaRequest): Promise<NcEventMedia> {
    const api = this.ctx.api
    this.ncEventMedia ??= new EventMediaService({
      logger: this.ctx.logger.child('nc-event-media'),
      produce: (input) =>
        api.streamBroker.produceEventMedia.mutate({
          deviceId: input.deviceId,
          aroundMs: input.aroundMs,
          preSeconds: input.preSeconds,
          postSeconds: input.postSeconds,
          kinds: [...input.kinds],
          gifMaxWidth: input.gifMaxWidth,
          gifFps: input.gifFps,
          gifSpeed: input.gifSpeed,
          speed: input.speed,
          ...(input.profile === 'high' || input.profile === 'mid' || input.profile === 'low'
            ? { profile: input.profile }
            : {}),
        }),
      // PINNED to the node that produced the artifact. `stream-broker` is a
      // singleton cap and an unpinned call never leaves the hub, so a handle
      // minted on an agent's broker would be redeemed against the hub's store
      // and come back null — the same contract `FrameHandle.nodeId` carries.
      fetch: (handle, nodeId) =>
        api.streamBroker.fetchEventMedia.mutate(
          { handle },
          nodeId.length > 0 ? nodePin(nodeId) : undefined,
        ),
      renderRingClip: async (input) => {
        const res = await api.streamBroker.renderPreBufferClip.mutate({
          deviceId: input.deviceId,
          aroundMs: input.aroundMs,
          format: input.format,
          preRollSec: input.preRollSec,
          postRollSec: input.postRollSec,
          maxWidth: input.maxWidth,
          fps: input.fps,
          speed: input.speed,
          ...(input.profile === 'high' || input.profile === 'mid' || input.profile === 'low'
            ? { profile: input.profile }
            : {}),
        })
        const buf = Buffer.from(res.base64, 'base64')
        if (buf.byteLength === 0) return null
        const bytes = new Uint8Array(buf.byteLength)
        bytes.set(buf)
        return bytes
      },
    })
    try {
      const media = await this.ncEventMedia.cut({
        deviceId: req.deviceId,
        aroundMs: req.aroundMs,
        wantMp4: req.wantMp4,
        wantGif: req.wantGif,
        preRollSec: req.preRollSec,
        postRollSec: req.postRollSec,
        ...(req.profile !== undefined ? { profile: req.profile } : {}),
        ...(req.speed !== undefined ? { speed: req.speed } : {}),
      })
      return { mp4: media.mp4, gif: media.gif }
    } catch (err) {
      // A THROW here is a bug in the cut, not a camera that cannot be served —
      // it must never cost the notification, and it must never be silent.
      this.ctx.logger.warn('nc media: the cut threw — this notification ships without footage', {
        tags: { deviceId: req.deviceId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return { mp4: null, gif: null }
    }
  }

  /**
   * The ranked base-URL candidates a notification LINK may use — every link
   * except the tap: the hub's public endpoint (D734, `link-endpoints.ts`).
   *
   * Shared by the artifact plane (media), the action plane (buttons) and the
   * admin page a system event taps into — one resolver, because a second copy
   * would drift and the planes would start minting links on different hosts
   * for the same notification.
   */
  private async ncEndpoints(): Promise<readonly ArtifactEndpoint[]> {
    return notificationLinkEndpoints(this.ctx.api, this.ctx.logger)
  }

  /**
   * Serve the NC ACTION plane: the public route a notification button lands on.
   *
   * A sibling of the artifact plane and a strictly more dangerous one — that
   * route serves bytes, this one MOVES something. Its authority is the token in
   * the link and nothing else, which is the operator's explicit choice; the
   * bounds are in `notification-center/action-token.ts` and D47.
   *
   * Best-effort like every plane here: no facility ⇒ no route, and the
   * dispatcher simply mints no buttons, because `mintActionUrl` returns null.
   */
  private async serveNcActionPlane(center: NotificationCenter): Promise<void> {
    try {
      // A SEPARATE secret from the artifact plane's. They protect different
      // things — a leaked media secret should not also hand out actuations —
      // and separating them costs one row.
      const secretState = this.state<string>('ncActionSecret', NcArtifactSecretSchema, '')
      let secret = await secretState.get()
      if (secret === '') {
        secret = randomUUID().replace(/-/g, '')
        await secretState.set(secret)
      }
      const routePrefix = `/addon/${this.ctx.id}/nc-action`
      const plane = new NcActionPlane({
        registry: center.actionTokenRegistry,
        secret,
        logger: this.ctx.logger.child('nc-actions'),
        run: (grant) => center.runGrantedAction(grant),
      })
      const served =
        (await this.ctx.dataPlane?.serve({
          prefix: 'nc-action',
          access: planeAccess('nc-action'),
          handler: plane.handler,
        })) ?? null
      this.ncActionMintUrl =
        served === null
          ? null
          : async ({ id, expMs }) => {
              const baseUrl = pickArtifactBaseUrl(await this.ncEndpoints())
              if (baseUrl === null) return null
              return buildActionUrl({
                baseUrl,
                routePrefix,
                id,
                secret,
                expMs,
              })
            }
      this.ctx.logger.info('nc-action data-plane served', {
        meta: { served: served !== null },
      })
    } catch (err: unknown) {
      this.ctx.logger.warn('nc-action data-plane failed to serve', {
        meta: { error: errMsg(err) },
      })
    }
  }

  /** Mints a button's callback URL once the action plane is served; null until
   *  then, and null forever on an install with no reachable public address. */
  private ncActionMintUrl:
    | ((input: { id: string; expMs: number }) => Promise<string | null>)
    | null = null

  /**
   * Serve the NC artifact plane: a PUBLIC route whose authority is the HMAC on
   * each link (see `notification-center/artifact-url.ts`). It exists because
   * attachments used to carry BYTES only, and the degrade engine drops a
   * bytes-only attachment for a url-mode backend — WhatsApp and gotify were
   * receiving no media at all.
   *
   * Best-effort at every step: no facility, no secret or no reachable base URL
   * ⇒ no plane, and the dispatcher keeps shipping bytes exactly as before.
   */
  /**
   * Reconcile the artefact index against the shelf that holds the bytes.
   *
   * Hourly, because the two drift only on the bounds' timescale: a row expires
   * on the shelf's own age bound (14 d) or its file is evicted by the count/byte
   * bound. Without this, a list eventually serves rows whose bytes 404 — and a
   * broken tile is the one failure an operator DOES report.
   */
  private startNcArtifactPrune(): void {
    if (this.ncArtifactPruneTimer !== null) return
    const run = async (): Promise<void> => {
      const index = this.ncArtifactIndex
      const store = this.ncArtifactStore
      if (index === null || store === null) return
      try {
        await store.sweep()
        // The INDEX is central, the SHELF is local. Only the node that produces
        // artefacts (the same gate the timelapse/summary producers sit behind)
        // holds bytes for the whole index, so only it may reconcile against its
        // shelf — any other node's `keptIds` would read the entire library as
        // orphaned and delete it. Everyone still sweeps EXPIRED rows, which are
        // time-based and node-independent.
        await index.prune(this.isPostProcessingNode ? await store.keptIds() : null)
      } catch (err: unknown) {
        this.ctx.logger.warn('nc artifact prune failed', {
          meta: { error: errMsg(err) },
        })
      }
    }
    void run()
    this.ncArtifactPruneTimer = setInterval(() => void run(), NC_ARTIFACT_PRUNE_INTERVAL_MS)
    this.ncArtifactPruneTimer.unref?.()
  }

  private async serveNcArtifactPlane(): Promise<void> {
    try {
      const secretState = this.state<string>('ncArtifactSecret', NcArtifactSecretSchema, '')
      // Minted once per install and persisted: a secret that changed on every
      // boot would invalidate every link already delivered to a phone.
      let secret = await secretState.get()
      if (secret === '') {
        secret = randomUUID().replace(/-/g, '')
        await secretState.set(secret)
      }
      // The bytes live in the store's OWN singleton storage class
      // (the shared `artifacts` class, per camera `<deviceId>/nc-artifacts/…`,
      // beside the recorder's `exports/` tenant), never
      // under `ctx.dataDir`: the operator's rule of 2026-09-04 is that addon
      // data dirs carry NO media — 718 MB of artifacts were half of every
      // system backup and invisible to every storage-location surface (D341).
      // The root comes from the storage cap, never a hardcoded path — it
      // differs per node and per deployment shape. A root nobody can resolve
      // refuses the plane (the catch below): notifications then ship
      // bytes-only, which is the designed degrade — falling back to the addon
      // dir is the one thing this must never do again.
      // The shelf's window is the operator's, read once here: the store holds
      // it for its own sweeps and the index derives `expiresAt` from the SAME
      // number (below), so the two can never disagree. A change takes effect on
      // addon restart, the same convention as `postProcessingNodeId` — the
      // alternative is an index whose rows outlive bytes swept under a newer
      // window, which is a library of broken tiles.
      const shelfWindows = await this.pruneWindows()
      // The INDEX first, and on EVERY node. It is the hub's `artifacts` records
      // kind (every node's `ctx.records` reaches it) and touches no local filesystem, so any node can answer
      // `nc.listArtifacts` from it — and one of them will, because the bridge
      // picks a provider. Gating the index on the SHELF's locality is a
      // mistake I shipped for forty minutes on 2026-09-13: the agents stopped
      // building an index they were perfectly able to serve, and the viewer's
      // Media tab answered "this node does not host the notification artifact
      // index — use the hub" to the operator.
      //
      // `artifactShelfMs` is `number | null` and the shelf applies its default
      // only to `undefined`, so this is the same number the shelf would report
      // — one source, no second opinion about how long a row lives.
      const index = new NcArtifactIndex({
        records: this.requireRecords(),
        logger: this.ctx.logger.child('nc-artifacts'),
        addonId: this.ctx.id,
        retentionMs: shelfWindows.artifactShelfMs,
      })
      this.ncArtifactIndex = index

      // The SHELF is a directory, and it belongs to ONE node. The `artifacts`
      // location names it; every node used to resolve that path and `mkdir -p`
      // it regardless — ENOENT on the Mac, EACCES on agent-a, in a loop.
      // See `artifact-locality.ts`.
      const refusal = artifactShelfRefusal(
        await this.ctx.api.storage.listLocations.query({}),
        this.ctx.kernel.localNodeId ?? null,
      )
      if (refusal !== null) {
        // INFO, not WARN: this is the correct outcome on this node, not a
        // failure. A warning here trained the operator to ignore the line.
        this.ctx.logger.info('nc-artifact shelf not served on this node', {
          meta: { reason: refusal, indexServed: true },
        })
        return
      }
      const store = new NcArtifactStore({
        rootDir: await this.resolveNcArtifactRoot(),
        logger: this.ctx.logger.child('nc-artifacts'),
        // Passed straight through, `null` included: null is the operator's
        // "keep forever" and omitting it would silently mean 14 days instead.
        keptMaxAgeMs: shelfWindows.artifactShelfMs,
      })
      await store.start()
      this.ncArtifactStore = store
      const plane = new NcArtifactPlane({
        store,
        secret,
        index,
        logger: this.ctx.logger.child('nc-artifacts'),
        routePrefix: `/addon/${this.ctx.id}/nc-artifact`,
        listEndpoints: () => this.ncEndpoints(),
      })
      this.ncArtifactDataPlane =
        (await this.ctx.dataPlane?.serve({
          prefix: 'nc-artifact',
          access: planeAccess('nc-artifact'),
          handler: plane.handler,
        })) ?? null
      this.ncArtifactPlane = this.ncArtifactDataPlane !== null ? plane : null
      // The VIEWER's read of the same bytes: session-gated by the hub, no
      // signed link, `Range` so a timelapse can be scrubbed rather than
      // re-downloaded on every seek.
      const readPlane = new NcArtifactReadPlane({
        index,
        store,
        logger: this.ctx.logger.child('nc-artifacts'),
      })
      this.ncArtifactReadDataPlane =
        (await this.ctx.dataPlane?.serve({
          prefix: NC_ARTIFACT_READ_PREFIX_REF,
          access: planeAccess(NC_ARTIFACT_READ_PREFIX_REF),
          handler: readPlane.handler,
        })) ?? null
      this.startNcArtifactPrune()
      this.ctx.logger.info('nc-artifact data-plane served', {
        meta: {
          served: this.ncArtifactPlane !== null,
          libraryServed: this.ncArtifactReadDataPlane !== null,
          libraryAccess: planeAccess(NC_ARTIFACT_READ_PREFIX_REF),
          // `null` is the operator's "keep forever" — reported as such, not as
          // a 0 that reads like a shelf about to be emptied.
          retentionDays:
            store.retentionMs === null ? 'forever' : Math.round(store.retentionMs / 86_400_000),
        },
      })
    } catch (err: unknown) {
      this.ctx.logger.warn('nc-artifact data-plane failed to serve', {
        meta: { error: errMsg(err) },
      })
    }
  }

  /** Public base URL for event thumbnails: `/addon/<addonId>/event-media`.
   *  Set once the data-plane is registered; null until then (e.g. no
   *  dataPlane facility in the current environment). */
  private eventMediaBaseUrl: string | null = null

  /**
   * The SAME path, derived rather than observed — a pure function of the addon
   * id, so it exists before `serve()` is attempted and survives its failure.
   *
   * `eventMediaBaseUrl` above answers "is the plane up?", which is the right
   * question for the OPTIONAL `mediaUrl` stamp on a slim event projection.
   * It is the wrong question for a media row's `url`, which is that row's only
   * address: a row that dropped its address on a boot race would be
   * indistinguishable from a row with no bytes, and this repo has already paid
   * for one read that quietly returned less than it was asked for.
   */
  private eventMediaPathPrefix(): string {
    return `/addon/${this.ctx.id}/event-media`
  }

  // Per-(deviceId, source) motion-episode state (D475) — replaces the old
  // shared `lastMotionInsertByDevice` map, whose docblock claimed the
  // analyzer and onboard paths were "mutually exclusive at the event-emit
  // layer". They are not: `motionSources` is an array, and a camera with
  // both `onboard` and `analyzer` produced ONE shared throttle state that let
  // the analyzer silently overwrite the sensor's episode. Constructed once
  // `eventStore` exists (see `onInitialize`).
  private motionEpisodes: MotionEpisodeTracker<MotionEpisodeRowData> | null = null
  // Per-device settings caches (S6, refactor spec 2026-07-22): ONE generic
  // TTL-cache hub replaces the nine hand-rolled `<kind>CacheByDevice` maps.
  // Every kind keeps its legacy TTL (SETTINGS_CACHE_TTL_MS) and its legacy
  // invalidation triggers — wrapper-deactivated / DeviceUnregistered call
  // `clearDevice`, dispose calls `clearAll`, `applyDeviceSettingsPatch` keeps
  // its narrower 4-kind delete.
  private readonly settingsCaches = new DeviceSettingsCacheHub()
  /**
   * The addon-level store and per-device blob, mirrored ONCE and shared by
   * every settings kind above — see `store/settings-raw-mirror.ts`. Before
   * this, each kind's cache miss called `resolveGlobalStore()` +
   * `readDeviceBlob()` directly, so eight kinds expiring in the same window
   * paid for the same two reads eight times: `get
   * pipeline-analytics:addon-settings` at 547–694/min, `get
   * pipeline-analytics:addon-devices` at ~700/min, live 2026-08-26. Invalidated
   * by every in-process writer: `applyDeviceSettingsPatch` and the retired-
   * setting purges drop the device mirror, `onConfigChanged` (this process's
   * own `updateGlobalSettings`) drops the global mirror.
   */
  private readonly rawDeviceBlobMirror = new RawDeviceBlobMirror({
    read: (deviceId) => this.readDeviceBlob(deviceId),
    onRefreshFailed: (deviceId, err) => {
      this.ctx.logger.debug('raw device-blob mirror refresh failed — serving last value', {
        tags: { deviceId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    },
  })
  /**
   * The three cluster alert settings, mirrored for a SYNCHRONOUS read.
   *
   * The Notification Center consults them per battery slice and per liveness
   * flip, and D49 forbids a one-shot event gating on a fallible read. Refreshed
   * off the event path — at boot and on this process's own config write — and a
   * failed refresh keeps the previous values rather than reverting to the
   * defaults (see {@link refreshDeviceAlertSettings}).
   */
  private deviceAlertSettingsMirror: DeviceAlertSettings = DEVICE_ALERT_DEFAULTS
  private readonly rawGlobalStoreMirror = new RawGlobalStoreMirror({
    read: () => this.resolveGlobalStore(),
    onRefreshFailed: (err) => {
      this.ctx.logger.debug('raw global-store mirror refresh failed — serving last value', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    },
  })
  /** Avoids a store read every ~30 Hz audio frame. */
  private readonly audioSettingsCache =
    this.settingsCaches.registerDeviceCache<AudioDetectionSettings>(
      'audio-detection',
      SETTINGS_CACHE_TTL_MS,
    )
  private readonly sensitivitySettingsCache =
    this.settingsCaches.registerDeviceCache<DetectionSensitivitySettings>(
      'detection-sensitivity',
      SETTINGS_CACHE_TTL_MS,
    )
  private readonly trackingSettingsCache =
    this.settingsCaches.registerDeviceCache<TrackingSettings>('tracking', SETTINGS_CACHE_TTL_MS)
  /** Per-device confirmation-gate settings cache (default off), TTL-mirrored. */
  private readonly confirmationGateSettingsCache =
    this.settingsCaches.registerDeviceCache<ConfirmationGateSettings>(
      'confirmation-gate',
      SETTINGS_CACHE_TTL_MS,
    )
  private readonly faceSettingsCache = this.settingsCaches.registerDeviceCache<FaceSettings>(
    'face',
    SETTINGS_CACHE_TTL_MS,
  )
  /** GLOBAL face-recognition master switch (addon store), TTL-cached. */
  private readonly faceGlobalEnabledCache = this.settingsCaches.registerGlobalCache<boolean>(
    'face-global-enabled',
    SETTINGS_CACHE_TTL_MS,
  )
  private readonly mediaSettingsCache = this.settingsCaches.registerDeviceCache<MediaSettings>(
    'media',
    SETTINGS_CACHE_TTL_MS,
  )
  private readonly packageDropSettingsCache =
    this.settingsCaches.registerDeviceCache<PackageDropSettings>(
      'package-drop',
      SETTINGS_CACHE_TTL_MS,
    )
  /** Per-device stationary settings cache (#31), TTL-mirrored like media/tracking.
   *  The registry is a single shared instance, so per-(device) suppress/wake IoU,
   *  promotion window, TTL and the master toggle are resolved from this cache at
   *  the partition + promotion + sweep call sites — an operator change takes
   *  effect within one SETTINGS_CACHE_TTL_MS tick without an addon restart. */
  private readonly stationarySettingsCache =
    this.settingsCaches.registerDeviceCache<StationarySettings>('stationary', SETTINGS_CACHE_TTL_MS)
  /** Per-device STILLNESS SCALE cache — the measured "how slow is settled" bar
   *  (`stillness-settings.ts`). Read once per FrameProcessor build, so this is
   *  a cold-path cache; it exists so a calibration applied through
   *  `stillness.calibrate` reaches the tracker on the next processor rebuild
   *  rather than on the next addon restart. */
  private readonly stillnessSettingsCache =
    this.settingsCaches.registerDeviceCache<StillnessSettings>('stillness', SETTINGS_CACHE_TTL_MS)
  /** Turns stationary appear/depart into package-delivered/picked-up events. */
  private packageDropDetector: PackageDropDetector | null = null
  /** Native zone crops for a packages rule that opted into scene difference or LLM confirm. */
  private packageScene: PackageSceneCoordinator | null = null
  /** Durable ghost-cycle memory behind package background suppression. */
  private packageBackground: PackageBackgroundRegistry | null = null
  /**
   * The ONE production trigger for silent cameras (D683 §6.4, review C2): run
   * by `sweepExpiredTracks` every `TTL_SWEEP_INTERVAL_MS`, before the closer,
   * so a camera whose frames stopped still ends its tracklets and commits its
   * fusions. Task 16 wires its `canClose` into the closer.
   */
  private _trackerSweep: TrackerSweep | null = null
  private get trackerSweep(): TrackerSweep {
    // Lazy: `this.ctx` is not assigned when field initialisers run.
    this._trackerSweep ??= new TrackerSweep({
      processors: () => this.frameState.processors,
      processorsOf: (deviceId) => this.processorsOf(deviceId),
      applyFusions: (deviceId, key, fusions) => this.applyTrackFusions(deviceId, key, fusions),
      logger: this.ctx.logger,
    })
    return this._trackerSweep
  }
  /** The per-track close-path orchestrator (S2, refactor spec 2026-07-22):
   *  owns the single-flight sweep latch + the FULL per-track close sequence
   *  (zero-media policy, lastFrame promotion, recognizer ends with the
   *  deferred keyFrame-key drop, importance scoring, end events). Built
   *  lazily (needs `this.ctx`) and memoised; nullable collaborators are
   *  injected as getters so it always sees the live references. */
  private _trackCloser: TrackCloser | null = null
  /** D276: closed tracks still owed a native tile, redeemed by the late
   *  keyFrame exec (`runPreviewUpgrade`). Bounded (TTL + cap) in the module. */
  private readonly pendingPreviewUpgrades = new PendingPreviewUpgrades()
  /** The ONE keyFrame→thumbnail derive closure (skew-guarded), shared by the
   *  close-time derive and the late-upgrade redeem so both cut the SAME
   *  framing (D52's one-derivation discipline applied to the preview). */
  private _keyFrameThumbnailDerive:
    | ((input: PreviewUpgradeDeriveInput) => Promise<PreviewUpgradeDerived | null>)
    | null = null
  /** Notification Center P1 core (spec 2026-07-22, D-2): rule evaluation
   *  hooked on the durable persist moments (object-event insert +
   *  TrackCloser.closeExpired) with a persisted outbox + retry. Built in
   *  onInitialize (needs the stores + ctx.api); evaluation/drain runs
   *  ONLY on the designated post-processing node, while the
   *  `notification-rules` provider (CRUD over the central store) is
   *  registered from every node. */
  private notificationCenter: NotificationCenter | null = null
  /**
   * The live alarm panel on THIS node, or null.
   *
   * Held, where the earlier note said not to. The objection then was a field
   * nothing reads growing into a second source of truth for which device the
   * alarm is — and it stands: the panel is still addressed by stable id
   * everywhere else. This reference exists because two things now READ it, and
   * neither can go through the device id: the settings tab, which needs the
   * panel's own config, and the arm announcement, which the panel pushes.
   */
  private alarmPanelDevice: NcAlarmPanelDevice | null = null
  /** Live only while a FAILED boot declaration is still being retried. Null on
   *  the boots that got the panel first time — which is nearly all of them. */
  private alarmPanelConvergence: AlarmPanelConvergence | null = null
  /** True once panel and centre are joined, so a late-landing declaration
   *  cannot re-seed the gate mirror over a state the panel has since left. */
  private alarmPanelWired = false
  /** THE single owner of capture pressure (S3, refactor spec 2026-07-22):
   *  every native-fetch call site routed so far (the per-frame batch media
   *  dispatch + `persistKeyFrames`; part B routes the rest) goes through ONE
   *  per-device budget with priority ordering, coalescing and stale-drop.
   *  Built lazily (needs `this.ctx.logger`) and memoised. */
  private _captureScheduler: CaptureScheduler | null = null
  /**
   * The per-camera failure counters this addon reports through
   * `failure-contribution` — enrichment crop, capture lane, plate OCR, person
   * births. Bounded, cumulative, and read (never drained) by the provider.
   * Constructed eagerly: a counter created lazily on first failure would have
   * no denominator for everything that succeeded before it.
   */
  private readonly failureReport = new AnalyticsFailureReport()
  /** THE single owner of ALL per-track live state (S1, refactor spec
   *  2026-07-22): best-frame tracker peaks, best CLIP-object selector entries,
   *  the Design-B keyFrame key, the rolling-lastFrame clock,
   *  firstFrame-pending (DEFECT A), thumbnail-landed (#27-A), the lifecycle
   *  update-gate memory and the zero-media close-policy state. (The four RC-1
   *  in-flight gates moved to the CaptureScheduler in S3 — coalesce/hold
   *  keys.) Every record carries its deviceId; `close(trackId, mode)` runs
   *  the FULL cleanup litany on every teardown path (and cancels the track's
   *  queued captures via the onClose hook) and `closeDevice` finally clears
   *  per-track state on device removal (the two documented leaks). */
  private readonly residents = new TrackResidentState({
    onClose: (trackId) => {
      this.captureScheduler.cancelForTrack(trackId)
      // The track is gone in every close mode; its parcels leave the node
      // with it (D422). The node's own age ceiling covers a lost release.
      this.parkedFrames?.release(trackId)
    },
    // D683 (Task 17): adopting a piece closes nothing — the survivor's
    // parked-frame reads just need to know where to fall back to.
    onAdopt: (survivorId, absorbedId, bestShotFrom) => {
      this.parkedFrames?.adopt(survivorId, absorbedId, bestShotFrom)
    },
    // D683 review M1: late work under an absorbed id is refused, never
    // resurrected as a ghost resident — and the refusal is said (sampled).
    onLateAbsorbedWork: (work) => {
      this.ctx.logger.info('track resident: late work after close refused', {
        tags: { deviceId: work.deviceId },
        meta: {
          trackId: work.trackId,
          survivorId: work.survivorId,
          reason: work.reason,
          kind: work.write,
          refused: work.refused,
        },
      })
    },
  })
  /**
   * The hub's side of a PARK (D422): orders the owning node to keep a track's
   * best frame the instant `BestDetectionTracker` accepts it, and answers the
   * keyFrame writer, the best-shot thumbnail and the detail plane's full-frame
   * rung by `(deviceId, trackId, kind)` — never by handle. Null until init.
   */
  private parkedFrames: ParkedFrameClient | null = null
  /** What keeping face source frames costs, per camera (D644). */
  private readonly faceSourceStats = new FaceSourceStats()
  /** Defence in depth for the 2026-08-21 `b50e09f7` incident: a row the track
   *  store has already CLOSED never earns another media target, whatever the
   *  tracker keeps handing back. Reads the store's in-RAM close record only —
   *  see `pipeline/closed-row-media-gate.ts` for why it can only fail OPEN. */
  private readonly closedRowMediaGate = new ClosedRowMediaGate()
  /**
   * D683 review N2: the FRAME-PATH half of "a closed row never comes back" —
   * a SEPARATE sampling instance (own per-track windows; a media refusal and
   * a frame-drop refusal on the same track in the same frame are different
   * EVENTS and must not share one suppressed count). Asked BEFORE the
   * detection reaches `TrackStore.upsert` or any downstream consumer (birth
   * classification, event rows, notifications) — not only the media gate
   * D220 already covers. See `dropClosedRowDetection` below.
   */
  private readonly frameDroppedClosedRowGate = new ClosedRowMediaGate()
  /** Windowed per-device aggregation of the "media capture" diagnostic — the
   *  per-capture line is debug; a 60s per-counter SUM lands at info (~1
   *  line/min/device instead of one per §5 cadence tick, see media-capture-log.ts). */
  private readonly mediaCaptureLog = new MediaCaptureLogAggregator()
  /** Per-device hit/miss window for the native `keyFrame` path (2026-08-06).
   *  Before it there was NO metric here at all — the by-handle key-frame fetch
   *  in `runtime/native-frame-transport.ts` (retired by D422) never touched
   *  `bumpCropMetric` — so whether a key-frame fix worked could only be
   *  answered by hand-counting Loki lines. See `key-frame-metrics.ts`. */
  private readonly keyFrameCaptureLog = new KeyFrameCaptureLog()
  /** The registry's own liveness answer, mirrored off `ClusterTopologySnapshot`,
   *  so a capture is never dispatched at a node the hub already called dead.
   *  388 of 2026-08-06's key-frame misses were one offline developer laptop. */
  private readonly nodeLiveness = new NodeLivenessMirror()
  /** S8 (refactor spec 2026-07-22): the thin read/prune/footprint/ops-log cap
   *  bodies live in `analytics-query-facade.ts`; the class keeps one-line
   *  delegates because the pipeline-analytics cap registers `this` as its
   *  provider. Deps are lazy getters — the stores are late-bound in boot. */
  /**
   * Zone id→name dictionary for the track read path.
   *
   * `zonesVisited` persists ids; every operator-facing surface needs the name.
   * Cached per device (see `ZoneCatalogueCache`) so a merged 1000-row page
   * costs at most one `listZones` per camera per minute rather than one per
   * page.
   */
  private readonly zoneCatalogue = new ZoneCatalogueCache({
    fetchZones: (deviceId) => this.ctx.api.zones.listZones.query({ deviceId }),
    now: () => Date.now(),
    onError: (deviceId, error) => {
      // A branch that drops work silently reads as "never happened", and this
      // one drops the only human-readable form of a zone.
      this.ctx.logger.warn('zone catalogue read failed — zone names unresolved for this device', {
        tags: { deviceId },
        meta: { deviceId, error: errMsg(error) },
      })
    },
  })

  /**
   * The zone catalogue every OCCUPANCY path reads (live frames, snapshot
   * hydration, the parked-object baseline sampler). Mirror-first with a
   * capability fallback — see `device-zone-resolver.ts` for why the mirror
   * alone is not enough (device 102 had a zone the mirror had never heard of).
   */
  private readonly deviceZones = new DeviceZoneResolver({
    readMirror: (deviceId) => this.proxies.get(deviceId)?.state.zones.value?.zones,
    fetchZones: (deviceId) => this.ctx.api.zones.listZones.query({ deviceId }),
    now: () => Date.now(),
    onMirrorDiverged: (deviceId, authorityCount) => {
      // The mirror claimed this camera has no zones while the cap listed some.
      // Silent here is what let 102 report `zones: []` for weeks.
      this.ctx.logger.warn('zone state mirror empty — zones resolved from the cap instead', {
        tags: { deviceId },
        meta: { deviceId, authorityCount },
      })
    },
    onError: (deviceId, error) => {
      this.ctx.logger.warn('zone catalogue read failed — occupancy zones may be stale', {
        tags: { deviceId },
        meta: { deviceId, error: errMsg(error) },
      })
    },
  })

  private readonly queryFacade = new AnalyticsQueryFacade({
    trackStore: () => this.trackStore,
    eventStore: () => this.eventStore,
    mediaStore: () => this.mediaStore,
    sensorEventStore: () => this.sensorEventStore,
    opsLog: () => this.eventsOpsLog,
    eventMediaBaseUrl: () => this.eventMediaBaseUrl,
    eventMediaPathPrefix: () => this.eventMediaPathPrefix(),
    logger: () => this.ctx.logger,
    zoneCatalogue: () => this.zoneCatalogue,
  })
  /** The shared crop extractor (native-res first, detection-frame fallback),
   *  captured in the constructor so `processFrame` can crop object thumbnails in
   *  the same live-frame window as the face/plate/event-media captures. The
   *  optional `maxWidth` caps the native crop width (used for the full-frame key
   *  frame so a 4K native surface never floods the transport). */
  /**
   * The BOUNDED fallback `captureCrop` refuses — same padded ROI out of the
   * retained full frame (keyframe-native tier, or the runner's ≤640 RAM tier;
   * honest sub-native, NEVER upscaled). Built for the gallery tiles; the
   * confirmation gate borrows it on an EXHAUSTED deferral only. See
   * `docs/decisions/` — the gate is a model input, so this is a deliberate
   * exception to "model-input crops keep captureCrop".
   */
  /**
   * The operator-debug crop capture (`pipeline/debug-crop-capture.ts`).
   *
   * Null until the transport and the media store exist. Reached from three
   * decision sites and gated INSIDE the capture on the track's `debug` flag, so
   * a camera with no marked track pays one map lookup per decision — see the
   * capture's module doc for why the gate lives there and not at each site.
   */
  private captureDebugCropFn: DebugCropCaptureFn | null = null

  private captureDisplayCropFn: DisplayCropFn | null = null

  /**
   * Offer one decision's pixels to the operator-debug crop capture.
   *
   * Fire-and-forget and NEVER throws: this is the addon's own bookkeeping, and
   * a frame path that can be slowed or broken by a diagnostic is worse than no
   * diagnostic. The gate, the per-track cap and all six refusal reasons live in
   * the capture (`pipeline/debug-crop-capture.ts`); this is only the seam.
   */
  private offerDebugCrop(input: DebugCropCaptureInput): void {
    const capture = this.captureDebugCropFn
    if (capture === null) return
    void capture(input).catch((err: unknown) => {
      // The capture already names every refusal it reaches; this catches only
      // the ones it cannot (a rejected fetch). Silence here would put the one
      // unaccounted branch back.
      this.ctx.logger.debug('debug crop offer threw', {
        tags: { deviceId: input.deviceId },
        meta: {
          deviceId: input.deviceId,
          trackId: input.trackId,
          decision: input.decision,
          error: err instanceof Error ? err.message : String(err),
        },
      })
    })
  }
  private captureCrop:
    | ((
        frameHandle: FrameHandle,
        bbox: { x: number; y: number; w: number; h: number },
        frameWidth: number,
        frameHeight: number,
        padding: number,
        maxWidth?: number,
        /** Tags the native-miss log. See `CaptureCropFn`. */
        deviceId?: number,
      ) => Promise<Buffer | null>)
    | null = null
  private shuttingDown = false
  /**
   * Sensor handlers the bus dispatched under `void` that have not finished.
   * `onShutdown` DRAINS them before it tears anything down: a handler awaits a
   * snapshot for its marker before its last context read, and one left running
   * across the teardown threw "ctx accessed before initialize()" as an
   * unhandled rejection with no device on it.
   */
  private readonly sensorHandlersInFlight = new Set<Promise<void>>()
  /**
   * Per-device delivery-lag windows, folded at `handleInferenceResult` entry.
   * The instrument that tells a late DELIVERY (starved) apart from a slow
   * `processFrame` (waiting) — see `frame-lag-observer.ts`. Costs one map read
   * and ~10 numeric ops per frame, and writes one line per device per 30 s.
   */
  private readonly frameLag = new FrameLagObserver()
  /**
   * Stops the GC-attributing stall monitor armed in {@link onInitialize}.
   *
   * The other half of the frame-lag line: that one says whether the events
   * arrived late, this one says whether THIS loop was blocked while they did.
   * The 5-minute `[mem]` heartbeat cannot see a 10 s freeze — it fired at
   * dt = 300020 / 300066 / 299991 ms straight through the 2026-09-09 silences.
   */
  private stopStallMonitor: (() => void) | null = null
  /** True only on the cluster's designated post-processing node. When false the
   *  addon subscribes to NOTHING — fully inert (no event/media generation). */
  private isPostProcessingNode = true

  // ── Durable addon-store handles (single shared keys) ────────────────
  //
  // Both route their reads through the Zod-validated `this.state()`
  // handle over the SAME store keys the raw reads used. Built lazily
  // (needs `this.ctx`) and memoised.
  private _postProcessingNodeState: DurableState<string> | null = null

  private get postProcessingNodeState(): DurableState<string> {
    if (!this._postProcessingNodeState) {
      this._postProcessingNodeState = this.state<string>(
        'postProcessingNodeId',
        PostProcessingNodeIdSchema,
        POST_PROCESSING_NODE_DEFAULT,
      )
    }
    return this._postProcessingNodeState
  }

  private get captureScheduler(): CaptureScheduler {
    if (!this._captureScheduler) {
      this._captureScheduler = new CaptureScheduler({
        logger: this.ctx.logger,
        // D276/B2: a PREVIEW capture the scheduler drops without exec-ing is a
        // reason a track can close tile-less — note it on the residents so the
        // close can persist `thumbnail:overflow` / `keyframe:stale` instead of
        // an unexplained `no-key-frame`.
        onDropped: (drop) => {
          // The per-camera counter takes EVERY drop, whatever its kind: the
          // scheduler window the operator quoted (`requested:100 started:15
          // droppedStale:70 droppedOverflow:11`) is about the lane, not about
          // preview media, and restricting it to thumbnails would under-report
          // the saturation by the enrichment captures that caused it.
          this.failureReport.noteCaptureSchedule(
            drop.deviceId,
            drop.cause === 'stale' ? REASON_STALE_DROP : REASON_QUEUE_OVERFLOW,
          )
          if (drop.trackId === undefined) return
          if (drop.kind !== 'thumbnail' && drop.kind !== 'keyFrame') return
          this.residents.notePreviewCaptureMiss(
            drop.deviceId,
            drop.trackId,
            `${drop.kind}:${drop.cause}`,
          )
        },
        // The denominator for the two drop reasons above.
        onStarted: (deviceId) => this.failureReport.noteCaptureSchedule(deviceId),
      })
    }
    return this._captureScheduler
  }

  /** #27-A part 3 + D276: the keyFrame→thumbnail derive. Reuses the EXISTING
   *  keyframe-crop utility (media fetch + temporal-skew guard + decode — the
   *  same one backing the durable plate crop, commit a6271f1ff) with the
   *  standard 16:9 central-square framing swapped in as the crop compose.
   *  `padding: 0` — the wide layout applies its own subject margin. */
  private get keyFrameThumbnailDerive(): (
    input: PreviewUpgradeDeriveInput,
  ) => Promise<PreviewUpgradeDerived | null> {
    if (!this._keyFrameThumbnailDerive) {
      const deriveKeyFrameThumbnailJpeg = createKeyFrameCrop({
        getMedia: async (mediaKey) => {
          const m = await this.mediaStore?.getBytesById(mediaKey)
          return m ? { bytes: m.bytes, timestamp: m.timestamp } : null
        },
        decodeJpegToRgb: (jpeg) => decodeJpegToRgb(jpeg),
        cropRegionToJpeg: (bytes, w, h, norm) => cropWideCentralSquareFromRgb(bytes, w, h, norm),
        maxSkewMs: KEYFRAME_CROP_MAX_SKEW_MS,
        minSubjectIou: KEYFRAME_CROP_MIN_SUBJECT_IOU,
        maxSubjectSampleGapMs: KEYFRAME_CROP_MAX_SAMPLE_GAP_MS,
        logger: this.ctx.logger.child('CloseKeyFrameThumbnail'),
      })
      this._keyFrameThumbnailDerive = async (input) => {
        const derived = await deriveKeyFrameThumbnailJpeg({
          ...input,
          padding: 0,
        })
        if (!derived) return null
        return {
          thumbnail: derived.jpeg,
          thumbnailSmall: await deriveThumbnailSmall(derived.jpeg),
          skewMs: derived.skewMs,
          motion: derived.motion,
          ...(derived.subjectIou !== undefined ? { subjectIou: derived.subjectIou } : {}),
        }
      }
    }
    return this._keyFrameThumbnailDerive
  }

  /**
   * D683 Task 18: the ONE sequence that turns an L2 fusion into one track
   * everywhere — rows checked first, RAM synchronously, durable re-point on a
   * per-device queue (`pipeline/track-fusion-service.ts`). Lazy (needs
   * `this.ctx`); every store is read through a closure so the service always
   * sees the live reference.
   */
  private _trackFusion: TrackFusionService | null = null
  private get trackFusion(): TrackFusionService {
    this._trackFusion ??= new TrackFusionService({
      logger: this.ctx.logger.child('track-fusion'),
      residents: {
        adopt: (survivorId, absorbedId) => this.residents.adopt(survivorId, absorbedId),
        bestShotMediaIds: (survivorId) => {
          const id = this.residents.keyFrameMediaId(survivorId)
          return new Set(id !== undefined ? [id] : [])
        },
        bestShotHolder: (survivorId) => this.residents.currentBestShotHolder(survivorId),
      },
      // Review 2 M6: the tracker ends the chain (`dropped`, never linked); the
      // subject re-appears as a new piece with a row of its own. A tracker
      // input no frame carries — the tape records it, like the closed-id drop.
      onRefused: (deviceId, key, f) => {
        const processor = this.frameState.processors.get(key)
        if (processor === undefined) return
        processor.dropTrack(f.survivorId, 'dropped')
        this.tapeRecorder?.onDrop({
          deviceId,
          plane: processor.source,
          trackId: f.survivorId,
          atMs: f.t,
          reason: 'dropped',
        })
      },
      recognizers: {
        adoptFace: (deviceId, survivorId, absorbedId) =>
          this.faceRecognizer?.adoptTrack(deviceId, survivorId, absorbedId),
        adoptPlate: (deviceId, survivorId, absorbedId) =>
          this.plateRecognizer?.adoptTrack(deviceId, survivorId, absorbedId),
      },
      liveState: {
        forget: (deviceId, key, absorbedId) => {
          this.detailDispatcher?.onTrackEnded(deviceId, absorbedId)
          this.overlayState.onTrackEnded(deviceId, absorbedId)
          // No spurious 'track lost' for an id that lives on as the survivor.
          // (The birth registries forget it on this same frame's `retain`.)
          this.frameState.lastActiveTrackIds.get(key)?.delete(absorbedId)
        },
      },
      lifecycle: {
        emitFusedEnd: (deviceId, absorbedId, survivorId) =>
          this.emitFusedTrackEnd(deviceId, absorbedId, survivorId),
        // D692: a grouped notification window merges or re-keys the member.
        fused: (deviceId, survivorId, absorbedId) =>
          this.notificationCenter?.onTracksFused({ deviceId, survivorId, absorbedId }),
      },
      trackStore: {
        rowState: (trackId) => this.trackStore?.rowState(trackId) ?? 'none',
        adopt: (survivorId, absorbedId) => this.trackStore?.adopt(survivorId, absorbedId) === true,
        noteMember: (deviceId, survivorId, absorbedId) =>
          this.trackStore?.noteMember(deviceId, survivorId, absorbedId),
        membersOf: (survivorId) => this.trackStore?.membersOf(survivorId) ?? [],
      },
      aliases: {
        record: async (deviceId, aliasId, trackId, fusedAt) => {
          const aliasStore = this.trackAliasStore
          if (aliasStore === null) throw new Error('track alias store not bound')
          await aliasStore.record(deviceId, aliasId, trackId, fusedAt)
        },
      },
      leaves: () => this.buildTrackFusionLeaves(),
      media: this.trackFusionMediaPort,
    })
    return this._trackFusion
  }

  /** Await every queued fusion re-point, at most {@link FUSION_SHUTDOWN_SETTLE_MS}. */
  private async settleTrackFusions(): Promise<void> {
    const service = this._trackFusion
    if (service === null) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), FUSION_SHUTDOWN_SETTLE_MS)
    })
    const outcome = await Promise.race([
      service.settledAll().then(() => 'settled' as const),
      deadline,
    ])
    if (timer !== undefined) clearTimeout(timer)
    if (outcome === 'timeout') {
      this.ctx.logger.warn('track fusion re-points still queued at shutdown — left unsettled', {
        meta: { waitedMs: FUSION_SHUTDOWN_SETTLE_MS },
      })
    }
  }

  /** The media operations the face/plate fusion leaves need, over the live store. */
  private readonly trackFusionMediaPort: TrackFusionMediaPort = {
    moveOwner: (ownerKind, fromOwnerId, toOwnerId) =>
      this.requireMediaStore().moveOwner(ownerKind, fromOwnerId, toOwnerId),
    deleteOwner: (ownerKind, ownerId) => this.requireMediaStore().deleteOwner(ownerKind, ownerId),
    stillPresent: (mediaId) => this.requireMediaStore().stillPresent(mediaId),
  }

  private requireMediaStore(): MediaStore {
    if (this.mediaStore === null) throw new Error('media store not bound')
    return this.mediaStore
  }

  /**
   * The `end` of a piece L2 fused into another track (D683): its row is read
   * while still ACTIVE (before `TrackStore.adopt` folds it), and the payload is
   * the closer's own shape plus `fusedIntoTrackId` — consumers merge rather
   * than count two. The absorbed id's lifecycle memory already went with its
   * resident (`TrackResidentState.adopt`).
   */
  private emitFusedTrackEnd(deviceId: number, absorbedId: string, survivorId: string): void {
    const row = this.trackStore?.getActiveByTrack(absorbedId)
    if (row === null || row === undefined) {
      this.ctx.logger.warn('fused track end not emitted — the absorbed row is gone', {
        tags: { deviceId },
        meta: { absorbedId, survivorId },
      })
      return
    }
    const label = displayLabel(row)
    const payload: PipelineAnalyticsTrackLifecyclePayload = {
      ...buildTrackLifecyclePayload({
        deviceId,
        trackId: absorbedId,
        phase: 'end',
        classes: row.classes ?? [row.className],
        bestClassName: row.className,
        // The piece's own peak went with its resident into the survivor's;
        // the merged subject's best is what a consumer merging the two needs.
        bestConfidence: this.residents.bestFramePeak(survivorId)?.confidence ?? 0,
        firstSeen: row.firstSeen,
        lastSeen: row.lastSeen,
        ...(label !== undefined ? { label } : {}),
        zonesVisited: row.zonesVisited,
        totalDistance: row.totalDistance,
        positionsCount: row.positions.length,
        ...(row.audioLabels !== undefined ? { audioLabels: row.audioLabels } : {}),
      }),
      fusedIntoTrackId: survivorId,
    }
    this.emitTrackLifecycle(payload, row.lastSeen)
  }

  private get trackCloser(): TrackCloser {
    if (!this._trackCloser) {
      this._trackCloser = new TrackCloser({
        logger: this.ctx.logger,
        residents: this.residents,
        trackStore: () => this.trackStore,
        mediaStore: () => this.mediaStore,
        eventStore: () => this.eventStore,
        faceRecognizer: () => this.faceRecognizer,
        plateRecognizer: () => this.plateRecognizer,
        detailDispatcher: () => this.detailDispatcher,
        overlayState: this.overlayState,
        mediaCaptureLog: this.mediaCaptureLog,
        frameDims: (deviceId) => this.frameState.lastFrameDimsByDevice.get(deviceId),
        isShuttingDown: () => this.shuttingDown,
        // Deprecated thin `TrackEnded` alias — envelope/category stay here so
        // the closer emits through the ONE event bus (D8) without owning it.
        emitTrackEnded: (data, timestampMs) => {
          this.ctx.eventBus.emit({
            id: `pa-end-${data.trackId}`,
            timestamp: new Date(timestampMs),
            source: {
              type: 'addon',
              id: 'pipeline-analytics',
              addonId: 'pipeline-analytics',
            },
            category: EventCategory.PipelineAnalyticsTrackEnded,
            data: {
              deviceId: data.deviceId,
              trackId: data.trackId,
              className: data.className,
              durationMs: data.durationMs,
            },
          })
        },
        emitTrackLifecycle: (payload, timestampMs) => this.emitTrackLifecycle(payload, timestampMs),
        // Notification Center track-end hook (D-3): the closer stays dumb —
        // it fires the injected callback once per REAL close; the center
        // owns evaluation, throttling and the durable outbox.
        onTrackClosed: (track, ownedMedia, info) => {
          this.noteShortMotionlessTrack(track)
          return this.notificationCenter?.onTrackClosed(track, ownedMedia, info)
        },
        // #27-A part 3: both persisted variants derive from the ONE keyFrame
        // crop — `thumbnailSmall` is the same window downscaled (never a
        // second fetch, never upscaled). Shared with the late-upgrade redeem.
        deriveThumbnailFromKeyFrame: (input) => this.keyFrameThumbnailDerive(input),
        // D276/B2: what the residents accumulated about this track's failed
        // preview captures — read at close, before the record drops.
        previewCaptureMiss: (trackId) => this.residents.previewCaptureMiss(trackId),
        // D276: closed-without-a-native-tile → redeemable by the late keyFrame.
        recordPendingPreviewUpgrade: (entry) => this.pendingPreviewUpgrades.record(entry),
        // D276/B2: the reason lands on the track ROW (the closer owns the
        // failure log — it has the deviceId and the composed reason).
        setPreviewMiss: async (_deviceId, trackId, reason) => {
          await this.trackStore?.setPreviewMiss(trackId, reason)
        },
        isKnownParked: (track) => {
          const last = track.positions.at(-1)?.bbox
          if (!last) return false
          return bboxMatchesParkedEntry(
            last,
            track.className,
            this.stationaryRegistry?.listViews(track.deviceId) ?? [],
          )
        },
        // A discarded track (D547) wrote media, events and a vector while it
        // lived; the same cascade retention runs takes them, at once.
        discardTracks: (tracks) => this.cascadeDiscardedTracks(tracks),
        // D683 §6.4 (review C2/M2): the ONE production gate — a row closes
        // only when the tracker says its chain is not live and its tail is
        // final, asked in the processor's own frame clock. No second
        // implementation here.
        canClose: (t) => this.trackerSweep.canClose(t, Date.now()),
        // D683 review M2: names WHY a row is held, for the hold/force-close log.
        canCloseReason: (t) => this.trackerSweep.canCloseReason(t, Date.now()),
        // D683 review N5: the force-close bound must never be shorter than
        // what THIS camera's own tracker config is willing to coast through.
        maxMissedMsOf: (t) => {
          let max = 0
          for (const p of this.processorsOf(t.deviceId)) max = Math.max(max, p.maxMissedMs)
          return max
        },
        // D683 (review H2): the zero-media suppression cascade
        // (`suppressZeroMedia`) is a production cascade path this closer
        // runs directly, outside `buildTrackCascadeRegistry`'s callers.
        aliasStore: () => this.trackAliasStore,
        expandLeafIds: (ids) => {
          const aliasStore = this.trackAliasStore
          return aliasStore ? aliasStore.aliasesOf(ids) : Promise.resolve([])
        },
        // D683 Task 18 (review H4, review 2 L7): before a survivor's row is
        // persisted, re-point what landed under the ids it absorbed after the
        // fusion; from then on the store refuses writes under them.
        beforePersist: (t) => this.trackFusion.sweepUp(t.deviceId, t.trackId),
      })
    }
    return this._trackCloser
  }

  /**
   * Cascade what `expireStale` refused to persist (D547): scenery re-fires and
   * re-sightings of a censused object. Per device, per track, through the
   * shipped registry — never a raw delete — so the vector, the crops and the
   * events go with the media. A track whose cascade fails is named.
   */
  private async cascadeDiscardedTracks(tracks: readonly Track[]): Promise<void> {
    const cascade = this.buildTrackCascadeRegistry()
    if (!cascade) {
      this.ctx.logger.warn('discarded tracks could not be cascaded — stores not ready', {
        meta: { trackIds: tracks.map((t) => t.trackId) },
      })
      return
    }
    const byDevice = new Map<number, string[]>()
    for (const t of tracks) {
      const ids = byDevice.get(t.deviceId) ?? []
      ids.push(t.trackId)
      byDevice.set(t.deviceId, ids)
    }
    for (const [deviceId, trackIds] of byDevice) {
      const result = await runTrackCascadeBatch(
        {
          registry: cascade.registry,
          trackStore: cascade.trackStore,
          deviceId,
          onTrackCleanup: (id, trackId) => this.clearLiveTrackState(id, trackId),
          // D683 (review H2/N6): a discarded (short-motionless/known-parked)
          // track can itself be a fusion survivor.
          ...(cascade.expandLeafIdsGrouped !== undefined
            ? { expandLeafIdsGrouped: cascade.expandLeafIdsGrouped }
            : {}),
          onExpandBatchFailure: (failedIds, err) =>
            this.logExpandBatchFailure(deviceId, failedIds, err),
          onFailure: (trackId, err) => {
            this.ctx.logger.warn('discarded track could not be cascaded', {
              tags: { deviceId },
              meta: { deviceId, trackId, error: String(err) },
            })
          },
        },
        trackIds,
      )
      this.ctx.logger.info('tracks discarded on expiry — still objects are entities, not tracks', {
        tags: { deviceId },
        meta: {
          deviceId,
          trackIds,
          deleted: result.deleted,
          failed: result.failed,
          mediaRows: result.tally.media,
        },
      })
    }
  }

  /**
   * Dispose of the tracks that carried a promoted candidate's evidence and
   * NEVER MOVED (D547; D683 round 4 — a track that moved is kept and never
   * reaches here). The entry's key frame is spared — it is the one row the
   * entity vouches for, and `keptStationaryMediaKeys` keeps the orphan audit
   * off it.
   */
  private async disposePromotedTracks(
    deviceId: number,
    entry: StationaryEntry,
    trackIds: readonly string[],
  ): Promise<void> {
    const cascade = this.buildTrackCascadeRegistry()
    if (!cascade) {
      this.ctx.logger.warn(
        'stationary promotion: source tracks could not be disposed of — stores not ready',
        {
          tags: { deviceId },
          meta: { deviceId, entryId: entry.id, trackIds },
        },
      )
      return
    }
    const plan = planStationaryTrackDisposal({
      trackIds,
      ...(entry.keyFrameMediaId !== undefined
        ? { entryKeyFrameMediaId: entry.keyFrameMediaId }
        : {}),
    })
    await disposeStationaryTracks(
      {
        deviceId,
        entryId: entry.id,
        // The shipped order minus the media leg (re-added with the spare
        // set) and the alias leg (D683 review H2: re-added LAST, after the
        // media-sparing swap, by `disposeStationaryTracks` itself).
        leaves: cascade.registry.filter(
          (leaf) => leaf !== cascade.mediaLeg && leaf !== cascade.aliasLeg,
        ),
        media: cascade.mediaLeg,
        aliasLeg: cascade.aliasLeg,
        trackStore: cascade.trackStore,
        onTrackCleanup: (id, trackId) => this.clearLiveTrackState(id, trackId),
        logger: this.ctx.logger,
        // D683 review L-R2: grouped, same as every other `runTrackCascadeBatch`
        // caller — the source tracks disposed of here can be different
        // subjects (`sameChainAsLive: false`), so no flat-union adapter.
        ...(cascade.expandLeafIdsGrouped !== undefined
          ? { expandLeafIdsGrouped: cascade.expandLeafIdsGrouped }
          : {}),
      },
      plan,
    )
  }

  /**
   * Media row keys a live stationary entry vouches for (D547) — the orphan
   * audit's probe. Answered from the registry's RAM index, which is the
   * authority on which entries are alive.
   */
  private keptStationaryMediaKeys(keys: readonly string[]): ReadonlySet<string> {
    const held = this.stationaryHeldMediaIds()
    return new Set(keys.filter((key) => held.has(Number(key))))
  }

  /** D683 review N1/N2: the sampled line for a frame-path detection dropped
   *  because its row is already closed — D220 style (one per track per
   *  window, with a suppressed count), on its OWN gate so it never shares a
   *  suppression window with the media refusal's. */
  private logClosedRowFrameDrop(deviceId: number, trackId: string): void {
    const verdict = this.frameDroppedClosedRowGate.evaluate(
      trackId,
      this.trackStore?.rowClosedAt(trackId),
      Date.now(),
    )
    if (!verdict.log) return
    this.ctx.logger.warn('track detection dropped — row already closed, chain told to drop', {
      tags: { deviceId },
      meta: { trackId, closedAgeMs: verdict.closedAgeMs, suppressed: verdict.suppressed },
    })
  }

  /** D683 review L-R3: the ONE batch-level line when a cascade's grouped
   *  alias lookup itself throws — every id in the batch fails closed (N6),
   *  correctly, but the per-track `onFailure` sinks all log at DEBUG. An
   *  operator watching INFO/WARN must see retention stall and why, not
   *  silently reclaim nothing. */
  private logExpandBatchFailure(
    deviceId: number,
    failedIds: readonly string[],
    err: unknown,
  ): void {
    this.ctx.logger.warn(
      'track cascade: alias lookup failed for the whole batch — nothing in it was widened',
      {
        tags: { deviceId },
        meta: { deviceId, failedCount: failedIds.length, error: String(err) },
      },
    )
  }

  /**
   * The orphan audit's track-liveness probe, widened through the alias
   * collection (D683 review M4): an id this store has no row for may still
   * be an ABSORBED id whose survivor is alive — a row still keyed by it is
   * track-owned, not orphaned, for as long as the survivor is. Resolved in
   * two rounds (never a row's own id counted live without a real check): the
   * direct hits first, then — only for the ids that missed — whether each
   * resolves to a survivor that is itself alive.
   *
   * D683 review N4: the missing half resolves through `resolveMany` — ONE
   * paged, indexed `whereIn` over the candidates, never one store round trip
   * per id (what `Promise.all(missing.map(aliasStore.resolve))` cost on
   * every id that missed `resolve`'s own hot/miss caches, and the audit can
   * hand this thousands of ids in one pass).
   */
  private async liveTrackIdsThroughAliases(
    ids: readonly string[],
    trackStore: TrackStore,
  ): Promise<ReadonlySet<string>> {
    const direct = await trackStore.existingTrackIds(ids)
    const aliasStore = this.trackAliasStore
    const missing = ids.filter((id) => !direct.has(id))
    if (aliasStore === null || missing.length === 0) return direct
    const survivorOf = await aliasStore.resolveMany(missing)
    if (survivorOf.size === 0) return direct
    const survivorIds = [...new Set(survivorOf.values())]
    const survivorsAlive = await trackStore.existingTrackIds(survivorIds)
    const out = new Set(direct)
    for (const [aliasId, survivorId] of survivorOf) {
      if (survivorsAlive.has(survivorId)) out.add(aliasId)
    }
    return out
  }

  /** Media ids every live stationary entry vouches for (D547) — spared by
   *  every track cascade (D683 round 4, review M2). */
  private stationaryHeldMediaIds(): ReadonlySet<number> {
    const registry = this.stationaryRegistry
    const held = new Set<number>()
    if (!registry) return held
    for (const deviceId of registry.deviceIds()) {
      for (const entry of registry.list(deviceId)) {
        if (entry.keyFrameMediaId !== undefined) held.add(entry.keyFrameMediaId)
      }
    }
    return held
  }

  /**
   * An entry left the registry: free the key frame it vouched for (D547),
   * unless another live entry still holds it or a track row still owns it
   * (then retention's cascade will). Never silent either way.
   */
  private async releaseStationaryKeyFrame(entry: StationaryEntry): Promise<void> {
    const mediaId = entry.keyFrameMediaId
    if (mediaId === undefined) return
    const deviceId = entry.deviceId
    const registry = this.stationaryRegistry
    const mediaStore = this.mediaStore
    const trackStore = this.trackStore
    if (!registry || !mediaStore || !trackStore) return
    const stillHeld = registry.list(deviceId).some((e) => e.keyFrameMediaId === mediaId)
    if (stillHeld) return
    try {
      const owner = await mediaStore.ownerOf(mediaId)
      if (owner === null) return
      if (owner.ownerKind === 'track') {
        // A track that is still ACTIVE owns it too — a promoted track that
        // moved is kept and has not closed yet (D683 round 4); its row will
        // own the bytes, and retention's cascade takes them with it.
        if (trackStore.getActiveByTrack(owner.ownerId) !== null) return
        const live = await trackStore.existingTrackIds([owner.ownerId])
        if (live.has(owner.ownerId)) return
      }
      await mediaStore.deleteById(mediaId)
      this.ctx.logger.info('stationary entry released its key frame', {
        tags: { deviceId },
        meta: {
          deviceId,
          entryId: entry.id,
          mediaId,
          ownerKind: owner.ownerKind,
          ownerId: owner.ownerId,
        },
      })
    } catch (err) {
      this.ctx.logger.warn('stationary entry key frame could not be released', {
        tags: { deviceId },
        meta: { deviceId, entryId: entry.id, mediaId, error: String(err) },
      })
    }
  }

  /** Master toggle for the migrated object/face EmbeddingDispatcher. Read at
   *  init; a change takes effect on addon restart (same convention as
   *  `postProcessingNodeId`).
   *
   *  The fallback is {@link EMBEDDING_ENABLED_DEFAULT} — the SAME constant the
   *  settings field declares. It is imported, not restated: this handle and
   *  that field address one store key, and when they each carried their own
   *  default they disagreed (`true` here, `false` on the form) and the form
   *  reported the opposite of what the cluster was doing. */
  private _embeddingEnabledState: DurableState<boolean> | null = null

  private get embeddingEnabledState(): DurableState<boolean> {
    if (!this._embeddingEnabledState) {
      this._embeddingEnabledState = this.state<boolean>(
        'embeddingEnabled',
        EmbeddingEnabledSchema,
        EMBEDDING_ENABLED_DEFAULT,
      )
    }
    return this._embeddingEnabledState
  }

  /**
   * The operator's prune windows, read at CALL time.
   *
   * Not cached and not captured at construction: these are the numbers an
   * operator changes on the settings page expecting the next sweep to obey, and
   * a value captured once would ignore every Save until the addon restarted.
   * Each read is four store lookups on paths that already run at most once per
   * digest or once per boot — never on a frame path.
   *
   * The defaults come from {@link PRUNE_WINDOW_DEFAULT_DAYS}, the same constant
   * the form fields declare. Imported and not restated, because this repo has
   * already shipped a handle and a field that each carried their own default
   * and disagreed (`embeddingEnabled`).
   */
  /**
   * Prune the ops log to the window the LOGGING document declares.
   *
   * Fail-soft, and deliberately in the direction of keeping: a document read
   * that fails leaves the fallback in force rather than skipping the prune
   * (which would let the audit grow forever again — it reached 11,519 rows on
   * the operator's hub with no retention at all) and rather than deleting on a
   * guess. A `0` from the document is the operator's "keep forever" and is the
   * ONE thing that legitimately skips the sweep.
   */
  private async pruneOpsLog(): Promise<void> {
    const log = this.eventsOpsLog
    if (log === null || log === undefined) return
    let windowMs = OPS_LOG_RETENTION_FALLBACK_MS
    try {
      const settings = await this.ctx.api.system.getLoggingSettings.query({})
      const days = settings.opsLogRetentionDays
      if (days === 0) return
      windowMs = days * 24 * 60 * 60_000
    } catch (err: unknown) {
      this.ctx.logger.debug('ops-log window unreadable — using the shipped fallback', {
        meta: { error: String(err), fallbackDays: 30 },
      })
    }
    await log.pruneBefore(Date.now() - windowMs)
  }

  private async pruneWindows(): Promise<PruneWindows> {
    // ONE store read, not one per key. `resolveGlobalStore` returns the whole
    // addon blob, and the four windows are four fields of it.
    //
    // This matters more than it looks: `settings-raw-mirror-wiring.spec.ts`
    // guards that a cold resolve costs at most one addon-store read, and the
    // first version of this method — four `this.state(...).get()` calls — took
    // it to four. That thread is synchronous (D447): an aggregate that reads it
    // once per digest is fine, four times is how a settings store starts
    // queueing behind itself.
    const store = await this.resolveGlobalStore()
    return resolvePruneWindows(
      Object.fromEntries(PRUNE_SETTING_KEYS.map((key) => [key, store[key]])),
    )
  }

  /** GLOBAL face-recognition master switch (`enabled` key). Schema +
   *  fallback derived from the face-settings source of truth. */
  // ── Orphan audit state (D61) ──────────────────────────────────────────
  /** The settings-store client, held so the audit can page a collection by
   *  NAME — its scope list is derived from the classification registry, not
   *  from a set of store instances. */
  /**
   * Call-site attribution for this addon's store reads (`store/read-census.ts`).
   *
   * Disarmed by default; armed for a bounded window through
   * `debug.storeCensus`. It exists because the engine-side profiler names a
   * TABLE and this addon has twenty-odd readers of the busiest ones — and
   * because picking the reader that LOOKS like the loop was tried, twice, and
   * named the wrong one both times.
   */
  private readonly readCensus = new StoreReadCensus()
  private settingsStore: SettingsStoreClient | null = null
  /**
   * Per-scope resume cursors, PERSISTED (D480).
   *
   * They used to live only here, and the docblock that used to be here argued
   * that persisting them "would be a durable record of a purely advisory
   * position". A position that resets to zero is not advisory: this addon
   * respawns several times a day and the sweep interval is six hours, so every
   * pass re-walked offsets 0–20 000 of a 532 384-row collection and stopped.
   * 96 % of the media collection — including 23 594 orphaned rows and
   * 9 714 MiB — was never examined, for ten days, while the log said
   * `stoppedBy=row-ceiling` every time. This field is now a mirror of
   * {@link sweepCursors}, loaded at the start of a pass and written at the end.
   */
  private orphanAuditCursors: ReadonlyMap<string, OrphanCursor> = new Map()
  /** Where {@link orphanAuditCursors} lives across a respawn. */
  private sweepCursors: SweepCursorStore | null = null
  /** Resume points for the debug-media reclaim, keyed `<scope>:<deviceId>`.
   *  In RAM like the audit's: the pass is resumable from zero at no cost
   *  beyond re-walking a head that is already empty. */
  private mediaReclaimCursors: ReadonlyMap<string, number> = new Map()
  /** Live state of the detached debug-media reclaim — see `reclaimDebugMedia`. */
  private mediaReclaimState: MediaReclaimJobState = { ...IDLE_MEDIA_RECLAIM }
  /** Live state of the detached operator orphan audit — see `runOrphanAuditNow`. */
  private orphanAuditState: OrphanAuditJobState = { ...IDLE_ORPHAN_AUDIT }
  /** Frozen-location leftover wipe (events/ on a drained HDD). Detached. */
  private discardJob: DiscardJob | null = null
  /** The narrow media-row forget's wiring (`storage.forgetMissingMedia`). */
  private mediaForgetDeps: MediaForgetDeps | null = null
  /**
   * The CLIP indexes' walks (D649), one resume cursor per index, kept in their
   * OWN field rather than in {@link orphanAuditCursors}: `runOrphanAudit`
   * returns a map built from ITS scopes and the caller assigns it wholesale, so
   * a key added afterwards is dropped on the next run — the walk would silently
   * restart at row 0 every six hours and never reach the tail of the index.
   * Persisted — see `SweepCursorStore`.
   */
  private orphanClipIndexCursors = new Map<string, number>()
  /** The `face-arcface` walk's resume offset. Its own field, never an entry in
   *  the scope map — see `SweepCursorStore`. */
  private orphanFaceVectorCursor = 0
  /** Re-entrancy guard — two whole-database scans must never overlap on the
   *  thread that also serves frames. */
  private orphanAuditRunning = false
  private orphanAuditTimer: ReturnType<typeof setInterval> | null = null
  /**
   * Five-minute long-term statistics — the tier this system did not have.
   * Global for every camera (no opt-in: a baseline nobody enables is the
   * failure mode `observe` mode was already in). See `analytics-history-producer.ts`.
   */
  private lts: AnalyticsHistoryProducer | null = null
  private ltsFlushTimer: ReturnType<typeof setInterval> | null = null

  /**
   * `scene-monitor` — the operator's latched boolean over a reference region.
   *
   * The STORE and the PROVIDER are built on every node, because scene CRUD is a
   * central-store surface an operator reaches from whichever node served their
   * UI (the `NcRuleStore` precedent). The ENGINE runs only on the designated
   * post-processing node, so a two-node cluster never double-encodes a crop or
   * double-fires a latch.
   *
   * Cross-node convergence is a periodic reload, not an event: D8 events are
   * droppable telemetry and a scene the evaluating node never learned about is
   * a scene that silently never runs.
   */
  private sceneProvider: SceneMonitorProvider | null = null
  private sceneEngine: SceneEngine | null = null
  private sceneReloadTimer: ReturnType<typeof setInterval> | null = null
  private siteCoordsCache: {
    value: { lat: number; lng: number } | null
    at: number
  } | null = null

  private _orphanAuditModeState: DurableState<OrphanAuditSettings['mode']> | null = null
  private get orphanAuditModeState(): DurableState<OrphanAuditSettings['mode']> {
    if (!this._orphanAuditModeState) {
      this._orphanAuditModeState = this.state<OrphanAuditSettings['mode']>(
        ORPHAN_AUDIT_MODE_SETTING,
        OrphanAuditModeSchema,
        ORPHAN_AUDIT_DEFAULTS.mode,
      )
    }
    return this._orphanAuditModeState
  }

  private _orphanAuditPageSizeState: DurableState<number> | null = null
  private get orphanAuditPageSizeState(): DurableState<number> {
    if (!this._orphanAuditPageSizeState) {
      this._orphanAuditPageSizeState = this.state<number>(
        ORPHAN_AUDIT_PAGE_SIZE_SETTING,
        OrphanAuditPageSizeSchema,
        ORPHAN_AUDIT_DEFAULTS.pageSize,
      )
    }
    return this._orphanAuditPageSizeState
  }

  private _orphanAuditIntervalState: DurableState<number> | null = null
  private get orphanAuditIntervalState(): DurableState<number> {
    if (!this._orphanAuditIntervalState) {
      this._orphanAuditIntervalState = this.state<number>(
        ORPHAN_AUDIT_INTERVAL_SETTING,
        OrphanAuditIntervalHoursSchema,
        ORPHAN_AUDIT_DEFAULTS.intervalHours,
      )
    }
    return this._orphanAuditIntervalState
  }

  private _faceGlobalEnabledState: DurableState<boolean> | null = null

  private get faceGlobalEnabledState(): DurableState<boolean> {
    if (!this._faceGlobalEnabledState) {
      this._faceGlobalEnabledState = this.state<boolean>(
        'enabled',
        FaceSettingsSchema.shape.enabled,
        FACE_DEFAULTS.enabled,
      )
    }
    return this._faceGlobalEnabledState
  }

  constructor() {
    super({})
  }

  protected async onInitialize(): Promise<AddonInitResult<NcActions>> {
    // Armed FIRST, above every gate: this addon's own boot has gone silent for
    // 5m13s on a live hub, and an inert (non-post-processing) node that freezes
    // is still a finding. Follows `detection-pipeline` and `recorder` exactly.
    this.stopStallMonitor = startEventLoopStallMonitor(this.ctx.logger)

    // Censused at the API object, not at the ~40 `api.settingsStore` reads
    // below: an instrument installed per call site is one that stops seeing the
    // next reader added. Disarmed it is a `get` trap and a comparison — see
    // `store/read-census.ts` for why the seam is permanent and the capture is
    // not.
    const rawApi = this.ctx.api
    if (!rawApi)
      throw new Error('pipeline-analytics requires ctx.api (device-manager + settings-store)')
    const api = censusApi(rawApi, this.readCensus)

    // Per-step boot timing. This addon's init once went SILENT for 5m13s on a
    // live hub (2026-08-15: spawned 15:50:34, first subscription 15:55:47)
    // and the captured log could not say which await owned the window — every
    // step now reports its own ms, so the next slow boot names its offender.
    const bootT0 = Date.now()
    const step = async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
      const t0 = Date.now()
      const out = await fn()
      this.ctx.logger.info('pipeline-analytics boot step', {
        meta: {
          step: name,
          ms: Date.now() - t0,
          sinceBootMs: Date.now() - bootT0,
        },
      })
      return out
    }

    // Declare typed collections up-front so the first insert doesn't race
    // with a CREATE TABLE. Idempotent.
    await step('declareCollections', () => this.declareCollections(api))
    // The alarm panel: a fixed integration and one device, both get-or-create.
    // ARMED, never awaited — see `armAlarmPanelDeclaration`. Best-effort was
    // always the intent; awaiting it made "best-effort" cost 61 s of the
    // capability graph's life at every boot.
    this.armAlarmPanelDeclaration(api)

    const logger = this.ctx.logger
    const storage = await step('resolveMediaStorage', () => this.resolveMediaStorage(logger))
    // Stores + detectors + sensor plumbing — constructed in the pre-S7 order.
    const stores = await step('buildStores', () => this.buildStores(api, logger, storage))

    // Frame-based event/track media: resolve the detection frame the detector
    // ran on (over tRPC via the runner's `getNativeCrop`, routed by
    // `handle.nodeId`) and write a crop + boxed full-frame. The runner method is
    // optional in the environment; when absent the fetch yields null and media
    // is best-effort (shm-ring removal 2026-07-16).
    const rawNodeId = this.ctx.kernel.localNodeId ?? this.ctx.id
    const ownNodeId = rawNodeId.includes('/') ? rawNodeId.split('/')[0]! : rawNodeId
    // Events-domain ops-log — SQLite-backed (declared above). Audits
    // footprint prunes + manual device-event deletes.
    const ledgerWiring = this.eventLedgerWiring()
    this.eventsOpsLog = new OpsLogStore({
      logger: logger.child('ops-log'),
      nodeId: ownNodeId,
      opsLedger: wireOpsLogLedger(ledgerWiring),
    })

    // The debug-note archive (D405) — where a note goes when a review clears
    // it off the track row. Not a track table and not on any age clock.
    this.debugNoteArchive = new DebugNoteArchiveStore({
      logger: logger.child('debug-note-archive'),
      archiveLedger: wireDebugNoteArchiveLedger(ledgerWiring),
    })

    // Promoted tracking-tape windows (D681) — history being labelled, bounded
    // by the promotion budget, never by age.
    this.tapeIndex = new TrackingTapeIndexStore({
      logger: logger.child('tracking-tapes'),
      tapeLedger: wireTrackingTapeLedger(ledgerWiring),
    })

    // The birth-decision ledger (D409) — one row per resolved birth verdict, so
    // "how often does a coasted frame decide a birth on 102" and "how late does
    // a track start" are answerable a WEEK later. `logs.query` holds under an
    // hour of fleet traffic and cannot answer either.
    this.birthDecisionLedger = new BirthDecisionLedgerStore({
      logger: logger.child('birth-decision-ledger'),
      birthLedger: wireBirthDecisionLedger(ledgerWiring),
    })

    // Ground-truth marks for the tracking bench (D681) — track relations and
    // purity, kept as provenance past track retention. Hub only, like the
    // debug-note archive next door.
    this.trackRelations = new TrackRelationsStore({
      logger: logger.child('track-relations'),
      relationsLedger: wireTrackRelationsLedger(ledgerWiring),
      purityLedger: wireTrackPurityLedger(ledgerWiring),
    })

    // Cluster post-processing node gate (standalone setting, no balancing): a
    // SINGLE designated node (default hub) runs all event/media/audio/motion
    // generation; every other node is fully inert (no bus subscriptions). This
    // is what eliminates the multi-node split-brain. The setting lives in the
    // centralized addon store so all nodes read the same value.
    {
      const designated = await step('postProcessingNodeState', () =>
        this.postProcessingNodeState.get(),
      )
      this.isPostProcessingNode = ownNodeId === designated
      if (!this.isPostProcessingNode) {
        logger.info('pipeline-analytics INERT on this node — post-processing assigned elsewhere', {
          meta: { ownNodeId, designatedNode: designated },
        })
      }
    }

    // Drain the two JSON vector columns into the vector indexes. ARMED, never
    // awaited: it is idempotent, every reader falls back to the JSON column
    // until its row is converted, and ~1,700 rows of round trips have no
    // business sitting in the boot path. Only the post-processing node runs it
    // — two nodes converting the same rows would race on the blanking write.
    if (this.isPostProcessingNode) {
      void this.convertLegacyEmbeddingColumns()
    }

    // Native-frame transport (S7): the `pipelineRunner.getNativeCrop` closure
    // bundle — full-frame, tiered keyFrame, native-strict subject crops and the
    // bounded display-crop fallback — built once in
    // `runtime/native-frame-transport.ts`.
    const transport = createNativeFrameTransport({
      api,
      ownNodeId,
      logger,
      noteCropOutcome: (deviceId, reason) =>
        this.failureReport.noteEnrichmentCrop(deviceId, reason),
    })
    // D422: every per-track best-frame consumer reads a PARKED parcel by
    // track. The order goes out in `buildSnapshotTargets`, the instant the
    // best-frame policy accepts a frame; the registry's offline verdict gates
    // both the order and the retrieval (D58).
    this.parkedFrames = createParkedFrameClient({
      api: api.pipelineRunner,
      logger: logger.child('ParkedFrames'),
      isNodeOffline: (nodeId) => this.nodeLiveness.isKnownOffline(nodeId, Date.now()),
    })
    // Share the crop extractor with the object-embedding path (best-object-crop).
    this.captureCrop = transport.captureCrop
    // OPERATOR-DEBUG crops. Built here because it needs both the transport (one
    // full frame per crop) and the media store, and nothing else. The frame is
    // capped at DEBUG_CROP_FETCH_MAX_WIDTH: a debug crop is a picture for a
    // person, and a 4K surface buys nothing a 1280 px one does not once the
    // window has been widened to a neighbourhood.
    // The raw closure, bound to a local name: the S4 grep-guard
    // (`native-fetch-guard.spec.ts`) counts raw invocations of
    // `getNativeFullFrameRgb` to find capture pressure that bypasses the
    // scheduler, and the
    // body of an executor the scheduler is already running is not that. The
    // `request` call below is the guard's actual subject, and it is right there.
    const fetchDebugFullFrame = transport.getNativeFullFrameRgb
    this.captureDebugCropFn = createDebugCropCapture({
      // THE gate, and the reason an unmarked fleet pays nothing: one lookup in
      // the resident map the frame path already holds.
      isDebugMarked: (trackId) => this.residents.isDebugMarked(trackId),
      // S4: ALL native capture pressure is scheduler-owned. `other` (priority 4)
      // so a diagnostic can never displace the track-media ladder, and the
      // coalesce key is (device, kind, track) so two decisions on ONE frame of
      // one track cost ONE fetch. `staleAfterMs` because a queued debug fetch
      // whose frame has aged out is worth nothing — the next decision will ask
      // again while the handle is young.
      fetchFrameRgb: async (handle, deviceId, trackId) => {
        const frame = await this.captureScheduler.request({
          deviceId,
          trackId,
          kind: 'other',
          coalesceKey: captureCoalesceKey(deviceId, 'other', trackId),
          staleAfterMs: DEBUG_CROP_FETCH_STALE_MS,
          exec: () => fetchDebugFullFrame(handle, DEBUG_CROP_FETCH_MAX_WIDTH),
        })
        return frame === null || frame === undefined
          ? null
          : { bytes: frame.data, width: frame.width, height: frame.height }
      },
      extractCropRaw: (data, w, h, box) => extractCropRaw(data, w, h, box),
      drawBoxedFrame: (data, w, h, boxes, options) =>
        drawBoxedFrame(data, w, h, boxes, options ?? {}),
      // Track-OWNED, so the crop ages out under the one sweep that owns the
      // track (`deleteForOwner('track', …)`) and can never become the orphan
      // D161 is about. `debugCrop` is multi-instance, so each crop slots at its
      // own frame timestamp rather than overwriting the last.
      putDebugCrop: (put) =>
        stores.mediaStore.put({
          deviceId: put.deviceId,
          ownerKind: 'track',
          ownerId: put.trackId,
          kind: 'debugCrop',
          timestamp: put.timestamp,
          data: put.data,
        }),
      logger: logger.child('DebugCrop'),
    })
    // S4 NOTE — these closures are handed over RAW (not scheduler-wrapped) on
    // purpose: every fetch the EventMediaDispatcher issues (display child
    // faceCrop/plateCrop, boxed timeline tiles, subject-crop variants) runs
    // INSIDE its `captureForFrame` batch, and that whole batch is dispatched
    // as ONE CaptureScheduler request (see the `deriveFrameDispatchKind`
    // request below in processFrame) — so the batch already holds a budget
    // slot; wrapping the inner fetches would double-count it against the
    // budget and could deadlock the lane against its own batch. The grep-guard
    // spec (`native-fetch-guard.spec.ts`) allow-lists exactly these calls.
    this.eventMediaDispatcher = new EventMediaDispatcher({
      getRemoteFrame: transport.getRemoteFrame,
      getNativeCropJpeg: transport.getNativeCropJpeg,
      getNativeFullFrameRgb: transport.getNativeFullFrameRgb,
      getNativeFullFrameJpeg: transport.getNativeFullFrameJpeg,
      // The best-shot `thumbnail` reads the track's PARKED slab (D422).
      getParkedSubjectSlab: (deviceId, trackId) =>
        this.mediaCapture.fetchParkedSubjectSlab(deviceId, trackId),
      mediaStore: stores.mediaStore,
      logger: logger.child('EventMediaDispatcher'),
      paintClass: createDisplayPalettePainter(
        () => readDisplayPalette(api),
        logger.child('DisplayPalette'),
      ).paint,
      // D276/B2: a native subject-crop miss is the other reason a track closes
      // tile-less — `thumbnail:native-miss` beside the scheduler's drop causes.
      onSubjectCropMiss: (deviceId, trackId, reason) =>
        this.residents.notePreviewCaptureMiss(deviceId, trackId, `thumbnail:${reason}`),
    })

    // Face/plate recognizers + the object-embedding store (pre-S7 order).
    this.buildRecognizers(api, logger, stores, transport)

    // Two-plane detail dispatcher + per-device caches/providers.
    this.buildDetailDispatcher(api, logger)
    const capProviders = this.buildAnalyticsProviders(api, logger)

    // Notification Center (P1 core, D-2): rules CRUD served from every
    // node (central store); evaluation + outbox drain gated to the
    // designated post-processing node — the same gate as the event
    // subscriptions, so hooks and drain can never run twice cluster-wide.
    await step('buildNotificationCenter', () => this.buildNotificationCenter(api, logger, stores))

    // Event-media data-plane: serve thumbnail JPEGs through the hub's port.
    await step('serveEventMediaDataPlane', () => this.serveEventMediaDataPlane())

    // Bus subscriptions (S7): the FULL topology — six processing subscriptions
    // gated to the designated post-processing node + the two lifecycle
    // subscriptions on every node — lives in `runtime/wire-subscriptions.ts`.
    // Handlers stay methods on this class.
    this.subscriptionUnsubs = wireSubscriptions({
      eventBus: this.ctx.eventBus,
      isPostProcessingNode: this.isPostProcessingNode,
      onInferenceResult: (data) => this.frameAdmission.handleInferenceResult(data),
      onAudioResult: (data) => this.handleAudioResult(data),
      onMotionAnalysis: (deviceId, data, timestampMs) =>
        this.handleMotionAnalysis(deviceId, data, timestampMs),
      onOnboardMotion: (deviceId, data, timestampMs) =>
        this.handleOnboardMotion(deviceId, data, timestampMs),
      onSensorStateChanged: (data, timestampMs) =>
        this.dispatchSensorStateChanged(data, timestampMs),
      onBindingsChanged: (data) => this.handleBindingsChangedEvent(data),
      onDeviceUnregistered: (deviceId) => this.handleDeviceUnregisteredEvent(deviceId),
      onClusterTopology: (nodes) => this.nodeLiveness.applySnapshot(nodes, Date.now()),
      onSystemEvent: (event) => this.notificationCenter?.onSystemEvent(event),
    })

    // Tracking tapes (D681): their OWN step, so a failed event-media plane can
    // no longer skip them (a skipped start used to read `recording`), and
    // AFTER the frame subscriptions, so a processor built while the start
    // awaits its storage reads is seeded into the next header. Never throws.
    await step('startTrackingTapes', () => this.startTrackingTapes(this.isPostProcessingNode))

    // Object/face embedding dispatcher — gated to the post-processing node so
    // there are no duplicate CLIP calls per camera.
    if (this.isPostProcessingNode) {
      await step('startEmbeddingDispatcher', () => this.startEmbeddingDispatcher(logger, transport))
    }

    await step('buildSceneMonitor', () => this.buildSceneMonitor(api, logger))

    this.startSweepTimers()

    this.ctx.logger.info('pipeline-analytics subscribers installed')

    const providers = await step('buildProviderRegistrations', () =>
      this.buildProviderRegistrations(stores, capProviders),
    )

    // Notification Center rule-bridge actions (nc.*) — hub-only, mirroring
    // model-studio. The viewer reaches these over `addons.custom` (addonId
    // `pipeline-analytics`); per-action auth + ownership is enforced inside the
    // handlers (`nc-actions.ts`). Agents serve no rule bridge (rule CRUD is a
    // hub-authoritative, central-store surface).
    const isHub = ownNodeId === 'hub'
    const ncHandlers = isHub ? this.buildNcActionHandlers(api) : undefined
    // Promoted-tape pins live on the hub's track store, and so does their
    // reconcile — whether or not this node records tapes (Task 12 fix, M2).
    if (isHub) this.reconcileTapePinsInBackground()
    this.mediaForgetDeps = {
      listLocations: async () => api.storage.listLocations.query({}),
      localNodeId: ownNodeId,
      store: api.settingsStore,
      logger: logger.child('MediaForget'),
    }
    this.discardJob = createDiscardJob({
      listLocations: async () => api.storage.listLocations.query({}),
      localNodeId: ownNodeId,
      store: api.settingsStore,
      retrainFrameLedger: wireRetrainFrameLedger(this.eventLedgerWiring()),
      deleteTrackEvents: async (trackId) => {
        await this.eventStore?.deleteByTrack(trackId)
      },
      // D683 (review H2): the track being wiped here can itself be a fusion
      // survivor — its alias rows have nowhere else to go.
      deleteTrackAliases: async (trackId) => {
        await this.trackAliasStore?.deleteByTracks([trackId])
      },
      now: () => Date.now(),
    })
    // ONE registration for the whole bridge — `nc.*`, `embedding.*` and now
    // `debug.*`. They share a gate that is really the Notification Center's:
    // this envelope is typed `AddonInitResult<NcActions>`, so a catalog without
    // the `nc.*` entries does not satisfy it, and `buildNcActionHandlers`
    // returning `undefined` therefore registers NOTHING. Named rather than
    // worked around: on a hub the NC is always built, and the alternative is a
    // second envelope type carried for a case that does not occur. If a hub ever
    // does boot without an NC, `debug.*` answers 404 and this is why.
    return {
      providers,
      ...(isHub && ncHandlers !== undefined
        ? {
            customActions: {
              ...ncActions,
              ...embeddingActions,
              ...debugActions,
              ...tapeActions,
              ...gtActions,
              ...orphanAuditActions,
              ...mediaReclaimActions,
              ...locationDiscardActions,
              ...mediaForgetActions,
              ...photoEnrollActions,
              ...faceRescoreActions,
              ...stillnessCalibrationActions,
            },
            actionHandlers: {
              ...ncHandlers,
              ...this.buildEmbeddingActionHandlers(),
              ...this.buildDebugActionHandlers(),
              ...this.buildTapeActionHandlers(),
              ...this.buildGtActionHandlers(),
              ...this.buildPhotoEnrollActionHandlers(),
              ...this.buildFaceRescoreActionHandlers(),
              ...this.buildStillnessCalibrationActionHandlers(),
            },
          }
        : {}),
    }
  }

  /**
   * Build the `nc.*` bridge handlers over the rule store, resolving the
   * caller-owned target set from the notifiers target catalog (a target is
   * owned when its open `config.ownerUserId` blob matches the caller). Returns
   * `undefined` when the Notification Center is absent (never built).
   */
  private buildNcActionHandlers(api: AnalyticsApi): NcActionHandlers | undefined {
    const center = this.notificationCenter
    if (center === null) return undefined
    return makeNcActionHandlers({
      ruleStore: center.ruleStore,
      ruleAiStore: center.ruleAiStore,
      // The picker's options for a rule's AI section. NARROWED here rather
      // than in the action, because this is the only layer that holds the raw
      // profile: a text-only profile would be REFUSED by the provider on a
      // vision call, so offering one is offering the fail-open path.
      listAiProfiles: async () => {
        const profiles = await api.llm.listProfiles.query({})
        return profiles
          .filter((profile) => profile.enabled && profile.supportsVision)
          .map((profile) => ({
            id: profile.id,
            name: profile.name,
            model: profile.model,
          }))
      },
      logger: this.ctx.logger.child('nc-actions'),
      snooze: {
        list: (userId, isAdmin) => center.snoozeStore.listVisibleTo(userId, isAdmin),
        create: (input, caller) => center.createSnooze(input, caller),
        cancel: (snoozeId, caller) => center.cancelSnooze(snoozeId, caller),
      },
      listCallerTargetIds: async (userId) => {
        const targets = await api.notificationOutput.listTargets.query({})
        return targets.filter((t) => t.config['ownerUserId'] === userId).map((t) => t.id)
      },
      // The save-time device-compatibility guard's ONE capability read
      // (`device-compat-guard.ts`, operator ruling 2026-10-01) — the SAME
      // call the cap-provider route (`buildProvider`, `notification-center/
      // index.ts`) makes, so the two save routes cannot drift.
      listDeviceIdsByCaps: (capNames) =>
        api.deviceManager.listDeviceIdsByCaps.query({ capNames: [...capNames] }),
      // A deleted rule writes no more mosaics, so the writer's bound will
      // never run for it again — its pictures leave with it (D480). `keep: 0`
      // through the SAME bound the write path uses, so both go through
      // `deleteConfirmed` and neither drops a row whose blob survived.
      dropRuleMosaics: async (ruleId) => {
        const mediaStore = this.mediaStore
        if (mediaStore === null) return
        await boundRuleMosaics(this.summaryMosaicPorts(mediaStore), {
          ruleId,
          // The rule is gone: age is irrelevant, every mosaic it owns goes.
          rule: { all: true },
        })
      },
      // The grouped-burst record — the data half of the timeline's group card.
      listTrackGroups: (query) => center.listTrackGroups(query),
      // The synthetic producer's ONE outside dependency: a photograph of the
      // camera, taken now. `force` is deliberately NOT set — a background
      // caller must never walk past a battery camera's sleep gate, and an
      // operator pressing Test is not a reason to wake a doorbell.
      injectTestEvent: (input) =>
        center.injectTestEvent(input, {
          getSnapshot: (deviceId) => api.snapshot.getSnapshot.query({ deviceId }),
        }),
      // A STATE-SUMMARY rule's test (D698): the summary built now, enqueued —
      // the injection above can never deliver for a rule that sends nothing
      // per event.
      testStateSummary: (rule) => center.testStateSummary(rule),
      timelapse: {
        store: center.timelapseStore,
        // THE recording authority — the same `RecordingConfig` camera-status
        // reads. A read that throws returns null, which the guard treats as
        // "cannot decide", never as "recording is on".
        getRecordingConfig: (deviceId) =>
          api.recordingArchive.getDeviceConfig.query({ deviceId }).catch(() => null),
        runNow: (input) => center.runTimelapseNow(input),
      },
      summary: {
        store: center.summaryStore,
        runNow: (input) => center.runSummaryNow(input),
      },
      calendarEvents: {
        store: center.calendarEventsStore,
      },
      // The Texts tab's whole server side. It writes the hub's centralized
      // settings store, so wiring it on every node that builds a centre is
      // correct — and the editor re-applies the result to THIS node's live
      // catalog, which is what makes a save visible in the next notification
      // rather than at the next reload tick.
      texts: center.textCatalogEditor,
      // Same live catalog `getTemplateCatalog`/`previewTemplate` render through
      // on the cap — the bridge preview must speak the hub's CURRENT words too.
      previewTexts: center.textCatalog,
      // Absent on a node whose artifact plane never came up — the two read
      // actions then refuse honestly rather than answering an empty library.
      ...(this.ncArtifactIndex !== null ? { artifacts: this.ncArtifactIndex } : {}),
      // Only the shelf's DELETE leg, read through a getter so a shelf that
      // comes up after the handlers are built is still reachable. A node with
      // no shelf drops the row and unlinks nothing — the file was never here.
      artifactShelf: { remove: async (id) => (await this.ncArtifactStore?.remove(id)) ?? false },
      // The live-status readers. The artefact LOOKUP is threaded from here
      // rather than held by the centre: the index belongs to this addon, and a
      // status that cannot reach it degrades to "no link", never to an error.
      // The alarm, for the viewer and the admin tab — the panel's own arm,
      // Arm anyway and disarm paths, behind the bridge's auth (D630).
      alarm: center.alarmActions(),
      // What the deleted-device / deleted-target prune did — the banner's source.
      listPrunes: () => center.listPrunes(),
      ruleStatus: {
        forRule: (rule) => center.ruleStatusFor(rule),
        forTimelapseRule: (rule) =>
          center.timelapseStatusFor(rule, async ({ ruleId, deviceId }) => {
            const index = this.ncArtifactIndex
            if (index === null) return null
            const page = await index.list(
              {
                kinds: ['timelapse'],
                ruleId,
                deviceIds: [deviceId],
                limit: 1,
                offset: 0,
              },
              // The visibility check already ran in the action, against the
              // RULE. Reading the index as an admin here answers about the
              // artefact of a rule the caller was just proved to own.
              { userId: '', isAdmin: true },
            )
            return page.artifacts[0] ?? null
          }),
      },
    })
  }

  // ── Boot builders (S7) — each called ONCE from onInitialize ─────────

  /**
   * Alarm-panel declaration and the join onto the notification centre — `boot/build-alarm-panel.ts`.
   * LAZY: `ctx` is not assigned when field initialisers run.
   */
  private alarmPanelBootInstance: BuildAlarmPanel | null = null

  private get alarmPanelBoot(): BuildAlarmPanel {
    this.alarmPanelBootInstance ??= new BuildAlarmPanel({
      ctx: () => this.ctx,
      shuttingDown: () => this.shuttingDown,
      alarmPanelConvergence: () => this.alarmPanelConvergence,
      setAlarmPanelConvergence: (value) => {
        this.alarmPanelConvergence = value
      },
      alarmPanelDevice: () => this.alarmPanelDevice,
      setAlarmPanelDevice: (value) => {
        this.alarmPanelDevice = value
      },
      notificationCenter: () => this.notificationCenter,
      alarmPanelWired: () => this.alarmPanelWired,
      setAlarmPanelWired: (value) => {
        this.alarmPanelWired = value
      },
    })
    return this.alarmPanelBootInstance
  }

  /** `build-alarm-panel.ts` — armAlarmPanelDeclaration. */
  private armAlarmPanelDeclaration(api: AnalyticsApi): void {
    return this.alarmPanelBoot.armAlarmPanelDeclaration(api)
  }

  /** `build-alarm-panel.ts` — wireAlarmPanel. */
  private wireAlarmPanel(center: NotificationCenter): void {
    return this.alarmPanelBoot.wireAlarmPanel(center)
  }

  /**
   * Move `faces.embedding` and `identity-samples.embedding` out of JSON text
   * and into their vector indexes — once, in place, idempotently.
   *
   * Not awaited by the boot path and not a schema migration: see
   * `embedding-json-conversion.ts` for why "converted" is a property of a row
   * rather than a version number. Every failure mode here is safe — a row whose
   * index write did not land keeps its array, and both readers fall back to it.
   */
  private async convertLegacyEmbeddingColumns(): Promise<void> {
    const faceStore = this.faceStore
    const identityStore = this.identityStore
    if (!faceStore || !identityStore) {
      this.ctx.logger.warn('embedding conversion skipped — the gallery stores are not up', {
        meta: {
          faceStore: faceStore !== null,
          identityStore: identityStore !== null,
        },
      })
      return
    }
    const deps: EmbeddingConversionDeps = {
      logger: this.ctx.logger.child('EmbeddingConversion'),
      breathe: () => new Promise<void>((resolve) => setImmediate(resolve)),
    }
    try {
      await convertJsonEmbeddings(faceStore.conversionSpec(), deps)
      await convertJsonEmbeddings(identityStore.conversionSpec(), deps)
    } catch (err) {
      // Never blocks anything and never retried in-process: the next boot runs
      // the same idempotent pass over whatever is left.
      this.ctx.logger.warn('embedding conversion pass failed', {
        meta: { error: String(err) },
      })
    }
  }

  /**
   * `ctx.records`, which every node's context carries (the kernel's addon
   * context factory and the hub's addon registry both set it). Typed optional
   * on `AddonContext`, so it is required HERE: a context without it is a
   * wiring fault and stops the boot with the addon's name, never a silent
   * fallback to another store.
   */
  private requireRecords(): RecordsAccess {
    const records = this.ctx.records
    if (records === undefined) throw new Error(`${this.ctx.id}: ctx.records is required`)
    return records
  }

  private eventLedgerWiring(): EventLedgerWiringDeps {
    return { records: this.requireRecords() }
  }

  private localOwnNodeId(): string {
    const raw = this.ctx.kernel.localNodeId ?? this.ctx.id
    return raw.includes('/') ? raw.split('/')[0]! : raw
  }

  /**
   * Record-kind and collection declarations — `boot/declare-collections.ts`.
   * LAZY: `ctx` is not assigned when field initialisers run.
   */
  private collectionsBootInstance: DeclareCollections | null = null

  private get collectionsBoot(): DeclareCollections {
    this.collectionsBootInstance ??= new DeclareCollections({
      settingsStore: () => this.settingsStore,
      setSettingsStore: (value) => {
        this.settingsStore = value
      },
      localOwnNodeId: () => this.localOwnNodeId(),
      requireRecords: () => this.requireRecords(),
      faceRescoreState: () => this.faceRescoreState,
      setFaceRescoreState: (value) => {
        this.faceRescoreState = value
      },
      ctx: () => this.ctx,
      sweepCursors: () => this.sweepCursors,
      setSweepCursors: (value) => {
        this.sweepCursors = value
      },
    })
    return this.collectionsBootInstance
  }

  /** `declare-collections.ts` — declareCollections. */
  private async declareCollections(api: AnalyticsApi): Promise<void> {
    return this.collectionsBoot.declareCollections(api)
  }

  /**
   * Event-media storage root — `boot/resolve-media-storage.ts`.
   * LAZY: `ctx` is not assigned when field initialisers run.
   */
  private mediaStorageBootInstance: ResolveMediaStorage | null = null

  private get mediaStorageBoot(): ResolveMediaStorage {
    this.mediaStorageBootInstance ??= new ResolveMediaStorage({
      ctx: () => this.ctx,
      mediaLocationStorage: () => this.mediaLocationStorage,
      setMediaLocationStorage: (value) => {
        this.mediaLocationStorage = value
      },
    })
    return this.mediaStorageBootInstance
  }

  /** `resolve-media-storage.ts` — resolveMediaStorage. */
  private async resolveMediaStorage(logger: IScopedLogger): Promise<LocationAwareMediaBlobStorage> {
    return this.mediaStorageBoot.resolveMediaStorage(logger)
  }

  /**
   * Store construction — `boot/build-stores.ts` and `boot/build-stores-events.ts`.
   * LAZY: `ctx` is not assigned when field initialisers run.
   */
  private storesBootInstance: BuildStores | null = null

  private get storesBoot(): BuildStores {
    this.storesBootInstance ??= new BuildStores({
      mediaStore: () => this.mediaStore,
      setMediaStore: (value) => {
        this.mediaStore = value
      },
      mediaOccupancyUnattributedLogged: () => this.mediaOccupancyUnattributedLogged,
      setMediaOccupancyUnattributedLogged: (value) => {
        this.mediaOccupancyUnattributedLogged = value
      },
      ctx: () => this.ctx,
      eventMediaWriteLocator: () => this.eventMediaWriteLocator,
      setEventMediaWriteLocator: (value) => {
        this.eventMediaWriteLocator = value
      },
      requireRecords: () => this.requireRecords(),
      frameState: () => this.frameState,
      notificationCenter: () => this.notificationCenter,
      trackStore: () => this.trackStore,
      setTrackStore: (value) => {
        this.trackStore = value
      },
      trackAliasStore: () => this.trackAliasStore,
      setTrackAliasStore: (value) => {
        this.trackAliasStore = value
      },
      eventLedgerWiring: () => this.eventLedgerWiring(),
      aliasResolveFailureLogger: () => this.aliasResolveFailureLogger,
      setAliasResolveFailureLogger: (value) => {
        this.aliasResolveFailureLogger = value
      },
      stationaryRegistry: () => this.stationaryRegistry,
      setStationaryRegistry: (value) => {
        this.stationaryRegistry = value
      },
      stationarySettingsFromCache: (deviceId) => this.stationarySettingsFromCache(deviceId),
      releaseStationaryKeyFrame: (entry) => this.releaseStationaryKeyFrame(entry),
      frameAdmission: () => this.frameAdmission,
      packageDropDetector: () => this.packageDropDetector,
      setPackageDropDetector: (value) => {
        this.packageDropDetector = value
      },
      confirmPackage: (input) => this.confirmPackageDelivery(input),
      stationaryEvidence: () => this.stationaryEvidence,
      setStationaryEvidence: (value) => {
        this.stationaryEvidence = value
      },
      phantomCells: () => this.phantomCells,
      setPhantomCells: (value) => {
        this.phantomCells = value
      },
      packageBackground: () => this.packageBackground,
      setPackageBackground: (value) => {
        this.packageBackground = value
      },
      mediaWriteGate: () => this.mediaWriteGate,
      eventMediaLocationDoorbellUnsub: () => this.eventMediaLocationDoorbellUnsub,
      setEventMediaLocationDoorbellUnsub: (value) => {
        this.eventMediaLocationDoorbellUnsub = value
      },
      mediaLocationStorage: () => this.mediaLocationStorage,
      retrainFrames: () => this.retrainFrames,
      setRetrainFrames: (value) => {
        this.retrainFrames = value
      },
      retrainAnnotations: () => this.retrainAnnotations,
      setRetrainAnnotations: (value) => {
        this.retrainAnnotations = value
      },
      retrainCollectionStore: () => this.retrainCollectionStore,
      setRetrainCollectionStore: (value) => {
        this.retrainCollectionStore = value
      },
      retrain: () => this.retrain,
      setRetrain: (value) => {
        this.retrain = value
      },
      pinnedFfmpeg: () => this.pinnedFfmpeg,
      retrainCollections: () => this.retrainCollections,
      setRetrainCollections: (value) => {
        this.retrainCollections = value
      },
      retrainLlmAssist: () => this.retrainLlmAssist,
      setRetrainLlmAssist: (value) => {
        this.retrainLlmAssist = value
      },
      mediaRelocate: () => this.mediaRelocate,
      setMediaRelocate: (value) => {
        this.mediaRelocate = value
      },
      eventsOpsLog: () => this.eventsOpsLog,
      refreshDeviceAlertSettings: () => this.refreshDeviceAlertSettings(),
      lts: () => this.lts,
      setLts: (value) => {
        this.lts = value
      },
      eventStore: () => this.eventStore,
      setEventStore: (value) => {
        this.eventStore = value
      },
      motionEpisodes: () => this.motionEpisodes,
      setMotionEpisodes: (value) => {
        this.motionEpisodes = value
      },
      insertMotionEpisodeRow: (deviceId, timestamp, regionData) =>
        this.insertMotionEpisodeRow(deviceId, timestamp, regionData),
      closeMotionEpisodeRow: (input) => this.closeMotionEpisodeRow(input),
      onMotionEpisodeEdge: (input) => this.onMotionEpisodeEdge(input),
      onMotionEpisodeTick: (input) => this.onMotionEpisodeTick(input),
      sensorEventStore: () => this.sensorEventStore,
      setSensorEventStore: (value) => {
        this.sensorEventStore = value
      },
      resolveDeviceZones: (deviceId) => this.resolveDeviceZones(deviceId),
      resolveDevicePackageRules: (deviceId) => this.resolveDevicePackageRules(deviceId),
      resolveDevicePackageDropSettings: (deviceId) =>
        this.resolveDevicePackageDropSettings(deviceId),
      resolveDeviceTrackingSettings: (deviceId) => this.resolveDeviceTrackingSettings(deviceId),
      linkedCamerasCache: () => this.linkedCamerasCache,
      setLinkedCamerasCache: (value) => {
        this.linkedCamerasCache = value
      },
      syntheticTracks: () => this.syntheticTracks,
      setSyntheticTracks: (value) => {
        this.syntheticTracks = value
      },
      motionEventSnapshots: () => this.motionEventSnapshots,
      setMotionEventSnapshots: (value) => {
        this.motionEventSnapshots = value
      },
      audioMarkers: () => this.audioMarkers,
      setAudioMarkers: (value) => {
        this.audioMarkers = value
      },
      isMotionActive: (deviceId, atMs, quietMs) => this.isMotionActive(deviceId, atMs, quietMs),
      identityStore: () => this.identityStore,
      setIdentityStore: (value) => {
        this.identityStore = value
      },
      faceStore: () => this.faceStore,
      setFaceStore: (value) => {
        this.faceStore = value
      },
      plateStore: () => this.plateStore,
      setPlateStore: (value) => {
        this.plateStore = value
      },
    })
    return this.storesBootInstance
  }

  /** `build-stores-events.ts` — mediaOccupancy. */
  private async mediaOccupancy(
    locationIds: readonly string[],
  ): Promise<readonly StorageOccupancyReport[]> {
    return this.storesBoot.mediaOccupancy(locationIds)
  }

  /** One line per process: this repeats on every occupancy refresh otherwise. */
  private mediaOccupancyUnattributedLogged = false

  /** `build-stores-events.ts` — buildStores. */
  private async buildStores(
    api: AnalyticsApi,
    logger: IScopedLogger,
    storage: MediaBlobStorage,
  ): Promise<AnalyticsStores> {
    return this.storesBoot.buildStores(api, logger, storage)
  }

  /**
   * Face and plate recognizers — `boot/build-recognizers.ts`.
   * LAZY: `ctx` is not assigned when field initialisers run.
   */
  private recognizersBootInstance: BuildRecognizers | null = null

  private get recognizersBoot(): BuildRecognizers {
    this.recognizersBootInstance ??= new BuildRecognizers({
      captureDisplayCropFn: () => this.captureDisplayCropFn,
      setCaptureDisplayCropFn: (value) => {
        this.captureDisplayCropFn = value
      },
      faceRecognizer: () => this.faceRecognizer,
      setFaceRecognizer: (value) => {
        this.faceRecognizer = value
      },
      tapeRecorder: () => this.tapeRecorder,
      noteVerdictOnTracker: () => this.noteVerdictOnTracker,
      ctx: () => this.ctx,
      captureScheduler: () => this.captureScheduler,
      trackStore: () => this.trackStore,
      eventStore: () => this.eventStore,
      residents: () => this.residents,
      emitFaceGalleryChanged: (payload) => this.emitFaceGalleryChanged(payload),
      semanticBestShot: () => this.semanticBestShot,
      mediaCapture: () => this.mediaCapture,
      parkedFrames: () => this.parkedFrames,
      nodeLiveness: () => this.nodeLiveness,
      faceSourceStats: () => this.faceSourceStats,
      plateRecognizer: () => this.plateRecognizer,
      setPlateRecognizer: (value) => {
        this.plateRecognizer = value
      },
      failureReport: () => this.failureReport,
      emitPlateGalleryChanged: (payload) => this.emitPlateGalleryChanged(payload),
      objectEmbeddingStore: () => this.objectEmbeddingStore,
      setObjectEmbeddingStore: (value) => {
        this.objectEmbeddingStore = value
      },
    })
    return this.recognizersBootInstance
  }

  /** `build-recognizers.ts` — buildRecognizers. */
  private buildRecognizers(
    api: AnalyticsApi,
    logger: IScopedLogger,
    stores: AnalyticsStores,
    transport: NativeFrameTransport,
  ): void {
    return this.recognizersBoot.buildRecognizers(api, logger, stores, transport)
  }

  /**
   * Two-plane detail dispatcher — `boot/build-detail-dispatcher.ts`.
   * LAZY: `ctx` is not assigned when field initialisers run.
   */
  private detailDispatcherBootInstance: BuildDetailDispatcher | null = null

  private get detailDispatcherBoot(): BuildDetailDispatcher {
    this.detailDispatcherBootInstance ??= new BuildDetailDispatcher({
      detailDispatcher: () => this.detailDispatcher,
      setDetailDispatcher: (value) => {
        this.detailDispatcher = value
      },
      detailRoute: () => this.detailRoute,
      mediaCapture: () => this.mediaCapture,
      captureCrop: () => this.captureCrop,
      setCaptureCrop: (value) => {
        this.captureCrop = value
      },
      trackStore: () => this.trackStore,
    })
    return this.detailDispatcherBootInstance
  }

  /** `build-detail-dispatcher.ts` — buildDetailDispatcher. */
  private buildDetailDispatcher(api: AnalyticsApi, logger: IScopedLogger): void {
    return this.detailDispatcherBoot.buildDetailDispatcher(api, logger)
  }

  /**
   * Binding cache and the zone/audio cap providers — `boot/build-analytics-providers.ts`.
   * LAZY: `ctx` is not assigned when field initialisers run.
   */
  private analyticsProvidersBootInstance: BuildAnalyticsProviders | null = null

  private get analyticsProvidersBoot(): BuildAnalyticsProviders {
    this.analyticsProvidersBootInstance ??= new BuildAnalyticsProviders({
      bindingCache: () => this.bindingCache,
      setBindingCache: (value) => {
        this.bindingCache = value
      },
      detectionCoverage: () => this.detectionCoverage,
      setDetectionCoverage: (value) => {
        this.detectionCoverage = value
      },
      lts: () => this.lts,
      ctx: () => this.ctx,
      stationaryRegistry: () => this.stationaryRegistry,
      resolveDeviceZones: (deviceId) => this.resolveDeviceZones(deviceId),
      resolveDeviceTrackingSettings: (deviceId) => this.resolveDeviceTrackingSettings(deviceId),
      notificationCenter: () => this.notificationCenter,
      zoneAnalytics: () => this.zoneAnalytics,
      setZoneAnalytics: (value) => {
        this.zoneAnalytics = value
      },
      readDeviceBlob: (deviceId) => this.readDeviceBlob(deviceId),
      audioMetrics: () => this.audioMetrics,
      setAudioMetrics: (value) => {
        this.audioMetrics = value
      },
    })
    return this.analyticsProvidersBootInstance
  }

  /** `build-analytics-providers.ts` — buildAnalyticsProviders. */
  private buildAnalyticsProviders(api: AnalyticsApi, logger: IScopedLogger): AnalyticsCapProviders {
    return this.analyticsProvidersBoot.buildAnalyticsProviders(api, logger)
  }

  /**
   * Notification centre construction — `boot/build-notification-center.ts`.
   * LAZY: `ctx` is not assigned when field initialisers run.
   */
  private notificationCenterBootInstance: BuildNotificationCenter | null = null

  private get notificationCenterBoot(): BuildNotificationCenter {
    this.notificationCenterBootInstance ??= new BuildNotificationCenter({
      ctxIfReady: () => this.ctxIfReady,
      ctx: () => this.ctx,
      notificationCenter: () => this.notificationCenter,
      setNotificationCenter: (value) => {
        this.notificationCenter = value
      },
      pruneWindows: () => this.pruneWindows(),
      frameState: () => this.frameState,
      faceRecognizer: () => this.faceRecognizer,
      trackAliasStore: () => this.trackAliasStore,
      cutNotificationRecordedClip: (req) => this.cutNotificationRecordedClip(req),
      deviceAlertSettingsMirror: () => this.deviceAlertSettingsMirror,
      detectionCoverage: () => this.detectionCoverage,
      deviceZones: () => this.deviceZones,
      ncArtifactPlane: () => this.ncArtifactPlane,
      ncActionMintUrl: () => this.ncActionMintUrl,
      sceneProvider: () => this.sceneProvider,
      zoneAnalytics: () => this.zoneAnalytics,
      renderEventMedia: (req) => this.renderEventMedia(req),
      ncEndpoints: () => this.ncEndpoints(),
      aliasResolveFailureLogger: () => this.aliasResolveFailureLogger,
      isPostProcessingNode: () => this.isPostProcessingNode,
      buildTimelapsePorts: (api, stores) => this.buildTimelapsePorts(api, stores),
      buildSummaryPorts: (api, stores) => this.buildSummaryPorts(api, stores),
      wireAlarmPanel: (center) => this.wireAlarmPanel(center),
      serveNcActionPlane: (center) => this.serveNcActionPlane(center),
    })
    return this.notificationCenterBootInstance
  }

  /** `build-notification-center.ts` — buildNotificationCenter. */
  private async buildNotificationCenter(
    api: AnalyticsApi,
    logger: IScopedLogger,
    stores: AnalyticsStores,
  ): Promise<void> {
    return this.notificationCenterBoot.buildNotificationCenter(api, logger, stores)
  }

  /**
   * Notification-centre summary, mosaic and timelapse ports — `boot/build-notification-ports.ts`.
   * LAZY: `ctx` is not assigned when field initialisers run.
   */
  private notificationPortsBootInstance: BuildNotificationPorts | null = null

  private get notificationPortsBoot(): BuildNotificationPorts {
    this.notificationPortsBootInstance ??= new BuildNotificationPorts({
      resolveDeviceDetectionSensitivitySettings: (deviceId) =>
        this.resolveDeviceDetectionSensitivitySettings(deviceId),
      frameState: () => this.frameState,
      pruneWindows: () => this.pruneWindows(),
      ncArtifactPlane: () => this.ncArtifactPlane,
      ctx: () => this.ctx,
      pinnedFfmpeg: () => this.pinnedFfmpeg,
    })
    return this.notificationPortsBootInstance
  }

  /** `build-notification-ports.ts` — buildSummaryPorts. */
  private buildSummaryPorts(api: AnalyticsApi, stores: AnalyticsStores): NcSummaryPorts {
    return this.notificationPortsBoot.buildSummaryPorts(api, stores)
  }

  /** `build-notification-ports.ts` — summaryMosaicPorts. */
  private summaryMosaicPorts(mediaStore: MediaStore): SummaryMosaicPorts {
    return this.notificationPortsBoot.summaryMosaicPorts(mediaStore)
  }

  /** `build-notification-ports.ts` — buildTimelapsePorts. */
  private buildTimelapsePorts(api: AnalyticsApi, stores: AnalyticsStores): NcTimelapseRenderPorts {
    return this.notificationPortsBoot.buildTimelapsePorts(api, stores)
  }

  /** Event-media data-plane: serve thumbnail JPEGs at
   *  `/addon/<addonId>/event-media/m/<mediaId>` (one row) or
   *  `/addon/<addonId>/event-media/o/<ownerType>/<ownerId>` (best media OF an
   *  owner) through the hub's port — see `event-media-handler.ts` (D482).
   *  Mirror the recorder playback pattern: try/warn, store handle for dispose.
   *
   *  `authenticated`, not `admin` — see `data-plane-access.ts` for the rule and
   *  the reason it changed: `getTrackMedia` / `getEventMedia` are declared
   *  `access: 'view'` and return the SAME stored blob base64 over tRPC, so the
   *  admin gate protected nothing and cost every non-admin session its tiles. */
  private async serveEventMediaDataPlane(): Promise<void> {
    try {
      const handler = createEventMediaHandler({
        getMedia: async (address, variant, preferKind) => {
          try {
            return await this.readMediaByAddress(address, variant, preferKind)
          } catch (err: unknown) {
            this.ctx.logger.warn('event-media resolve failed', {
              meta: { address, error: errMsg(err) },
            })
            throw err
          }
        },
      })
      this.eventMediaDataPlane =
        (await this.ctx.dataPlane?.serve({
          prefix: 'event-media',
          access: planeAccess('event-media'),
          // An events share link may fetch its thumbnails here; the
          // handler refuses any blob whose camera is outside the scope the hub
          // puts in `x-camstack-share-devices` (EVENTS-EMBED.md §7).
          share: ['events-view'],
          handler,
        })) ?? null
      this.eventMediaBaseUrl =
        this.eventMediaDataPlane !== null ? `/addon/${this.ctx.id}/event-media` : null
      await this.serveNcArtifactPlane()
      await this.serveTrainingExportPlane()
      await this.serveRetrainExportPlane()
      await this.serveRetrainFramePlane()
      await this.serveDebugExportPlane()
      await this.serveTapeExportPlane()
      // The ACCESS LEVEL is on the line. It is the one property of this plane
      // that is invisible from outside — a 200 for an admin looks identical
      // whichever level is registered — and it is the property that silently
      // drifted out of step with the `view`-level cap serving the same bytes.
      this.ctx.logger.info('event-media data-plane served', {
        meta: {
          baseUrl: this.eventMediaBaseUrl ?? '(no dataPlane facility)',
          access: planeAccess('event-media'),
        },
      })
    } catch (err: unknown) {
      this.ctx.logger.warn('event-media data-plane failed to serve', {
        meta: { error: errMsg(err) },
      })
    }
  }

  /**
   * The training-export data plane. Separate listener, admin-only (the level
   * is declared in `data-plane-access.ts`) — marking a track is a viewer-level
   * curation act (D81), but walking off with every stored frame behind the
   * marked set is not.
   */
  private async serveTrainingExportPlane(): Promise<void> {
    try {
      const handler = createTrainingExportHandler({
        buildPlan: (deviceIds) => this.buildTrainingExportPlan(deviceIds),
        readBlob: async (mediaId) => {
          const file = await (this.mediaStore?.getBytesById(mediaId) ?? Promise.resolve(null))
          return file === null ? null : file.bytes
        },
        logger: this.ctx.logger,
        now: () => Date.now(),
      })
      this.trainingExportDataPlane =
        (await this.ctx.dataPlane?.serve({
          prefix: TRAINING_EXPORT_PREFIX,
          access: planeAccess('training-export'),
          handler,
        })) ?? null
    } catch (err: unknown) {
      this.ctx.logger.warn('training-export data-plane failed to serve', {
        meta: { error: errMsg(err) },
      })
    }
  }

  /**
   * Plan the training export — INDEX READS ONLY. No blob is touched here, which
   * is what lets `getTrainingExportSummary` answer "how big is this" for the
   * cost of a few KB per track instead of the gigabytes the answer is about.
   *
   * An empty `deviceIds` means every device that has tracks, resolved from the
   * track store rather than from the device manager: a camera that was removed
   * can still own marked tracks, and refusing to export them because the device
   * is gone would lose exactly the material an operator kept on purpose.
   */
  private async buildTrainingExportPlan(deviceIds: readonly number[]): Promise<TrainingExportPlan> {
    const trackStore = this.trackStore
    const mediaStore = this.mediaStore
    const eventStore = this.eventStore
    if (!trackStore || !mediaStore) {
      throw new Error('training export: analytics stores unavailable')
    }
    const devices = deviceIds.length > 0 ? deviceIds : await trackStore.listDeviceIds()
    return buildTrainingExportPlan(
      {
        listMarkedTracks: (deviceId, limit) => trackStore.listStaging(deviceId, limit),
        listMediaInfo: async (ownerKind, ownerId, deviceId) => {
          if (!isMediaOwnerKind(ownerKind)) return []
          return mediaStore.listInfoByOwner(ownerKind, ownerId, deviceId)
        },
        listEventIdsForTracks: async (trackIds) => {
          if (!eventStore || trackIds.length === 0) return []
          const events = await eventStore.queryObjectByTrackIds(trackIds)
          // `eventId` here becomes a media OWNER id and an archive path
          // component (`events/<id>`), so it stays a string (D474) —
          // stringifying a rowid is lossless and widening the plan's contract
          // would push the same choice onto the manifest and the archive.
          // `recordAt` is the event's own timestamp — the generation stamp
          // every object media writer writes (D694).
          return events.flatMap((e) =>
            e.trackId === undefined
              ? []
              : [{ eventId: String(e.id), trackId: e.trackId, recordAt: e.timestamp }],
          )
        },
        now: () => Date.now(),
      },
      { deviceIds: devices, maxTracks: TRAINING_EXPORT_MAX_TRACKS },
    )
  }

  /**
   * Estimate the training export without producing it — the cheap question
   * (D56's discipline, applied to a pass that runs no inference at all).
   */
  async getTrainingExportSummary(input: { deviceIds?: number[] }): Promise<TrainingExportSummary> {
    const plan = await this.buildTrainingExportPlan(input.deviceIds ?? [])
    this.ctx.logger.info('training export summary', {
      meta: {
        tracks: plan.trackCount,
        files: plan.fileCount,
        bytes: plan.byteCount,
        truncated: plan.truncated,
      },
    })
    return {
      generatedAt: plan.generatedAt,
      trackCount: plan.trackCount,
      fileCount: plan.fileCount,
      byteCount: plan.byteCount,
      truncated: plan.truncated,
      devices: plan.totals,
    }
  }

  /** Where to stream the dataset from. The bytes never come through the cap. */
  async getTrainingExportUrl(input: { deviceIds?: number[] }): Promise<{ url: string }> {
    if (this.trainingExportDataPlane === null) {
      throw new Error('training export: data plane unavailable on this node')
    }
    const ids = input.deviceIds ?? []
    const query = ids.length > 0 ? `?deviceIds=${ids.join(',')}` : ''
    return { url: `/addon/${this.ctx.id}/${TRAINING_EXPORT_PREFIX}${query}` }
  }

  // ── Retrain curation (the retrain page) ─────────────────────────────────
  //
  // Eleven thin delegations. The bodies live in `retrain/retrain-service.ts`
  // for the reason `track-flags.ts` does: the decisions worth testing (the copy
  // ordering, the assist plan, the lifecycle preconditions) are decidable from
  // injected contracts, and a test that had to boot this class to reach them
  // would not have been written.

  private requireRetrain(): RetrainService {
    const retrain = this.retrain
    if (retrain === null) throw new Error('retrain: analytics stores unavailable')
    return retrain
  }

  async listRetrainStaging(input: {
    deviceIds?: number[]
    limit?: number
  }): Promise<readonly RetrainTrack[]> {
    return this.requireRetrain().listStaging({
      ...(input.deviceIds !== undefined ? { deviceIds: input.deviceIds } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    })
  }

  async listRetrainCorpusPage(input: RetrainCorpusFilter): Promise<RetrainCorpusPage> {
    return this.requireRetrain().listCorpusPage(input)
  }

  async getRetrainCorpusKpi(_input: Record<string, never>): Promise<RetrainCorpusKpi> {
    return this.requireRetrain().getCorpusKpi()
  }

  async listRetrainFrames(input: { trackId: string }): Promise<RetrainFrameList> {
    return this.requireRetrain().listFrames(input.trackId)
  }

  async selectRetrainFrames(input: SelectRetrainFramesInput): Promise<RetrainFrameSelection> {
    return this.requireRetrain().selectFrames(input)
  }

  async deselectRetrainFrame(input: {
    deviceId: number
    trackId?: string
    frameId: string
  }): Promise<{ removed: boolean; removedAnnotations: number }> {
    return this.requireRetrain().deselectFrame(input)
  }

  async getRetrainFrameImage(input: {
    frameId: string
  }): Promise<{ base64: string; width: number; height: number }> {
    return this.requireRetrain().getFrameImage(input.frameId)
  }

  async proposeRetrainAnnotations(input: {
    deviceId: number
    trackId?: string
    frameId: string
    subject:
      | { kind: 'package'; zone?: NativeCropBbox }
      | { kind: 'objects'; modelId: string; minScore?: number }
    nodeId?: string
  }): Promise<RetrainAssistResult> {
    const subject: AssistSubject =
      input.subject.kind === 'package'
        ? { kind: 'package', zone: input.subject.zone ?? null }
        : {
            kind: 'objects',
            modelId: input.subject.modelId,
            minScore: input.subject.minScore ?? DEFAULT_ASSIST_MIN_SCORE,
          }
    return this.requireRetrain().propose({
      deviceId: input.deviceId,
      ...(input.trackId !== undefined ? { trackId: input.trackId } : {}),
      frameId: input.frameId,
      subject,
      ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
    })
  }

  async listRetrainAnnotations(input: {
    trackId?: string
    frameIds?: string[]
  }): Promise<readonly RetrainAnnotation[]> {
    return this.requireRetrain().listAnnotations(input)
  }

  async saveRetrainAnnotations(input: {
    deviceId: number
    trackId?: string
    frameId: string
    annotations: RetrainAnnotationDraft[]
    expectedRevision?: number
    dismissed?: RetrainDismissed[]
  }): Promise<readonly RetrainAnnotation[]> {
    return this.requireRetrain().saveAnnotations(input)
  }

  async backfillRetrainOrigins(input: {
    deviceId: number
    trackId?: string
    frameId: string
    expectedRevision?: number
    origins: { annotationId: string; origin: RetrainOrigin }[]
  }): Promise<{ updated: number; skipped: number; revision: number }> {
    return this.requireRetrain().backfillOrigins(input)
  }

  async completeRetrainTrack(input: {
    deviceId: number
    trackId: string
  }): Promise<RetrainTransitionResult> {
    return this.requireRetrain().complete(input)
  }

  async restageRetrainTrack(input: {
    deviceId: number
    trackId: string
  }): Promise<RetrainTransitionResult> {
    return this.requireRetrain().restage(input)
  }

  /** Where to stream the ANNOTATED dataset from. Bytes never cross the cap. */
  async getRetrainExportUrl(
    input: RetrainExportFilter & { layout?: RetrainExportLayout },
  ): Promise<{ url: string }> {
    if (this.retrainExportDataPlane === null) {
      throw new Error('retrain export: data plane unavailable on this node')
    }
    const { layout, ...filter } = input
    const query = retrainExportQuery({ filter, layout: layout ?? 'frames' })
    return { url: `/addon/${this.ctx.id}/${RETRAIN_EXPORT_PREFIX}${query}` }
  }

  async setRetrainFrameComplete(input: {
    deviceId: number
    trackId?: string
    frameId: string
    complete: boolean
  }): Promise<RetrainWireFrame> {
    return this.requireRetrain().setFrameComplete(input)
  }

  // ── AI-vision pre-annotation ────────────────────────────────────
  // Thin delegations; the body is `retrain/retrain-llm-service.ts`.

  private requireRetrainLlmAssist(): RetrainLlmAssistService {
    const service = this.retrainLlmAssist
    if (service === null) throw new Error('retrain AI assist: analytics stores unavailable')
    return service
  }

  async listRetrainAssistProfiles(
    _input: Record<string, never>,
  ): Promise<readonly RetrainAssistProfile[]> {
    return this.requireRetrainLlmAssist().listProfiles()
  }

  async proposeRetrainAnnotationsWithLlm(input: {
    deviceId: number
    trackId?: string
    frameId: string
    profileId: string
    classes: RetrainMacroClass[]
    boxes: Array<{
      ref: string
      bbox: NativeCropBbox
      macroClass: RetrainMacroClass
      label?: string
    }>
    allowCloud: boolean
  }): Promise<RetrainLlmAssistResult> {
    return this.requireRetrainLlmAssist().propose(input)
  }

  // ── Named training collections ──────────────────────────────────
  // Thin delegations; the bodies are `retrain/retrain-collection-service.ts`.

  private requireRetrainCollections(): RetrainCollectionService {
    const service = this.retrainCollections
    if (service === null) throw new Error('retrain collections: analytics stores unavailable')
    return service
  }

  async createRetrainCollection(input: {
    name: string
  }): Promise<RetrainWireCollectionCreateResult> {
    return this.requireRetrainCollections().create(input)
  }

  async listRetrainCollections(
    _input: Record<string, never>,
  ): Promise<readonly RetrainWireCollection[]> {
    return this.requireRetrainCollections().list()
  }

  /**
   * Live training selection → frame ids + stats (index reads only). Refuses an
   * unknown collection id or an empty match after the work-state rule.
   */
  async resolveRetrainTrainingCorpus(
    input: RetrainTrainingCorpusSelection,
  ): Promise<RetrainTrainingCorpusResolveResult> {
    const collections = await this.requireRetrainCollections().list()
    const known = new Set(collections.map((c) => c.id))
    for (const id of input.collectionIds) {
      if (!known.has(id)) {
        return {
          kind: 'refused',
          reason: 'unknown-collection',
          detail: `collection "${id}" does not exist`,
        }
      }
    }
    const filter = exportFilterForTrainingCorpus(input)
    const plan = await this.buildRetrainExportPlan({ filter, layout: 'frames' })
    const frames = plan.manifest.frames.filter((frame) =>
      keepTrainingCorpusFrame(frame, input.workState),
    )
    if (frames.length === 0) {
      return {
        kind: 'refused',
        reason: 'no-frames',
        detail: 'no frames match the selected collections and work-state rule',
      }
    }
    const manifest = { ...plan.manifest, frames }
    return {
      kind: 'resolved',
      frameIds: frames.map((f) => f.frameId).toSorted(),
      stats: datasetStats(manifest),
      annotationHash: datasetAnnotationHash(frames),
      layout: 'frames',
    }
  }

  async renameRetrainCollection(input: {
    id: string
    name: string
  }): Promise<RetrainWireCollectionRenameResult> {
    return this.requireRetrainCollections().rename(input)
  }

  async deleteRetrainCollection(input: {
    id: string
  }): Promise<{ deleted: boolean; removedFrames: number }> {
    return this.requireRetrainCollections().delete(input)
  }

  async addRetrainFrameFromRecording(input: {
    collectionId: string
    deviceId: number
    epochMs: number
  }): Promise<AddRetrainFrameFromRecordingResult> {
    return this.requireRetrainCollections().addFrameFromRecording(input)
  }

  async addRetrainFramesToCollection(input: {
    collectionId: string
    frameIds: string[]
  }): Promise<{ added: number; alreadyMember: number; unknownFrameIds: readonly string[] }> {
    return this.requireRetrainCollections().addFrames(input)
  }

  async removeRetrainFrameFromCollection(input: {
    collectionId: string
    frameId: string
  }): Promise<{ removed: boolean; deletedFrame: boolean }> {
    return this.requireRetrainCollections().removeFrame(input)
  }

  async listRetrainCollectionFrames(input: {
    collectionId: string
  }): Promise<readonly RetrainWireFrame[]> {
    return this.requireRetrainCollections().listFrames(input)
  }

  /**
   * Stream the annotated archive into ONE HTTP request to `target` — the
   * training upload. Same bytes as the download; never on the hub's disk.
   */
  async writeRetrainArchive(input: {
    filter: RetrainExportFilter
    layout: RetrainExportLayout
    target: RetrainArchiveTarget
  }): Promise<RetrainArchiveResult> {
    const frameStore = this.retrainFrames
    if (frameStore === null) throw new Error('retrain export: analytics stores unavailable')
    const plan = await this.buildRetrainExportPlan({ filter: input.filter, layout: input.layout })
    const upload = openRetrainUploadSink(input.target)
    const host = new URL(input.target.url).host
    try {
      const stats = await writeRetrainArchiveTo({
        plan,
        readFrame: (frame) => frameStore.readFrame(frame),
        cutCrop: this.retrainCropCutter(),
        sink: upload.sink,
        markExported: (frameIds, batchId) => this.markRetrainExported(frameIds, batchId),
        logger: this.ctx.logger,
        now: () => Date.now(),
      })
      const status = await upload.finish()
      this.ctx.logger.info('retrain archive uploaded', {
        meta: { host, status, ...stats, layout: input.layout },
      })
      return { ...stats, status }
    } catch (err: unknown) {
      upload.abort(errMsg(err))
      // The target host only — its URL and headers may carry a credential.
      this.ctx.logger.warn('retrain archive upload failed', {
        meta: { host, error: errMsg(err) },
      })
      throw err
    }
  }

  /**
   * The same archive behind a one-shot `ctx.peerBytes` ticket (D805): the
   * caller (a training provider, same host) dials it at once and streams it
   * into its cloud. The plan is built now, so an empty or unknown selection
   * fails here rather than as an empty body; the bytes and their sha256 are
   * the reader's to measure.
   */
  async offerRetrainArchive(input: {
    filter: RetrainExportFilter
    layout: RetrainExportLayout
  }): Promise<{ ticket: PeerBytesTicket; frames: number; annotations: number }> {
    const frameStore = this.retrainFrames
    if (frameStore === null) throw new Error('retrain export: analytics stores unavailable')
    const peerBytes = this.ctx.peerBytes
    if (peerBytes === undefined) throw new Error('retrain archive offer: no peer-bytes facility')
    const plan = await this.buildRetrainExportPlan({ filter: input.filter, layout: input.layout })
    if (plan.frames.length === 0)
      throw new Error('retrain archive offer: the selection holds no frame')
    const logger = this.ctx.logger
    const offered = await peerBytes.offer({
      label: 'retrain-archive',
      handler: (req, res) =>
        serveRetrainArchive(req, res, async (sink) => {
          await writeRetrainArchiveTo({
            plan,
            readFrame: (frame) => frameStore.readFrame(frame),
            cutCrop: this.retrainCropCutter(),
            sink,
            markExported: (frameIds, batchId) => this.markRetrainExported(frameIds, batchId),
            logger,
            now: () => Date.now(),
          })
        }).catch((err: unknown) => {
          logger.warn('retrain archive offer failed mid-body', { meta: { error: errMsg(err) } })
        }),
    })
    if (offered.kind === 'refused') {
      throw new Error(`retrain archive offer refused: ${offered.code} — ${offered.detail}`)
    }
    logger.info('retrain archive offered', {
      meta: { frames: plan.frames.length, layout: input.layout },
    })
    return {
      ticket: offered.ticket,
      frames: plan.frames.length,
      annotations: plan.manifest.annotationCount,
    }
  }

  /**
   * The store seam the `debug.*` actions and the debug bundle both read through.
   *
   * Index reads, plus ONE existence probe per media row — never a blob. The
   * probe is the only thing here that touches the filesystem, and it earns the
   * trip: every index read in this file counts rows the two serving reads
   * (`listByOwner`, `getByKey`) silently drop when the bytes are unreachable,
   * so without it the tab reports tiles the viewer draws blank. The bytes
   * themselves are still fetched one at a time, by key, by the export handler,
   * so a bundle of a hundred tracks never holds more than one file.
   */
  private buildDebugServiceDeps(): DebugServiceDeps {
    const trackStore = this.trackStore
    const mediaStore = this.mediaStore
    const eventStore = this.eventStore
    if (trackStore === null || mediaStore === null || eventStore === null) {
      throw new Error('debug: analytics stores unavailable')
    }
    return {
      listDeviceIds: () => trackStore.listDeviceIds(),
      listDebugTracks: (deviceId, limit) => trackStore.listDebug(deviceId, limit),
      getTrack: (trackId) => trackStore.getPersistedByTrackId(trackId),
      listMediaInfo: (ownerKind, ownerId) => mediaStore.listInfoByOwner(ownerKind, ownerId),
      listEvents: (trackId) => eventStore.queryObjectByTrackIds([trackId]),
      trackThumbnailProvenance: (trackId) => mediaStore.trackThumbnailProvenance(trackId),
      probeMediaBlob: (key) => mediaStore.blobServable(key),
      logger: this.ctx.logger.child('debug'),
      now: () => Date.now(),
    }
  }

  /** The `debug.*` bridge handlers — hub-only, like `nc.*` and `embedding.*`. */
  private buildDebugActionHandlers(): Record<string, (input: never) => Promise<unknown>> {
    return {
      'debug.listTracks': async (input: DebugListTracksInput) =>
        listDebugTracks(this.buildDebugServiceDeps(), input),
      'debug.analyze': async (input: DebugAnalyzeInput) =>
        analyzeDebugTracks(this.buildDebugServiceDeps(), input),
      /**
       * The stationary registry + evidence ledger as they stand right now.
       *
       * Pure reads off two RAM mirrors — no store query, no media, nothing that
       * can fail — so it is safe to ask on a live hub while a camera is
       * flooding. A camera the registry has never seen is simply absent from
       * `devices`, which is the honest answer and not an empty entry list.
       */
      'debug.stationary': async (input: DebugStationaryInput): Promise<DebugStationaryOutput> => {
        const registry = this.stationaryRegistry
        const evidence = this.stationaryEvidence
        if (registry === null) return { devices: [] }
        const limit = input.candidateLimit ?? DEFAULT_STATIONARY_CANDIDATES
        const asked = input.deviceIds
        const known = new Set<number>([
          ...registry.deviceIds(),
          ...(evidence?.deviceIdsWithCandidates() ?? []),
        ])
        const deviceIds =
          asked === undefined || asked.length === 0
            ? [...known].toSorted((a, b) => a - b)
            : asked.filter((id) => known.has(id))
        return {
          devices: deviceIds.map((deviceId) => {
            const observedAt = registry.observedAt(deviceId)
            const sessionOpenedAt = registry.sessionOpenedAt(deviceId)
            const all = evidence?.candidatesFor(deviceId) ?? []
            // Best-evidenced first: the row an audit is looking for is the one
            // that should have promoted, not the one that happened to be made
            // first.
            const ordered = [...all].toSorted((a, b) => b.agreed - a.agreed)
            return {
              deviceId,
              ...(sessionOpenedAt !== undefined ? { sessionOpenedAt } : {}),
              ...(observedAt !== undefined ? { observedAt } : {}),
              entries: registry.list(deviceId).map((e) => ({
                id: e.id,
                className: e.className,
                bbox: { ...e.bbox },
                becameStationaryAt: e.becameStationaryAt,
                lastConfirmedAt: e.lastConfirmedAt,
                ...(e.sourceTrackId !== undefined ? { sourceTrackId: e.sourceTrackId } : {}),
                ...(e.label !== undefined ? { label: e.label } : {}),
              })),
              strikes: registry.strikesFor(deviceId).map((s) => ({
                entryId: s.entryId,
                armedAt: s.armedAt,
                absentReads: s.absentReads,
                observedAgeMs: observedAt === undefined ? 0 : observedAt - s.armedAt,
              })),
              candidates: ordered.slice(0, limit).map((row) => ({
                key: row.key,
                className: row.className,
                anchor: { ...row.anchor },
                agreed: row.agreed,
                seen: row.seen,
                // Neither N nor M (D547) — how much of what this candidate saw
                // had not decided yet. The answer to "why is it slow".
                undecided: row.undecided,
                ratio: row.seen > 0 ? row.agreed / row.seen : 0,
                spanMs: row.lastAgreedAt - row.firstAgreedAt,
                firstAgreedAt: row.firstAgreedAt,
                lastAgreedAt: row.lastAgreedAt,
                updatedAt: row.updatedAt,
                ...(row.sourceTrackId !== undefined ? { sourceTrackId: row.sourceTrackId } : {}),
              })),
              candidatesTruncated: ordered.length > limit,
              candidateTotal: ordered.length,
              bindings: (evidence?.bindingsFor(deviceId) ?? []).map((b) => ({
                trackId: b.trackId,
                candidateKey: b.candidateKey,
              })),
            }
          }),
        }
      },
      'debug.lts': async (input: DebugLtsInput): Promise<DebugLtsOutput> => {
        const lts = this.lts
        if (lts === null) return { rows: [], open: [] }
        const rows = await lts.readDebug(input)
        return {
          rows: rows.map(withMean),
          open: lts.openBucketsForDebug().map(withMean),
        }
      },
      /**
       * Arm or read the store-read call-site census.
       *
       * `armMs: 0` (or omitted) READS the window that already ran — that is how
       * a measurement is collected after its window closed, and re-arming to
       * read would throw away exactly the numbers being asked for.
       *
       * The result is also logged, because a measurement that exists only in an
       * HTTP response is a measurement that is gone when the next session asks
       * what happened.
       */
      'debug.storeCensus': async (
        input: DebugStoreCensusInput,
      ): Promise<DebugStoreCensusOutput> => {
        const limit = input.limit ?? MAX_CENSUS_SITES
        if (input.armMs !== undefined && input.armMs > 0) {
          this.readCensus.arm(input.armMs)
          return { armed: true, elapsedMs: 0, sites: 0, calls: 0, rows: [] }
        }
        const rows = logCensus(this.readCensus, this.ctx.logger.child('Census'), limit)
        const elapsedMs = this.readCensus.elapsedMs()
        return {
          armed: this.readCensus.armed,
          elapsedMs,
          sites: rows.length,
          calls: rows.reduce((acc, r) => acc + r.calls, 0),
          rows: rows.slice(0, limit).map((r) => ({
            op: r.op,
            site: r.site,
            calls: r.calls,
            perMin: elapsedMs === 0 ? 0 : Math.round((r.calls * 60_000) / elapsedMs),
            rows: r.rows,
          })),
        }
      },
    }
  }

  /**
   * The debug-export data plane. Its own listener, for the same reason the
   * retrain export has one: a client asking for the debug bundle must never be
   * able to receive the annotated dataset by changing a query parameter.
   */
  private async serveDebugExportPlane(): Promise<void> {
    try {
      const handler = createDebugExportHandler({
        buildPlan: (deviceIds) => buildDebugBundlePlan(this.buildDebugServiceDeps(), deviceIds),
        readMedia: async (key) => {
          const file = await this.mediaStore?.getBytesById(key)
          return file === null || file === undefined ? null : file.bytes
        },
        logger: this.ctx.logger.child('debug-export'),
        now: () => Date.now(),
      })
      this.debugExportDataPlane =
        (await this.ctx.dataPlane?.serve({
          prefix: DEBUG_EXPORT_PREFIX,
          access: planeAccess('debug-export'),
          handler,
        })) ?? null
    } catch (err: unknown) {
      this.ctx.logger.warn('debug-export data-plane failed to serve', {
        meta: { error: errMsg(err) },
      })
    }
  }

  /**
   * The tracking-tape export plane (D681). Its own listener, like
   * debug-export: a client asking for a promoted tape's bundle must never be
   * able to receive a different one by changing a query parameter.
   */
  private async serveTapeExportPlane(): Promise<void> {
    try {
      const handler = createTapeExportHandler({
        peekTape: (tapeId) => this.peekTapeBundle(tapeId),
        loadBundle: (tapeId) => this.loadTapeBundle(tapeId),
        logger: this.ctx.logger.child('tape-export'),
        now: () => Date.now(),
      })
      this.tapeExportDataPlane =
        (await this.ctx.dataPlane?.serve({
          prefix: TAPE_EXPORT_PREFIX,
          access: planeAccess('tape-export'),
          handler,
        })) ?? null
    } catch (err: unknown) {
      this.ctx.logger.warn('tape-export data-plane failed to serve', {
        meta: { error: errMsg(err) },
      })
    }
  }

  /**
   * `HEAD`'s answer (fix round 1, M3): the index row alone, no tape read and
   * no ground-truth query. `unavailable` (not `unknown`) when the row exists
   * but this node has no shelf/ground-truth store to serve it from (M1).
   */
  private async peekTapeBundle(tapeId: string): Promise<TapeBundlePeek> {
    const row = await this.tapeIndex?.get(tapeId)
    if (row === null || row === undefined) return { kind: 'unknown' }
    if (this.tapeShelf === null || this.trackRelations === null) {
      return { kind: 'unavailable', reason: this.tapeShelfAbsence(), deviceId: row.deviceId }
    }
    return { kind: 'ok', deviceId: row.deviceId, scenario: row.scenario }
  }

  /**
   * Build the export bundle for one promoted tape (D681) — the manifest, the
   * operator's ground truth rebased onto it, and the tape itself.
   *
   * Three ways this can fail to return `ok`, and they are named distinctly
   * (fix round 1, M1/M2): `unknown` — no such row; `unavailable` — the row
   * exists but this node cannot serve ANY promoted tape (no shelf, no
   * ground-truth store); `read-failed` — this node CAN serve tapes, but the
   * read of this ONE failed (most often a release/delete racing the
   * download — ENOENT). The first names no camera; the other two do.
   */
  private async loadTapeBundle(tapeId: string): Promise<TapeBundleLoad> {
    const row = await this.tapeIndex?.get(tapeId)
    if (row === null || row === undefined) return { kind: 'unknown' }
    const shelf = this.tapeShelf
    const relations = this.trackRelations
    if (shelf === null || relations === null) {
      return { kind: 'unavailable', reason: this.tapeShelfAbsence(), deviceId: row.deviceId }
    }
    try {
      const tape = await readTapeFile(shelf.promotedFile(row.deviceId, row.id), {
        logger: this.ctx.logger,
        deviceId: row.deviceId,
      })
      const gt = exportGroundTruth({
        liveTrackIds: row.trackIds,
        fromMs: row.fromMs,
        toMs: row.toMs,
        reviewed: row.reviewed,
        relations: await relations.relationsForDevice(row.deviceId, MAX_TRACK_RELATIONS),
        purities: await relations.puritiesForDevice(row.deviceId, MAX_TRACK_PURITIES),
      })
      return {
        kind: 'ok',
        parts: {
          manifest: {
            tapeId: row.id,
            deviceId: row.deviceId,
            scenario: row.scenario,
            lighting: row.lighting,
            durationMs: row.toMs - row.fromMs,
            frames: row.frames,
            skips: row.skips,
            gaps: row.gaps,
            reviewed: row.reviewed,
            recordedDate: new Date(row.fromMs).toISOString().slice(0, 10),
          },
          gt,
          tape,
        },
      }
    } catch (err: unknown) {
      return { kind: 'read-failed', reason: errMsg(err), deviceId: row.deviceId }
    }
  }

  /**
   * The retrain-export data plane. Separate listener from the training export
   * next door: different archive, different contents, and a client asking for
   * one must never be able to receive the other by changing a query parameter.
   */
  private async serveRetrainExportPlane(): Promise<void> {
    try {
      const handler = createRetrainExportHandler({
        buildPlan: (request) => this.buildRetrainExportPlan(request),
        readFrame: (frame) =>
          this.retrainFrames?.readFrame(frame) ?? Promise.resolve<Buffer | null>(null),
        cutCrop: this.retrainCropCutter(),
        markExported: (frameIds, batchId) => this.markRetrainExported(frameIds, batchId),
        logger: this.ctx.logger,
        now: () => Date.now(),
      })
      this.retrainExportDataPlane =
        (await this.ctx.dataPlane?.serve({
          prefix: RETRAIN_EXPORT_PREFIX,
          access: planeAccess('retrain-export'),
          handler,
        })) ?? null
    } catch (err: unknown) {
      this.ctx.logger.warn('retrain-export data-plane failed to serve', {
        meta: { error: errMsg(err) },
      })
    }
  }

  /**
   * The retrain-frame data plane: one copied frame's JPEG (`?size=thumb|full`).
   * Admin-only like the cap that used to serve it as base64 (D613).
   */
  private async serveRetrainFramePlane(): Promise<void> {
    try {
      const handler = createRetrainFrameHandler({
        readFrame: async (frameId) => {
          const frames = this.retrainFrames
          if (frames === null) return null
          const frame = await frames.get(frameId)
          return frame === null ? null : frames.readFrame(frame)
        },
        resize: resizeRetrainJpeg,
        logger: this.ctx.logger,
      })
      this.retrainFrameDataPlane =
        (await this.ctx.dataPlane?.serve({
          prefix: RETRAIN_FRAME_PREFIX,
          access: planeAccess('retrain-frame'),
          handler,
        })) ?? null
    } catch (err: unknown) {
      this.ctx.logger.warn('retrain-frame data-plane failed to serve', {
        meta: { error: errMsg(err) },
      })
    }
  }

  /**
   * Plan the annotated export — INDEX READS ONLY, no blob touched.
   *
   * The zone used for the `zoneCrop` derivation is the bounding box of the
   * camera's declared zones. It is recorded in the manifest per frame
   * (`zoneUsed`) rather than assumed by the consumer: a derived box whose
   * reference rectangle is implicit is a box nobody can check. A camera with no
   * zones simply has no `zoneCrop` geometry — absent, never a clamped guess.
   */
  private async buildRetrainExportPlan(request: RetrainExportRequest): Promise<RetrainExportPlan> {
    const frameStore = this.retrainFrames
    const annotationStore = this.retrainAnnotations
    const trackStore = this.trackStore
    if (!frameStore || !annotationStore || !trackStore) {
      throw new Error('retrain export: analytics stores unavailable')
    }
    const deviceIds = request.filter.deviceIds ?? []
    // A camera can contribute only recording stills and have no track at all,
    // so the dataset's own cameras join the track store's.
    const devices =
      deviceIds.length > 0
        ? deviceIds
        : [
            ...new Set([
              ...(await trackStore.listDeviceIds()),
              ...(await frameStore.listDeviceIds()),
            ]),
          ]
    const candidates = new Map<string, RetrainFrameRow>()
    const annotationsByFrame = new Map<string, readonly RetrainAnnotationRow[]>()
    const zones = new Map<number, NativeCropBbox | null>()
    for (const deviceId of devices) {
      zones.set(deviceId, await this.retrainZoneForDevice(deviceId))
    }
    // Corpus-aligned filters (workState / collectionId / classes) need every
    // copy so the archive matches the Frames grid membership; the legacy path
    // keeps "annotated + complete hard negatives" for an empty filter.
    if (exportNeedsFullCorpus(request.filter)) {
      const corpus =
        deviceIds.length > 0
          ? (await frameStore.listAll()).filter((f) => deviceIds.includes(f.deviceId))
          : await frameStore.listAll()
      for (const frame of corpus) candidates.set(frame.frameId, frame)
      for (const annotation of await annotationStore.listByFrames([...candidates.keys()])) {
        const existing = annotationsByFrame.get(annotation.mediaKey) ?? []
        annotationsByFrame.set(annotation.mediaKey, [...existing, annotation])
      }
    } else {
      for (const deviceId of devices) {
        for (const annotation of await annotationStore.listByDevice(deviceId, RETRAIN_EXPORT_MAX)) {
          const existing = annotationsByFrame.get(annotation.mediaKey) ?? []
          annotationsByFrame.set(annotation.mediaKey, [...existing, annotation])
        }
        // A complete frame with no box is a hard negative: it is in the dataset
        // although the annotation table has no row for it.
        for (const frame of await frameStore.listCompleteByDevice(deviceId, RETRAIN_EXPORT_MAX)) {
          candidates.set(frame.frameId, frame)
        }
      }
      for (const frameId of annotationsByFrame.keys()) {
        if (candidates.has(frameId)) continue
        const frame = await frameStore.get(frameId)
        if (frame !== null) candidates.set(frameId, frame)
      }
    }
    const collectionsByFrame =
      (await this.retrainCollectionStore?.collectionsOf([...candidates.keys()])) ??
      new Map<string, readonly string[]>()
    const frames = filterRetrainExport(
      [...candidates.values()],
      annotationsByFrame,
      request.filter,
      collectionsByFrame,
    )
    const manifest = buildRetrainManifest({
      frames,
      annotationsByFrame,
      collectionsByFrame,
      zoneForDevice: (deviceId) => zones.get(deviceId) ?? null,
      generatedAt: Date.now(),
      batchId: randomUUID(),
      layout: request.layout,
      coordinates: await this.siteCoordinates(),
    })
    return { manifest, frames }
  }

  /** Stamp the batch on the annotations of the frames an archive carried. */
  private async markRetrainExported(frameIds: readonly string[], batchId: string): Promise<void> {
    const store = this.retrainAnnotations
    if (!store || frameIds.length === 0) return
    const ids: string[] = []
    for (const frameId of frameIds) {
      for (const a of await store.listByFrame(frameId)) ids.push(a.id)
    }
    await store.markExported(ids, batchId)
  }

  /** The `crops` layout's cutter, with the convention the manifest records. */
  private retrainCropCutter(): RetrainCropCutter {
    return (frameBytes, frame, annotation) =>
      cutRetrainCrop({
        frameBytes,
        frameWidth: frame.width,
        frameHeight: frame.height,
        bbox: annotation.bbox,
        convention: RETRAIN_CROP_CONVENTION,
        maxSide: RETRAIN_CROP_MAX_SIDE,
      }).catch((err: unknown) => {
        this.ctx.logger.warn('retrain crop could not be cut', {
          tags: { deviceId: frame.deviceId },
          meta: { frameId: frame.frameId, annotationId: annotation.id, error: errMsg(err) },
        })
        return null
      })
  }

  /** Bounding box of a camera's zones, or null when it declares none. */
  private async retrainZoneForDevice(deviceId: number): Promise<NativeCropBbox | null> {
    try {
      const zones = await this.ctx.api.zones.listZones.query({ deviceId })
      const points = zones.flatMap((z) => z.polygon ?? [])
      if (points.length < 3) return null
      const xs = points.map((p) => p.x)
      const ys = points.map((p) => p.y)
      const x = Math.min(...xs)
      const y = Math.min(...ys)
      const w = Math.max(...xs) - x
      const h = Math.max(...ys) - y
      return w > 0 && h > 0 ? { x, y, w, h } : null
    } catch (err: unknown) {
      // A zone read that failed is NOT "this camera has no zones": it produces
      // no zoneCrop geometry, and says so.
      this.ctx.logger.warn('retrain export: zone lookup failed — no zoneCrop geometry', {
        tags: { deviceId },
        meta: { deviceId, error: errMsg(err) },
      })
      return null
    }
  }

  /** Object/face embedding dispatcher — migrated from the retired
   *  enrichment-engine addon. It subscribes to DetectionResult, resolves the
   *  frame via the runner transport, crops each qualifying detection, and
   *  calls the embedding-encoder cap (cross-process — the cap resolves the
   *  collection internally). Gated to the post-processing node (call site) so
   *  there are no duplicate CLIP calls per camera. Master toggle read from
   *  settings. */
  private async startEmbeddingDispatcher(
    logger: IScopedLogger,
    transport: NativeFrameTransport,
  ): Promise<void> {
    const embeddingEnabled = await this.embeddingEnabledState.get()
    if (!embeddingEnabled) {
      logger.info('EmbeddingDispatcher disabled via settings (embeddingEnabled=false)')
      return
    }
    const encoderClient: EmbeddingEncoderClient = {
      // `new Uint8Array(crop)` normalizes the crop to an ArrayBuffer-backed
      // view (the cap input's exact type) — a negligible copy at the
      // UDS-serialization boundary the call crosses anyway.
      encode: (crop, width, height) =>
        this.ctx.api.embeddingEncoder.encode.query({
          crop: new Uint8Array(crop),
          width,
          height,
        }),
      getInfo: () => this.ctx.api.embeddingEncoder.getInfo.query(),
    }
    this.embeddingDispatcher = new EmbeddingDispatcher({
      config: { ...DEFAULT_EMBEDDING_CONFIG, enabled: true },
      encoder: encoderClient,
      eventBus: this.ctx.eventBus,
      logger: logger.child('EmbeddingDispatcher'),
      // S4: the dispatcher's per-event full-frame fetch counts against the
      // device's capture budget — kind 'embed' (lowest rung, must never
      // displace track media), stale-dropped once the handle's retained
      // surface is gone. No coalesceKey: each event resolves a DIFFERENT
      // frame (joining would hand back another frame's pixels). A `null`
      // (drop) is the dispatcher's existing "frame recycled" skip path.
      getRemoteFrame: (handle, embedDeviceId) =>
        this.captureScheduler.request({
          deviceId: embedDeviceId,
          kind: 'embed',
          staleAfterMs: ENRICHMENT_CAPTURE_STALE_MS,
          exec: () => transport.getRemoteFrame(handle),
        }),
    })
    await this.embeddingDispatcher.start()
  }

  /** `DeviceBindingsChanged` handler — subscription topology lives in
   *  `runtime/wire-subscriptions.ts`. */
  private handleBindingsChangedEvent(data: BindingsChangedData): void {
    this.bindingCache?.onBindingsChanged(data)
    // Keep the alarm-coverage mirror current per-device (no fleet sweep) — the
    // notification centre's directory reads it instead of calling
    // `getAllBindings` every 30 s tick.
    void this.detectionCoverage?.onBindingsChanged(data)
    if (data.capName === 'pipeline-analytics' && data.reason === 'wrapper-deactivated') {
      // Operator turned us off for this device — drop its in-RAM
      // tracks (no history persist since nothing was completed).
      this.trackStore?.clearDevice(data.deviceId)
      // S1 leak fix: close EVERY resident track of the device (was: only
      // the closure-state map — the other per-track containers leaked).
      this.residents.closeDevice(data.deviceId)
      // Wrapper turned off — forget the device's parked objects from RAM
      // (keep persisted rows: a re-activation reloads them from the store).
      this.stationaryRegistry?.forgetDevice(data.deviceId)
      this.frameState.packageStillness.forgetDevice(data.deviceId)
      this.packageDropDetector?.forgetDevice(data.deviceId)
      this.packageScene?.forget(data.deviceId)
      this.frameState.lastNonPackageActivityAt.delete(data.deviceId)
      this.frameState.packageCollectors.forgetDevice(data.deviceId)
      this.frameState.packageOversizeLogAt.delete(data.deviceId)
      this.frameState.packageLookDropReasons.delete(data.deviceId)
      this.overlayState.clearDevice(data.deviceId)
      this.frameState.overlaySynthesisWarnAt.delete(data.deviceId)
      this.forgetDeviceProcessors(data.deviceId)
      this.frameState.levelStateByDevice.delete(data.deviceId)
      this.frameState.audioConfirmByDevice.delete(data.deviceId)
      // S6: one call drops the device's entry from EVERY settings cache
      // (was: eight hand-listed per-map deletes).
      this.settingsCaches.clearDevice(data.deviceId)
      // The shared raw mirror is not part of the hub (it backs every kind's
      // cold-miss loader, not a resolved kind itself) — drop it too so a
      // re-activation doesn't warm the eight caches from a stale blob.
      this.rawDeviceBlobMirror.invalidate(data.deviceId)
    }
  }

  /** `DeviceUnregistered` handler — subscription topology lives in
   *  `runtime/wire-subscriptions.ts`. */
  private handleDeviceUnregisteredEvent(deviceId: number): void {
    this.trackStore?.clearDevice(deviceId)
    // S1 leak fix: close EVERY resident track of the device (was: only
    // the closure-state map — the other per-track containers leaked).
    this.residents.closeDevice(deviceId)
    this.stationaryRegistry?.forgetDevice(deviceId)
    this.frameState.packageStillness.forgetDevice(deviceId)
    this.packageDropDetector?.forgetDevice(deviceId)
    this.packageScene?.forget(deviceId)
    this.frameState.lastNonPackageActivityAt.delete(deviceId)
    this.frameState.packageCollectors.forgetDevice(deviceId)
    this.frameState.packageOversizeLogAt.delete(deviceId)
    this.frameState.packageLookDropReasons.delete(deviceId)
    this.overlayState.clearDevice(deviceId)
    this.frameState.overlaySynthesisWarnAt.delete(deviceId)
    this.forgetDeviceProcessors(deviceId)
    this.frameState.levelStateByDevice.delete(deviceId)
    this.frameState.motionOnsets.forgetDevice(deviceId)
    this.frameState.audioConfirmByDevice.delete(deviceId)
    this.frameState.lastTrackActivityMs.delete(deviceId)
    this.motionEventSnapshots?.forgetDevice(deviceId)
    this.frameState.audioEpisodeByDevice.delete(deviceId)
    for (const [episodeId, track] of this.frameState.audioEpisodeTracks) {
      if (track.deviceId === deviceId) {
        this.frameState.audioEpisodeTracks.delete(episodeId)
        this.frameState.audioEpisodeLastPersistMs.delete(episodeId)
      }
    }
    this.audioMarkers?.forgetDevice(deviceId)
    // S6: one call drops the device's entry from EVERY settings cache
    // (was: eight hand-listed per-map deletes).
    this.settingsCaches.clearDevice(deviceId)
    this.rawDeviceBlobMirror.invalidate(deviceId)
    this.bindingCache?.invalidate(deviceId)
    this.detectionCoverage?.forget(deviceId)
    this.zoneAnalytics?.forgetDevice(deviceId)
    this.audioMetrics?.forgetDevice(deviceId)
    this.releaseProxy(deviceId)
    // The notification centre forgets it too — rules, timelapses, digests,
    // alarm lists, mutes. It acts only on the evaluating node and only after
    // `getDevice === null` agrees (D49); the reload tick reconciles anything
    // this event missed (D8).
    void this.notificationCenter?.onDeviceDeleted(deviceId)
  }

  /** Wall-clock of the last resident heartbeat line. */
  private residentHeartbeatAt = 0

  /**
   * Resident records vs live tracks, once per interval: a resident count that
   * climbs past the live-track count is the signature of a record nothing
   * closes (the late-completion ghost fixed 2026-10-14).
   */
  private logResidentHeartbeat(now: number): void {
    if (now - this.residentHeartbeatAt < RESIDENT_HEARTBEAT_INTERVAL_MS) return
    this.residentHeartbeatAt = now
    let liveTracks = 0
    for (const ids of this.frameState.lastActiveTrackIds.values()) liveTracks += ids.size
    const orphans = this.orphanResidents(now)
    const mem = process.memoryUsage()
    this.ctx.logger.info('analytics resident heartbeat', {
      meta: {
        residents: this.residents.size(),
        liveTracks,
        orphans: orphans.length,
        orphanSamples: orphans.slice(0, 3).map((o) => ({
          trackId: o.trackId,
          deviceId: o.deviceId,
        })),
        // `external - arrayBuffers`: native memory that is not a Buffer (sharp,
        // decoders). The runner's `[mem]` line is byte-pinned by specs, so the
        // number rides here.
        externalNonBufferMb: Math.max(0, Math.round((mem.external - mem.arrayBuffers) / 1048576)),
        // Entry counts of the main in-memory maps, so a RESIDENT-SET question
        // ("what is this process holding?") has per-structure numbers instead of
        // an RSS (D867). Sizes only: no iteration, no allocation.
        mapSizes: {
          processors: this.frameState.processors.size,
          processorInputs: this.frameState.processorInputs.size,
          lastActiveTrackIds: this.frameState.lastActiveTrackIds.size,
          shortMotionlessCells: this.frameState.shortMotionlessCells.size,
          proxies: this.proxies.size,
          lastRunnerNodeByDevice: this.frameState.lastRunnerNodeByDevice.size,
          pendingConfirmationLooks: this.frameState.pendingConfirmationLooks.size,
          audioEpisodeTracks: this.frameState.audioEpisodeTracks.size,
          detailStepsByDevice: this.frameState.detailStepsByDevice.size,
        },
      },
    })
  }

  /** Residents neither active in the TrackStore nor carried by the tracker
   *  (`lastActiveTrackIds`) whose last frame is older than the orphan window:
   *  a record no sweep can ever close. Healthy value: 0. */
  orphanResidents(now: number): IdleResident[] {
    return this.residents.idleResidents(now - RESIDENT_ORPHAN_IDLE_MS).filter((r) => {
      if (this.trackStore?.peekActive(r.trackId) !== null) return false
      for (const ids of this.frameState.lastActiveTrackIds.values()) {
        if (ids.has(r.trackId)) return false
      }
      return true
    })
  }

  /** Periodic sweeps — TTL promotion + retention/stationary aging. */
  private startSweepTimers(): void {
    // Periodic TTL sweep — promote stale active tracks to persisted.
    this.ttlSweepTimer = setInterval(() => {
      void this.sweepExpiredTracks()
      // The package TTL rides the same tick (F4): a pick-up is concluded when
      // its TTL runs out, not when the camera's next frame happens to arrive.
      this.runPackageStillnessSweep(Date.now())
      this.logResidentHeartbeat(Date.now())
    }, TTL_SWEEP_INTERVAL_MS)

    // Face gallery convergence: whichever surface flips the cluster
    // face-embedding model, the gallery follows on its own — no per-UI hook to
    // forget. `shouldAutoReembed` makes this converge and stop.
    this.faceReembedAutoTimer = setInterval(() => {
      // Model space first, alignment second: the photo pass refuses a sample
      // whose model is not the cluster's, so it must follow a re-embed (D643).
      void this.maybeAutoReembedFaces().then(() => this.faceAlignmentJobs?.maybeAutoRunPhotoPass())
    }, FACE_REEMBED_AUTO_CHECK_MS)

    // D866: the change-gated whole-archive face rescore. The first run is one
    // interval after start (the scheduler's clock starts here), never a boot purge.
    this.faceRescoreTimer = setInterval(() => {
      void this.faceRescoreRuntimeOrNull()
        ?.scheduler.tick()
        .catch((err: unknown) => {
          this.ctx.logger.warn('face rescore tick failed', { meta: { error: String(err) } })
        })
    }, FACE_RESCORE_TICK_MS)

    // D643: drop old-aligned DETECTED samples of an identity once it has 10
    // new ones. Hourly here, and after every detected enrol (onSampleEnrolled).
    this.faceGalleryPruneTimer = setInterval(() => {
      void this.faceAlignmentJobs?.prune()
    }, FACE_GALLERY_PRUNE_INTERVAL_MS)

    // Periodic retention sweep — drop old events + media beyond the
    // retention window, AND age out persisted tracks per-device via the
    // track-centric cascade (design §6). Both ride the SAME interval (one
    // interval, not a new subsystem).
    this.retentionSweepTimer = setInterval(() => {
      // ONE call now (D61): `sweepRetention` runs the track cascade and the
      // trackless roots in one pass over one device set with one `now`. It used
      // to be two entry points on the same timer that each resolved their own.
      void this.sweepRetention()
      // Retire parked objects unconfirmed past their TTL (removed while
      // unobserved) + flush advanced lastConfirmedAt for durability.
      void this.stationaryRegistry?.sweep(Date.now())
      // Evidence tallies are STAGED on the frame path (a parked car is observed
      // 5-30 times a second) and persisted here. Losing a flush costs a few
      // minutes of accumulated repetition, never a wrong birth: the decision is
      // always read from the RAM mirror.
      void this.stationaryEvidence?.flush()
      // The audit log records everyone else's retention and had none of its
      // own — it grew for the life of the node (11,519 rows on the operator's
      // hub). Same interval, one statement, best-effort.
      void this.pruneOpsLog()
    }, RETENTION_SWEEP_INTERVAL_MS)

    // LTS flush — one minute, so a closed five-minute bucket lands promptly
    // and a restart loses at most the bucket in progress. The flush writes
    // ONLY closed buckets, so this cadence costs nothing extra: four of every
    // five ticks write zero rows.
    this.ltsFlushTimer = setInterval(() => {
      void this.lts?.flushDue().catch((err: unknown) => {
        this.ctx.logger.warn('lts flush failed', {
          meta: { error: errMsg(err) },
        })
      })
    }, LTS_FLUSH_INTERVAL_MS)

    // The ORPHAN AUDIT rides its OWN, much wider interval — hours, not the
    // 5-minute retention tick. It walks whole collections rather than an
    // indexed range, so it is paced deliberately and skips its own run if the
    // previous one has not finished. Separate timer, separate cadence, separate
    // log line: a future reader must be able to see at a glance that this is
    // not a fifth age sweep (D61).
    void this.startOrphanAuditTimer()

    // The enrolled gallery must not be sitting on the footage volume. This is
    // a reconcile, not a one-shot: it is cheap when converged (three indexed
    // queries) and it is the only thing that would notice an operator moving
    // event media back on top of the gallery. It also REPORTS enrolled rows
    // whose pixels are already gone — the 28 samples the 2026-08-17 recordings
    // wipe destroyed were silent for three days (D197).
    void this.reconcileGalleryMediaLocation()

    // The retrain dataset must not be sitting on the footage volume either
    // (D781): copies taken before it moved to the artifacts class are carried
    // over here, and copies whose bytes are already gone are reported.
    void this.reconcileRetrainCopiesLocation()
  }

  /**
   * Move pre-D781 retrain copies off the footage class onto the durable
   * `retrainMedia` tenant, and say how many have no bytes left.
   */
  private async reconcileRetrainCopiesLocation(): Promise<void> {
    const retrainFrames = this.retrainFrames
    if (!retrainFrames) return
    try {
      const result = await retrainFrames.relocateLegacyCopies()
      if (result.relocated === 0 && result.missing === 0 && result.failed === 0) return
      this.ctx.logger.info('retrain copies reconciled onto the durable retrain tenant', {
        meta: { ...result, location: RETRAIN_MEDIA_LOCATION },
      })
    } catch (err) {
      // An unavailable `artifacts` location lands here: the copies stay where
      // they are and readable, and the next boot tries again.
      this.ctx.logger.warn('retrain copies reconcile failed — the copies stay on eventMedia', {
        meta: { error: errMsg(err), location: ARTIFACTS_MEDIA_LOCATION },
      })
    }
  }

  /**
   * Move enrolled-gallery blobs off the footage volume, and say out loud how
   * many of them no longer have pixels at all.
   */
  private async reconcileGalleryMediaLocation(): Promise<void> {
    const mediaStore = this.mediaStore
    if (!mediaStore) return
    // PREFLIGHT, and it earns its place. The gallery is a tenant of the
    // `artifacts` class, so what must resolve is that class's one location.
    // A storage location is seeded from the addon manifest only when a
    // `storage-provider` registers — an event a plain `camstack deploy` does
    // not raise — so on the deploy that introduces `artifacts` it can be
    // undeclared until the node restarts (or the operator creates it), and
    // every enrolled-gallery write would then throw. That refusal is the
    // CORRECT failure — the alternatives are the footage volume (where the
    // last gallery was lost, D197) and the addon data dir (which the operator
    // ruled carries no media, 2026-09-04, D341) — but it would surface as an
    // opaque enrolment error, so say the remedy once, here, where it is cheap.
    try {
      await this.ctx.api.storage.resolve.query({
        location: ARTIFACTS_MEDIA_LOCATION,
        relativePath: GALLERY_TENANT_SUBPATH,
      })
    } catch (err) {
      this.ctx.logger.error(
        'artifacts storage location is NOT available — enrolling a face, a plate or a scene reference will FAIL until it is',
        {
          meta: {
            location: ARTIFACTS_MEDIA_LOCATION,
            error: errMsg(err),
            hint: 'the declaration is seeded when a storage-provider registers; restart this node so the manifest is re-read, or create an artifacts location. Refusing the write is deliberate — the gallery is never written to the footage volume, and the addon data dir carries no media.',
          },
        },
      )
      return
    }
    try {
      const result = await mediaStore.relocateExemptMediaToGallery()
      if (result.relocated === 0 && result.missing === 0 && result.failed === 0) return
      this.ctx.logger.info('enrolled gallery media reconciled onto the gallery volume', {
        meta: { ...result, location: GALLERY_MEDIA_LOCATION },
      })
      if (result.missing > 0) {
        this.ctx.logger.error(
          'enrolled gallery rows have NO pixels — the sample reconcile below removes these references (operator rule 2026-08-21: not on the filesystem means deleted)',
          {
            meta: {
              missing: result.missing,
              hint: 'the pixels are gone for good; re-enrol these people from a photo',
            },
          },
        )
      }
    } catch (err) {
      this.ctx.logger.warn('enrolled gallery media reconcile failed', {
        meta: { error: errMsg(err) },
      })
    }
    // Stage 2 — reference integrity, sample-level: a row whose blob is gone
    // from the filesystem is a DELETED sample and the row follows it (bounded,
    // grace-windowed, abort-on-probe-error — see gallery-reconcile.ts).
    try {
      const identityStore = this.identityStore
      const gallery = this.faceGalleryProvider
      const mediaStore2 = this.mediaStore
      if (!identityStore || !gallery || !mediaStore2) return
      const report = await reconcileGallerySamples(
        {
          listIdentities: async () =>
            (await identityStore.listIdentities()).map((i) => ({
              id: i.id,
              name: i.name,
            })),
          listSamples: async (identityId) =>
            (await identityStore.listSamples(identityId)).map((r) => ({
              id: r.id,
              addedAt: r.addedAt,
              ...(r.mediaId !== undefined ? { mediaId: r.mediaId } : {}),
            })),
          blobState: (mediaId) => mediaStore2.referencedBlobState(mediaId),
          removeSample: (identityId, sampleId) => gallery.removeSample({ identityId, sampleId }),
          logger: {
            info: (m, e) => this.ctx.logger.info(m, e),
            warn: (m, e) => this.ctx.logger.warn(m, e),
          },
        },
        {
          now: Date.now(),
          graceMs: DEFAULT_GALLERY_RECONCILE_GRACE_MS,
          maxReclaimPerRun: DEFAULT_GALLERY_RECLAIM_CEILING,
        },
      )
      // The matcher's in-memory gallery still holds the removed vectors.
      if (report.reclaimed > 0) await this.faceRecognizer?.refreshGallery()
    } catch (err) {
      this.ctx.logger.warn('gallery sample reconcile failed', {
        meta: { error: errMsg(err) },
      })
    }
  }

  /** Schedule the orphan audit on the operator's interval (hours). */
  private async startOrphanAuditTimer(): Promise<void> {
    try {
      const hours = await this.orphanAuditIntervalState.get()
      const periodMs = Math.max(1, hours) * 60 * 60 * 1000
      this.orphanAuditTimer = setInterval(() => {
        void this.runOrphanAuditPass()
      }, periodMs)
      this.ctx.logger.info('analytics orphan audit scheduled', {
        meta: {
          intervalHours: hours,
          mode: await this.orphanAuditModeState.get(),
        },
      })
    } catch (err) {
      this.ctx.logger.warn('analytics orphan audit NOT scheduled', {
        meta: { error: String(err) },
      })
    }
  }

  /** Cap provider registrations returned from `onInitialize` — the widgets
   *  bundle (static manifest in `runtime/widget-manifest.ts`), the default
   *  videoclips provider and the face/plate galleries. */
  /**
   * Build the `scene-monitor` store + provider (every node) and the evaluation
   * engine (post-processing node only).
   *
   * Ordering is load-bearing: the store is LOADED before the provider hydrates,
   * and the provider hydrates before the engine starts. A scene that was
   * `diverged` before a restart must be `diverged` when the first check runs —
   * not `unknown`, which would re-fire the whole latch on the check after it.
   */
  private async buildSceneMonitor(api: AnalyticsApi, logger: IScopedLogger): Promise<void> {
    // Scene CONFIG is a record kind — hub only (agents have no ctx.records).
    if (this.localOwnNodeId() !== 'hub') return
    const log = logger.child('SceneMonitor')
    const store = new SceneStore({
      records: this.requireRecords(),
      logger: log,
    })
    await store.load()

    const encoder = {
      encode: (crop: Uint8Array, width: number, height: number) =>
        api.embeddingEncoder.encode.query({
          crop: new Uint8Array(crop),
          width,
          height,
        }),
      getInfo: () => api.embeddingEncoder.getInfo.query(),
    }
    // `force` is the OPERATOR signal and the capture path is the one legitimate
    // caller of it (`snapshot.cap.ts` is explicit that background callers must
    // never set it — on a battery camera it walks past the sleep gate).
    const getSnapshot = async (
      deviceId: number,
      force: boolean,
    ): Promise<{ base64: string; contentType: string } | null> =>
      api.snapshot.getSnapshot.query({
        deviceId,
        ...(force ? { force: true } : {}),
      })

    const provider = new SceneMonitorProvider({
      store,
      encoder,
      getSnapshot,
      putMedia: async ({ deviceId, ownerId, data, timestamp }) => {
        const media = this.mediaStore
        if (media === null) throw new Error('media store not ready')
        // `ownerKind: 'scene'` — retention-exempt, and NOT the phantom event
        // row `'event'` made the orphan audit hunt for. See `OWNER_KINDS`.
        return media.putReplacing({
          deviceId,
          ownerKind: 'scene',
          ownerId,
          kind: 'thumbnailSmall',
          timestamp,
          data,
        })
      },
      // Scene media is retention-EXEMPT, so nothing else in the system will
      // ever collect a reference picture: it leaves with its reference here or
      // it never leaves.
      dropMedia: async (mediaId) => {
        await this.mediaStore?.deleteById(mediaId)
      },
      mirrorSlice: (deviceId, status) => {
        void this.mirrorSceneSlice(deviceId, status)
      },
      emitStateChanged: (payload) => {
        this.ctx.eventBus.emit({
          id: `scene-${payload.deviceId}-${payload.monitorId}-${payload.timestamp}`,
          timestamp: new Date(payload.timestamp),
          source: {
            type: 'addon',
            id: 'pipeline-analytics',
            addonId: 'pipeline-analytics',
          },
          category: EventCategory.EnrichmentSceneStateChanged,
          data: payload,
        })
      },
      // The Notification-Center's `scene` gate, fed IN PROCESS on a confirmed
      // transition. Not a bus subscription: D8 events are droppable telemetry,
      // and a gate refreshed by droppable telemetry is a gate that is sometimes
      // wrong and never says so (D49, D159).
      onSceneEdge: (edge) => {
        this.notificationCenter?.onSceneEdge({
          sceneId: edge.monitorId,
          deviceId: edge.deviceId,
          label: edge.monitorLabel,
          verdict: edge.verdict,
          latched: edge.latched,
          emit: edge.emit,
        })
      },
      currentCondition: async (deviceId) =>
        resolveCondition({
          ...(await this.sceneConditionContext(deviceId)),
          now: new Date(),
        }),
      logger: log,
    })
    provider.hydrate()
    this.sceneProvider = provider
    // The centre started BEFORE this provider existed (it needs the media store
    // and the encoder), so its boot refresh read an empty list. Reconcile now
    // rather than leaving every scene-gated rule shut for a whole reload tick
    // after each respawn — and the provider has just hydrated its latch from the
    // durable ledger, so this read already carries a scene that was diverged
    // before the restart.
    this.notificationCenter?.refreshSceneStates()

    if (!this.isPostProcessingNode) {
      log.info('scene evaluation INERT on this node — CRUD only')
      return
    }

    const engine = new SceneEngine({
      encoder,
      getSnapshot,
      listAllScenes: async () => provider.listAllEnabled(),
      applyEngineResult: (deviceId, monitorId, result) =>
        provider.applyEngineResult(deviceId, monitorId, result),
      resolveConditionContext: (deviceId) => this.sceneConditionContext(deviceId),
      // CLIP proposes, the vision model adjudicates — and it is asked ONLY on a
      // candidate flip. Built unconditionally: an install with no vision
      // profile answers `no-profile`, which is a normal `{ok:false}` the gate
      // reads as a fail-CLOSED hold, not a throw.
      confirmGate: new SceneConfirmGate({
        logger: log.child('Confirm'),
        generateVision: async (i) =>
          api.llm.generateVision.mutate({
            ...(i.profileId !== undefined ? { profileId: i.profileId } : {}),
            requestId: i.requestId,
            consumer: i.consumer,
            system: i.system,
            prompt: i.prompt,
            images: i.images.map((image) => ({
              bytes: image.bytes,
              mimeType: image.mimeType,
            })),
            jsonSchema: i.jsonSchema,
            temperature: i.temperature,
            // Same reason as the notification wiring above: the caller's bound
            // must reach the provider, not stop at this boundary.
            ...(i.timeoutMs !== undefined ? { timeoutMs: i.timeoutMs } : {}),
          }),
        cancelVision: async (requestId) => {
          await api.llm.cancel.mutate({ requestId })
        },
        downscale: downscaleSceneCrop,
      }),
      // The quiet gate's substrate — two Map.gets, no await, already maintained
      // by the motion + track handlers on this node.
      isMotionActive: (deviceId, atMs, quietMs) => this.isMotionActive(deviceId, atMs, quietMs),
      logger: log.child('Engine'),
    })
    provider.attachEngine(engine)
    engine.start()
    this.sceneEngine = engine

    // Cross-node convergence: a scene created on the hub reaches the evaluating
    // node on this timer. Bounded staleness, never wrongness (D8 — reconcile
    // over events).
    this.sceneReloadTimer = setInterval(() => {
      void store
        .load()
        .then(() => store.pruneLatches())
        .catch((err: unknown) => log.debug('scene reload failed', { meta: { error: errMsg(err) } }))
    }, SCENE_RELOAD_INTERVAL_MS)
    this.sceneReloadTimer.unref?.()
  }

  /**
   * Per-device condition inputs for the resolver.
   *
   * Only the install coordinates today. The `day-night` cap is deliberately NOT
   * consulted: it reports the CONFIGURED mode, which is `auto` on almost every
   * camera here and therefore says nothing about right now. The measured chroma
   * of the frame answers the same question directly, and the engine does that
   * in `checkOnce`.
   */
  private async sceneConditionContext(deviceId: number): Promise<{
    forcedMode?: 'day' | 'night'
    coordinates?: { lat: number; lng: number }
  }> {
    void deviceId
    const coordinates = await this.siteCoordinates()
    return coordinates === null ? {} : { coordinates }
  }

  /**
   * The SITE's coordinates, cached.
   *
   * Read from `system.getSiteLocation` — a hub-wide setting, not this addon's.
   * They stopped being an analytics setting on 2026-08-14: where the building is
   * is a fact of the installation, and a second consumer of sun-times would
   * otherwise have to reach into `pipeline-analytics`' store (addons never
   * import each other) or grow a knob that disagrees with it (D62). The hub also
   * derives a default from its public IP on first read, which this addon has no
   * business doing.
   *
   * The call is a cross-node RPC on purpose: scene evaluation runs on whichever
   * node is designated for post-processing, and `ctx.settings.getSection()` is
   * node-local — it reads empty on an agent. Absent ⇒ `null`, and the resolver
   * falls back to its coarse UTC clock split rather than inventing a location.
   */
  private async siteCoordinates(): Promise<{
    lat: number
    lng: number
  } | null> {
    const now = Date.now()
    if (this.siteCoordsCache !== null && now - this.siteCoordsCache.at < SITE_COORDS_TTL_MS) {
      return this.siteCoordsCache.value
    }
    let value: { lat: number; lng: number } | null = null
    try {
      const status = await this.ctx.api.system.getSiteLocation.query()
      if (status.location !== null) {
        value = {
          lat: status.location.latitude,
          lng: status.location.longitude,
        }
      }
    } catch (err: unknown) {
      this.ctx.logger.debug('site location read failed', {
        meta: { error: errMsg(err) },
      })
    }
    this.siteCoordsCache = { value, at: now }
    return value
  }

  /** Mirror the cap's runtimeState slice. Best effort: the slice is a MIRROR of
   *  the durable latch, so a failed write costs a stale badge, never a fact. */
  private async mirrorSceneSlice(deviceId: number, status: SceneMonitorStatus): Promise<void> {
    try {
      const dev = await this.ctx.fetchDevice(deviceId)
      await dev.deviceState.setCapSlice({
        capName: 'scene-monitor',
        slice: status,
      })
    } catch (err: unknown) {
      this.ctx.logger.debug('scene slice mirror failed', {
        tags: { deviceId },
        meta: { error: errMsg(err) },
      })
    }
  }

  private buildProviderRegistrations(
    stores: AnalyticsStores,
    providers: AnalyticsCapProviders,
  ): ProviderRegistration[] {
    const widgetsProvider = createAnalyticsWidgetsProvider()

    // D683 §6.6: an absorbed provisional id resolves to its survivor before
    // ANY of the three caps below sees it — derived from each cap's own
    // method schemas (`trackIdTakingMethods`), so a method added later is
    // covered without anyone remembering this file.
    const aliasOf = (id: string): Promise<string | null> =>
      this.trackAliasStore?.resolve(id) ?? Promise.resolve(null)
    // Review M1: a `trackIds`/`*TrackIds` array batches through the store's
    // own `resolveMany` (one query per page) instead of one `resolve` call
    // per id. Review H2: a failed lookup (this cap boundary's OWN failure
    // path, distinct from TrackAliasStore's internal "not an alias" miss
    // cache) is reported through the one shared sampled WARN, never thrown.
    const aliasResolveOptions = {
      resolveMany: (ids: readonly string[]): Promise<ReadonlyMap<string, string>> =>
        this.trackAliasStore?.resolveMany(ids) ?? Promise.resolve(new Map()),
      onFailure: (failure: AliasResolveFailure): void => this.aliasResolveFailureLogger?.(failure),
    }

    const faceGallery = new FaceGalleryProvider({
      identityStore: stores.identityStore,
      faceStore: stores.faceStore,
      mediaStore: stores.mediaStore,
      trackStore: stores.trackStore,
      eventStore: stores.eventStore,
      logger: this.ctx.logger,
      refreshGallery: () => this.faceRecognizer?.refreshGallery(),
      // The audit refuses rather than guesses when the pin cannot be read —
      // see `auditIdentitySamples`. Resolved per call, not captured: the
      // cluster's model can change under a running addon.
      // The gallery is cluster-wide, so the audit reads the FLEET setting (a
      // per-camera override describes one camera's live matching, not what a
      // stored sample can do to everybody).
      resolveAutoAssignThreshold: async () =>
        (await this.readDeviceSettings(0, resolveFaceSettings)).similarityThreshold,
      resolveClusterModelId: async () => {
        const api = this.ctx.api
        if (!api) return null
        return resolveClusterModelPin(api, FACE_EMBEDDING_STEP_ID, {
          warn: (m, e) => this.ctx.logger.warn(m, e),
        })
      },
      // Lazy: the event-media plane is served after this provider is built.
      eventMediaBaseUrl: () => this.eventMediaBaseUrl,
      eventMediaPathPrefix: () => this.eventMediaPathPrefix(),
      emitFaceGalleryChanged: (payload) => this.emitFaceGalleryChanged(payload),
      // D643: the enrol that can cross the prune threshold runs the prune for
      // that identity. Fire-and-forget — the jobs log their own failures.
      onSampleEnrolled: (identityId) => {
        void this.faceAlignmentJobs?.prune(identityId)
      },
    })
    this.faceGalleryProvider = faceGallery
    this.faceAlignmentJobs = new FaceAlignmentJobs({
      stores: () =>
        this.identityStore !== null && this.mediaStore !== null && this.faceStore !== null
          ? {
              identityStore: this.identityStore,
              mediaStore: this.mediaStore,
              faceStore: this.faceStore,
            }
          : null,
      analyzePhoto: (photoJpeg) => this.analyzeStoredPhoto(photoJpeg),
      removeDetectedSample: (identityId, sampleId) =>
        faceGallery.removeSample({ identityId, sampleId }),
      refreshGallery: async () => {
        await this.faceRecognizer?.refreshGallery()
      },
      isReembedRunning: () => this.faceReembedRunning,
      logger: this.ctx.logger,
    })

    const plateGallery = new PlateGalleryProvider({
      plateStore: stores.plateStore,
      vehicleStore: stores.vehicleStore,
      mediaStore: stores.mediaStore,
      trackStore: stores.trackStore,
      eventStore: stores.eventStore,
      logger: this.ctx.logger,
      refreshGallery: () => {
        void this.plateRecognizer?.refreshGallery()
      },
      eventMediaBaseUrl: () => this.eventMediaBaseUrl,
      eventMediaPathPrefix: () => this.eventMediaPathPrefix(),
      emitPlateGalleryChanged: (payload) => this.emitPlateGalleryChanged(payload),
    })

    return [
      {
        capability: pipelineAnalyticsCapability,
        provider: resolvingTrackIds(
          this,
          trackIdTakingMethods(pipelineAnalyticsCapability.methods),
          aliasOf,
          aliasResolveOptions,
        ),
      },
      // Per-camera failure counters, with their denominators. Inert: read from
      // bounded in-RAM state, no persistence and no timer. The hub assembles
      // every provider's entries behind `system.getFailureContributions`.
      {
        capability: failureContributionCapability,
        provider: { list: () => this.failureReport.list() },
      },
      // Notification Center rule surface — the center is always built in
      // onInitialize before registrations are collected.
      ...(this.notificationCenter !== null
        ? [
            {
              capability: notificationRulesCapability,
              provider: this.notificationCenter.buildProvider(),
            },
          ]
        : []),
      // How many bytes THIS addon holds on each storage location (D388). The
      // orchestrator stamps the merged figure on `listLocations` so every
      // surface reads one row. Deliberately NOT `storage-evictable`: that cap
      // answers the eviction domain and reports zero for a frozen location,
      // which are the two ways an occupancy figure goes wrong.
      {
        capability: storageOccupancyCapability,
        provider: {
          getOccupancy: async (input: StorageOccupancyInput) =>
            this.mediaOccupancy(input.locationIds),
        },
      },
      {
        capability: zoneAnalyticsCapability,
        provider: providers.zoneAnalytics,
      },
      {
        capability: audioMetricsCapability,
        provider: providers.audioMetrics,
      },
      {
        capability: addonWidgetsSourceCapability,
        provider: widgetsProvider,
      },
      {
        capability: faceGalleryCapability,
        provider: resolvingTrackIds(
          faceGallery,
          trackIdTakingMethods(faceGalleryCapability.methods),
          aliasOf,
          aliasResolveOptions,
        ),
      },
      {
        capability: plateGalleryCapability,
        provider: resolvingTrackIds(
          plateGallery,
          trackIdTakingMethods(plateGalleryCapability.methods),
          aliasOf,
          aliasResolveOptions,
        ),
      },
      // `scene-monitor` — declared in the manifest and, since this registration,
      // actually resolvable. It was a fully generated cap with no provider
      // behind it: `getSingleton('scene-monitor')` answered `null` on every
      // call and the cap was simply absent from every device.
      ...(this.sceneProvider !== null
        ? [{ capability: sceneMonitorCapability, provider: this.sceneProvider }]
        : []),
      // A deleted device's events, tracks and media are removed with it (D865).
      { capability: deviceRemovalHookCapability, provider: this.removalHook },
    ]
  }

  /** The `device-removal-hook` provider (D865): told by device-manager, caught up from its tombstones. */
  private get removalHook(): IDeviceRemovalHookProvider {
    this.removalHookImpl ??= createAnalyticsRemovalHook({
      logger: this.ctx.logger,
      deleteDeviceEvents: (input) => this.deleteDeviceEvents(input),
      wipeAllAnalytics: (input) => this.wipeAllAnalytics(input),
      evictSensorEvents: async (deviceId, cutoffMs) =>
        (await this.sensorEventStore?.evictBefore(deviceId, cutoffMs)) ?? 0,
      eventCountsByDevice: async () => (await this.eventStore?.countByDevice()) ?? new Map(),
      trackDeviceIds: async () => (await this.trackStore?.listDeviceIds()) ?? [],
      removeNotificationRows: async (deviceId) =>
        (await this.notificationCenter?.removeDeviceData(deviceId)) ?? {},
      listNotificationData: async () => (await this.notificationCenter?.listDeviceData()) ?? [],
    })
    return this.removalHookImpl
  }

  private removalHookImpl: IDeviceRemovalHookProvider | null = null

  /** Catch up on deletions missed while this addon was down (D865) — tombstones only. */
  override async onHubReachable(): Promise<void> {
    await super.onHubReachable()
    this.ctx.addDisposer(
      armRemovalReconcile({
        api: this.ctx.api,
        logger: this.ctx.logger,
        remove: (input) => this.removalHook.onDeviceRemoved(input),
      }),
    )
  }

  /**
   * `BaseAddon.updateGlobalSettings` calls this after the write lands —
   * gated to the LOCAL node's own write (a sibling-node write returns before
   * reaching it), which is exactly the scope `rawGlobalStoreMirror` needs to
   * invalidate: the mirror only ever answers for THIS process, so it only
   * needs to drop on THIS process's own write (D224).
   */
  protected override async onConfigChanged(): Promise<void> {
    await super.onConfigChanged()
    this.rawGlobalStoreMirror.invalidate()
    // The alert settings are read SYNCHRONOUSLY on the notification path, so
    // they are mirrored rather than fetched (D49: a one-shot event never gates
    // on a fallible read). Refreshed here — where the operator's own write
    // lands — and at boot; a failed refresh keeps the previous values, never
    // reverts to the defaults, because reverting would silently move the
    // threshold under a notification the operator had just retuned.
    await this.refreshDeviceAlertSettings()
  }

  /**
   * Re-read the three cluster alert settings into the mirror the Notification
   * Center reads. Never throws — a failing store must not take a config-change
   * hook with it.
   */
  private async refreshDeviceAlertSettings(): Promise<void> {
    try {
      const raw = await this.rawGlobalStoreMirror.resolve()
      this.deviceAlertSettingsMirror = DeviceAlertSettingsSchema.parse(raw)
    } catch (err) {
      this.ctx.logger.debug('device alert settings refresh failed — keeping the previous values', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  protected async onShutdown(): Promise<void> {
    this.shuttingDown = true
    // A 1 s timer and a `PerformanceObserver` left running past shutdown would
    // outlive every respawn the `CrashSupervisor` does.
    if (this.stopStallMonitor) {
      this.stopStallMonitor()
      this.stopStallMonitor = null
    }
    this.sceneEngine?.stop()
    this.sceneEngine = null
    if (this.sceneReloadTimer !== null) {
      clearInterval(this.sceneReloadTimer)
      this.sceneReloadTimer = null
    }
    this.alarmPanelConvergence?.stop()
    this.alarmPanelConvergence = null
    for (const unsub of this.subscriptionUnsubs) unsub()
    this.eventMediaLocationDoorbellUnsub?.()
    this.eventMediaLocationDoorbellUnsub = null
    this.subscriptionUnsubs = []
    // TWO independent jobs, run TOGETHER — the runner's SIGTERM budget is 3 s
    // on the hub's stop-all path, and a handler parked on its marker snapshot
    // would otherwise push the episode close to the edge of the SIGKILL:
    //  - no new sensor handler can start now; the ones already running finish
    //    against a live context and a live notification centre (drained,
    //    bounded);
    //  - force-close every open motion episode, after the bus subscriptions
    //    are gone (no new rising edge can reopen one) and before anything else
    //    tears down. Each row it closed logs its own `deviceId` + reason
    //    (`MotionEpisodeTracker.closeAll`) — the alternative, an open episode
    //    whose 15 s timer never fires because the process is gone, leaves a
    //    `durationMs: null` row nobody can ever explain (D475).
    await Promise.all([this.drainSensorHandlers(), this.motionEpisodes?.closeAll('addon-shutdown')])
    // D683 Task 18: a fusion's durable re-point still queued must land before
    // the stores it writes go away — bounded, because the runner's SIGTERM
    // budget is 3 s, and a queue that does not settle in time is SAID (the
    // rows stay under the absorbed id; the alias ledger and the orphan audit
    // own them from there).
    await this.settleTrackFusions()
    await this.embeddingDispatcher?.stop()
    this.embeddingDispatcher = null
    // Refused object embeddings are counted, not logged per track (D658): say
    // what is still pending before the process goes.
    this.objectEmbeddingStore?.flushRefusals()
    await this.notificationCenter?.stop()
    this.notificationCenter = null
    for (const id of this.proxies.keys()) this.releaseProxy(id)
    if (this.ttlSweepTimer) {
      clearInterval(this.ttlSweepTimer)
      this.ttlSweepTimer = null
    }
    if (this.faceReembedAutoTimer) {
      clearInterval(this.faceReembedAutoTimer)
      this.faceReembedAutoTimer = null
    }
    if (this.faceGalleryPruneTimer) {
      clearInterval(this.faceGalleryPruneTimer)
      this.faceGalleryPruneTimer = null
    }
    if (this.faceRescoreTimer) {
      clearInterval(this.faceRescoreTimer)
      this.faceRescoreTimer = null
    }
    this.faceRescoreRuntime?.job.stop()
    if (this.orphanAuditTimer) {
      clearInterval(this.orphanAuditTimer)
      this.orphanAuditTimer = null
    }
    if (this.retentionSweepTimer) {
      clearInterval(this.retentionSweepTimer)
      this.retentionSweepTimer = null
    }
    if (this.ltsFlushTimer) {
      clearInterval(this.ltsFlushTimer)
      this.ltsFlushTimer = null
    }
    // Cancel any in-flight slice-throttle timers so a pending trailing
    // flush can't fire after the addon is gone (would throw on
    // `fetchDevice` against a torn-down ctx).
    this.zoneAnalytics?.destroy()
    this.audioMetrics?.destroy()
    // Flush the audio-marker tallies rather than losing the window — a
    // suppression count that dies with the process reads as "never happened".
    this.audioMarkers?.flush(Date.now())
    // Stop all per-device detail ticks + drop scheduler/queue state.
    this.detailDispatcher?.dispose()
    this.detailDispatcher = null
    this.parkedFrames?.dispose()
    this.overlayState.clear()
    this.frameState.overlaySynthesisWarnAt.clear()
    // Every open segment ends `addon-stopped`. The field is nulled FIRST, so a
    // frame already past the `shuttingDown` check cannot open a segment this
    // close would never see; `stopAll` never rejects and gives up at
    // `STOP_DEADLINE_MS` (a hung disk must not stall the rest of shutdown).
    const tapeRecorder = this.tapeRecorder
    this.tapeRecorder = null
    this.tapeShelf = null
    await tapeRecorder?.stopAll()
    this.frameState.processors.clear()
    this.frameState.processorInputs.clear()
    this.frameState.lastActiveTrackIds.clear()
    this.frameLag.clear()
    this.frameState.lastFrameDimsByDevice.clear()
    this.frameState.dropoutSkipsByKey.clear()
    this.residents.clearAll()
    // S3: drop every queued capture request (running execs settle harmlessly
    // against their captured lane objects) and reset scheduler key/metric state.
    this._captureScheduler?.clear()
    this.keyFrameCaptureLog.clear()
    this.nodeLiveness.clear()
    this.frameState.gatedNodeByDevice.clear()
    this.frameState.levelStateByDevice.clear()
    this.frameState.audioConfirmByDevice.clear()
    // S6: every settings cache (device-scoped + the global face switch) drops
    // in one call (was: nine hand-listed clears).
    this.settingsCaches.clearAll()
    this.rawDeviceBlobMirror.invalidateAll()
    this.rawGlobalStoreMirror.invalidate()
    this.trackStore?.clearAll()
    this.stationaryRegistry = null
    this.bindingCache?.clearAll()
    this.detectionCoverage?.clearAll()
    await this.eventMediaDataPlane?.dispose()
    this.eventMediaDataPlane = null
    this.eventMediaBaseUrl = null
    this.eventMediaDispatcher = null
    await this.trainingExportDataPlane?.dispose()
    this.trainingExportDataPlane = null
    await this.retrainExportDataPlane?.dispose()
    this.retrainExportDataPlane = null
    await this.retrainFrameDataPlane?.dispose()
    this.retrainFrameDataPlane = null
    await this.debugExportDataPlane?.dispose()
    this.debugExportDataPlane = null
    await this.tapeExportDataPlane?.dispose()
    this.tapeExportDataPlane = null
    if (this.tapeSweepTimer !== null) {
      clearInterval(this.tapeSweepTimer)
      this.tapeSweepTimer = null
    }
    if (this.tapeFlushTimer !== null) {
      clearInterval(this.tapeFlushTimer)
      this.tapeFlushTimer = null
    }
    if (this.ncArtifactPruneTimer !== null) {
      clearInterval(this.ncArtifactPruneTimer)
      this.ncArtifactPruneTimer = null
    }
    await this.ncArtifactReadDataPlane?.dispose()
    this.ncArtifactReadDataPlane = null
    this.ncArtifactIndex = null
    this.ncArtifactStore = null
  }

  // ── Subscriber handlers ──────────────────────────────────────────────

  /**
   * Run one detection frame through the analysis layers for a given
   * SOURCE. Shared by the ML pipeline path (`source: 'pipeline'`) and the
   * native-onboard path (`source: 'onboard'`, wired in E3). Each source
   * runs an isolated FrameProcessor (keyed by `${deviceId}:${source}`), so
   * tracking/zone/event state never crosses between sources. Emits the
   * SAME canonical events, distinguished only by `source`.
   */
  /**
   * One line per processor per minute with what tracker v2 did (D683):
   * tracklets ended by reason, splits, links committed and refused. Never one
   * line per frame.
   */
  private reportTrackerSummary(
    deviceId: number,
    key: string,
    processor: FrameProcessor,
    via: TrackerSummaryPath,
  ): void {
    const now = Date.now()
    const last = this.frameState.trackerSummaryAtByKey.get(key)
    if (last === undefined) {
      this.frameState.trackerSummaryAtByKey.set(key, now)
      return
    }
    if (now - last < TRACKER_SUMMARY_INTERVAL_MS) return
    this.frameState.trackerSummaryAtByKey.set(key, now)
    const stats = processor.drainTrackerStats()
    // LOW-N1: the sweep reaches every processor every minute, idle or not —
    // an all-zero window there is ~1 440 lines a day saying nothing. The
    // frame path keeps its line: a camera that is streaming is news.
    if (via === 'sweep' && isIdleTrackerStats(stats)) return
    this.ctx.logger.info('tracker: v2 summary', {
      tags: { deviceId },
      meta: { source: processor.source, windowMs: now - last, ...stats },
    })
  }

  /** The existing processors of one camera (`pipeline`, `onboard`). */
  private processorsOf(deviceId: number): FrameProcessor[] {
    const out: FrameProcessor[] = []
    for (const source of ['pipeline', 'onboard'] as const) {
      const p = this.frameState.processors.get(this.procKey(deviceId, source))
      if (p !== undefined) out.push(p)
    }
    return out
  }

  /** The recognizer's verdict reaches every processor of its camera (C3). A
   *  processor that never held the track ignores it (the tracker knows no
   *  such id). */
  private readonly noteVerdictOnTracker = (verdict: FaceIdentityVerdict): void => {
    for (const p of this.processorsOf(verdict.deviceId)) {
      p.noteTrackIdentity(verdict.trackId, verdict.identityId)
    }
  }

  /**
   * L2 fusions a frame (or the silence sweep) committed. The processor already
   * moved its OWN per-track state; everything downstream (stores, residents,
   * recognizers) is the fusion service's one sequence (D683 Task 18).
   *
   * ORDERING (carry 7/10): every fusion's RAM steps run SYNCHRONOUSLY inside
   * this call — `fuse` awaits nothing before them, and the fusions are started
   * together rather than awaited one by one — so on the frame path they have
   * all run before the caller's next statement, i.e. after `process()` and
   * before any downstream consumer of the frame (the TrackStore upsert, the
   * recognizers' own `processFrame`). The frame path therefore never awaits
   * this; only the durable re-point is queued, per device. A fusion that
   * throws is a WARN naming it — never an anonymous rejection, never silence.
   *
   * This is the ONE place both paths meet, so it is where a fusion reaches
   * the tracking tape (D683 Task 12): the sweep's fusions have no frame record.
   */
  private async applyTrackFusions(
    deviceId: number,
    key: string,
    fusions: readonly TrackFusion[],
  ): Promise<void> {
    const plane = this.frameState.processors.get(key)?.source
    if (plane === undefined && this.tapeRecorder?.isArmed(deviceId) === true) {
      // Unreachable today (both callers hold the processor); never silent.
      this.ctx.logger.warn('tracking tape fusions not recorded — processor gone', {
        tags: { deviceId },
        meta: { key, fusions: fusions.length },
      })
    }
    const applied = fusions.map((f) => {
      if (plane !== undefined) this.tapeRecorder?.onFusion({ deviceId, plane, fusion: f })
      return this.trackFusion.fuse(deviceId, key, f)
    })
    const outcomes = await Promise.allSettled(applied)
    outcomes.forEach((outcome, i) => {
      if (outcome.status === 'fulfilled') return
      const f = fusions[i]
      this.ctx.logger.warn('track fusion failed', {
        tags: { deviceId },
        meta: {
          key,
          survivorId: f?.survivorId,
          absorbedId: f?.absorbedId,
          error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
        },
      })
    })
  }

  /**
   * Tracker v2's split and link facts for one processor, stamped with the
   * camera (D683). A `disagreed` link is a fusion that is final and now
   * carries two names: WARN, never sampled. Splits and `ignored` re-sends
   * fire often and are sampled; every other decision is one line.
   */
  private wireTrackerObservers(p: FrameProcessor, deviceId: number, source: DetectionSource): void {
    const trackerLog = this.ctx.logger.child('tracker').withTags({ deviceId })
    let splitCount = 0
    let ignoredCount = 0
    let newCount = 0
    let outOfOrderCount = 0
    let clockStepCount = 0
    const endedCounts = new Map<string, number>()
    const logLink = (f: LinkDecisionFacts): void => {
      // The decision itself; `meta` adds every candidate it weighed. The F5
      // break line carries `decision` + the rejected predecessors only.
      const decision = {
        source,
        t: f.t,
        kind: f.kind,
        from: f.from,
        to: f.to,
        cost: f.cost,
        gapMs: f.gapMs,
        reason: f.reason,
        recognition: f.recognition,
      }
      const meta = { ...decision, candidates: f.candidates }
      switch (f.kind) {
        case 'disagreed':
          trackerLog.warn('tracker: a fused track now carries two identities — fusion is final', {
            tags: { deviceId },
            meta: { ...meta, root: f.root, members: f.members, identities: f.identities },
          })
          return
        case 'ignored':
          ignoredCount += 1
          if (!sampledTrackerFact(ignoredCount)) return
          trackerLog.info('tracker: piece re-sent after its chain was pruned — ignored', {
            tags: { deviceId },
            meta: { ...meta, ignoredCount },
          })
          return
        case 'committed':
          trackerLog.info('tracker: pieces linked', { tags: { deviceId }, meta })
          return
        case 'refused':
          trackerLog.info('tracker: link refused', { tags: { deviceId }, meta })
          return
        case 'new': {
          // A piece that never passed its birth gate was never a track: the
          // decision is bookkeeping (debug). Every other `new` is sampled —
          // the summary's `linksNew` is the exact count (review M1).
          // A clock step closed it (fix round 3, LOW-7): the step's own WARN
          // names what ended; this is bookkeeping, not a missing predecessor.
          if (f.reason === 'clock-step') {
            trackerLog.debug('tracker: piece decided new — closed by a frame clock step', {
              tags: { deviceId },
              meta,
            })
            return
          }
          if (f.reason === 'unconfirmed') {
            trackerLog.debug('tracker: piece decided new — never confirmed', {
              tags: { deviceId },
              meta,
            })
            return
          }
          // F5 (follow-up 102): a CONFIRMED predecessor's link was rejected
          // on geometry or appearance — a track the operator sees break.
          // Unsampled, with why; the rejected predecessors, not every candidate.
          const rejectedPredecessors = confirmedPredecessorRejections(f.candidates)
          if (rejectedPredecessors.length > 0) {
            trackerLog.info('tracker: piece decided new — a confirmed predecessor was rejected', {
              tags: { deviceId },
              meta: { ...decision, rejectedPredecessors },
            })
            return
          }
          newCount += 1
          if (!sampledTrackerFact(newCount, TRACKER_PIECE_LOG_SAMPLE_EVERY)) return
          trackerLog.info('tracker: piece decided new — no predecessor', {
            tags: { deviceId },
            meta: { ...meta, newCount },
          })
          return
        }
      }
    }
    p.setTrackerObservers({
      split: (f) => {
        splitCount += 1
        if (!sampledTrackerFact(splitCount)) return
        trackerLog.info('tracker: tracklet split — a bind was in doubt', {
          tags: { deviceId },
          meta: {
            source,
            t: f.t,
            ended: f.ended,
            born: f.born,
            refused: f.refused,
            tests: f.tests,
            splitCount,
          },
        })
      },
      link: logLink,
      // F1 fix round 2: the frame clock stepped back past the stale bound —
      // an NTP correction or a runner move. Every tracklet ended and the clock
      // was rebased; nothing links across. Rare and worth seeing: unsampled WARN.
      // Sampled like every tracker fact (fix round 3): the first ten always —
      // the first is never lost — then one in 50, each with the running count;
      // the per-minute summary carries the exact `clockSteps`. A step needs
      // CLOCK_STEP_CONFIRM_FRAMES frames, so even a thrashing pair of runner
      // clocks cannot step at frame rate.
      clockStep: (f) => {
        clockStepCount += 1
        if (!sampledTrackerFact(clockStepCount, TRACKER_CLOCK_STEP_LOG_SAMPLE_EVERY)) return
        trackerLog.warn('tracker: frame clock stepped back — tracklets ended, clock rebased', {
          tags: { deviceId },
          meta: {
            source,
            t: f.t,
            lastFrameT: f.lastFrameT,
            behindMs: f.behindMs,
            ended: f.ended,
            clockStepCount,
            sampledEvery: TRACKER_CLOCK_STEP_LOG_SAMPLE_EVERY,
          },
        })
      },
      // F1: a frame stamped before the latest one was dropped unassociated
      // (nothing bound, spawned or split on it). Counted per camera, sampled.
      outOfOrder: (f) => {
        outOfOrderCount += 1
        if (!sampledTrackerFact(outOfOrderCount, TRACKER_OUT_OF_ORDER_LOG_SAMPLE_EVERY)) return
        trackerLog.info('tracker: out-of-order frame dropped — older than the latest frame', {
          tags: { deviceId },
          meta: {
            source,
            t: f.t,
            lastFrameT: f.lastFrameT,
            behindMs: f.behindMs,
            detections: f.detections,
            pendingClockStep: f.pendingClockStep,
            outOfOrderCount,
            sampledEvery: TRACKER_OUT_OF_ORDER_LOG_SAMPLE_EVERY,
          },
        })
      },
      // D438's question — WHY and WHEN a track ended — asked per tracklet at
      // its own end, sampled per (reason, confirmed) (review M2).
      ended: (f) => {
        const k = `${f.reason}:${String(f.confirmed)}`
        const n = (endedCounts.get(k) ?? 0) + 1
        endedCounts.set(k, n)
        if (!sampledTrackerFact(n, TRACKER_PIECE_LOG_SAMPLE_EVERY)) return
        trackerLog.info('tracker: tracklet ended', {
          tags: { deviceId },
          meta: {
            source,
            trackletId: f.trackletId,
            reason: f.reason,
            at: f.at,
            hits: f.hits,
            confirmed: f.confirmed,
            className: f.className,
            endedCount: n,
          },
        })
      },
    })
  }

  private async processFrame(
    deviceId: number,
    frame: FrameResult,
    source: DetectionSource,
    rawFrameHandle?: FrameHandle,
    detailSteps?: readonly DetailStepAnnounce[],
    /** WHY the runner inferred this frame — a session it was decoding anyway,
     *  or a periodic occupancy-recheck burst. Folded into the stationary
     *  ledger's per-occasion tallies. */
    occasion: InferenceOccasion = 'session',
    /** The runner node that emitted this frame (`PipelineInferenceResultPayload.nodeId`). */
    producerNodeId = '',
  ): Promise<void> {
    if (this.shuttingDown) return
    // D692: the camera's latest detail-step announce, for the grouped-window outlook. An
    // EMPTY announce (what the runner sends for a camera with no child steps) is kept too —
    // it means "no recogniser runs here", which is final; a frame without the field (an
    // older runner — the onboard plane announces through the same emit) leaves the last
    // known one alone.
    if (detailSteps !== undefined) this.frameState.detailStepsByDevice.set(deviceId, detailSteps)
    const active = await this.bindingCache!.isActive(deviceId)
    if (!active) {
      // Observability (2026-07-23 blackout forensics): a 15-minute all-camera
      // analytics gap left ZERO log evidence because this early-return is
      // silent and the BindingCache failure path logged at debug (below the
      // Winston file level). A device whose runner IS producing inference
      // results but whose frames get dropped here is always worth one
      // throttled line — legit-unbound devices produce no inference results,
      // so this stays quiet in the healthy steady state.
      const now = Date.now()
      const last = this.frameState.inactiveBindingDropWarnAt.get(deviceId) ?? 0
      if (now - last >= 300_000) {
        this.frameState.inactiveBindingDropWarnAt.set(deviceId, now)
        this.ctx.logger.warn('inference frames dropped — pipeline-analytics binding inactive', {
          tags: { deviceId },
          meta: { source, detections: frame.detections.length },
        })
      }
      return
    }

    // A frame handle is a promise of pixels, redeemable ONLY at
    // `handle.nodeId`: every capture below — the confirmation gate's crop, the
    // media ladder, the key frame, the enrichment crops — routes
    // `pipelineRunner.getNativeCrop` there (D18). When that node is gone the
    // cap router throws `node-offline` for every one of them, on every frame,
    // for as long as the camera keeps being ingested elsewhere. 403 of
    // 2026-08-06's key-frame misses were exactly that, 388 of them a single
    // developer laptop that had acted as an agent and closed its lid.
    //
    // So a handle whose owner the registry has already called dead is treated
    // as ABSENT, which is honest and is a path this addon already handles well
    // (a handle-less frame confirms births immediately and produces no media).
    // The mirror is deliberately reluctant — see `runtime/node-liveness.ts`.
    const captureNodeOffline =
      rawFrameHandle !== undefined &&
      this.nodeLiveness.isKnownOffline(rawFrameHandle.nodeId, Date.now())
    if (rawFrameHandle !== undefined) {
      if (captureNodeOffline) this.mediaCapture.noteCapturesGated(deviceId, rawFrameHandle.nodeId)
      else this.mediaCapture.clearCaptureGate(deviceId)
    }
    const frameHandle = captureNodeOffline ? undefined : rawFrameHandle

    const key = this.procKey(deviceId, source)

    // Detector-dropout skip: absorb a momentary drop to zero detections so
    // coasting tracks aren't aged and occupancy doesn't flip to 0. After a
    // bounded run of empties the scene is treated as genuinely empty.
    const trk = await this.resolveDeviceTrackingSettings(deviceId)
    // The switch IS the setting (D62): the recorder is told on every frame —
    // and ONLY on a frame. A camera that goes silent (offline, unbound, or
    // switched off while silent) keeps its segment open until its next frame
    // rotates it or the addon stops; the hourly sweep may unlink it meanwhile
    // (the open descriptor keeps writing to the unlinked inode, harmlessly).
    this.tapeRecorder?.setArmed(deviceId, trk.trackingTape)
    const activeCount = this.frameState.lastActiveTrackIds.get(key)?.size ?? 0
    const skips = this.frameState.dropoutSkipsByKey.get(key) ?? 0
    // The camera's low-score continuation floor (D665), `null` when off. A
    // frame whose only box is one the tracker may continue on is not a dropout.
    const lowScoreFloor = trk.lowScoreContinuationEnabled ? trk.lowScoreContinuationFloor : null
    if (
      shouldSkipDropoutFrame(activeCount, dropoutEvidenceCount(frame, lowScoreFloor), skips, {
        enabled: trk.dropoutSkipEnabled,
        maxSkipFrames: trk.dropoutMaxSkipFrames,
      })
    ) {
      this.frameState.dropoutSkipsByKey.set(key, skips + 1)
      this.ctx.logger.debug('detector dropout skipped', {
        tags: { deviceId },
        meta: {
          source,
          consecutiveSkips: skips + 1,
          activeTracks: activeCount,
        },
      })
      this.tapeRecorder?.onSkip({ deviceId, plane: source, frame })
      return
    }
    this.frameState.dropoutSkipsByKey.set(key, 0)

    // Warm the per-device stationary settings cache (#31) BEFORE processor.process
    // so the synchronous gate + the promotion loop read a fresh value this frame
    // (pipeline plane only — the gate + promotion run on that plane).
    if (planeRunsStationary(source) && this.stationaryRegistry) {
      await this.resolveDeviceStationarySettings(deviceId)
      // Same warm-up for the package-drop settings: the dedicated package
      // path runs synchronously alongside the promotion loop and reads the
      // class filter + dwell from the peeked cache.
      await this.resolveDevicePackageDropSettings(deviceId)
    }

    const processor = await this.getOrCreateProcessor(deviceId, source)
    // Resolve (or build) the device proxy on first frame for this device. The
    // proxy's slice subscribers (set up in ensureProxy) push zones + rules into
    // the FrameProcessor asynchronously; re-pushing what we resolve HERE is what
    // guarantees the snapshot's `zones` array and the per-track zone memberships
    // agree, even when the subscription hasn't fired for a freshly-added zone
    // yet (race between zone CRUD and the next inference frame).
    const proxy = await this.ensureProxy(deviceId)
    // Resolved, NOT read straight off `proxy.state.zones.value`: that slice is a
    // MIRROR the orchestrator writes only when an operator mutates a zone, so a
    // camera whose runtime-state row was never written has no slice at all and
    // every frame concluded "no zones". Device 102 sat like that with a drawn
    // 'Parking pat' [Dad's parking] — `zones: []` in every snapshot, all three parked cars
    // in `unzoned`, and its occupancy rule unable to fire. The resolver keeps
    // the mirror as the fast path and asks the cap when it is absent/empty,
    // TTL-cached so this stays one call a minute, not one per frame.
    const liveZones = await this.deviceZones.resolve(deviceId)
    const liveRules = proxy?.state.zoneRules.value?.detection ?? []
    processor.setZones(liveZones)
    processor.setDetectionRules(liveRules)
    // The bar a detection must clear to be STAMPED with a zone. Pushed on the
    // same per-frame path as the zones themselves so an operator change takes
    // effect without a respawn, exactly like a zone edit.
    processor.setZoneMembershipMinOverlap(trk.zoneMembershipMinOverlap)
    processor.setLowScoreContinuationFloor(lowScoreFloor)
    // A subject the gate promoted out of a previous birth's crop rides THIS
    // frame as a detection of its own; the tracker births it like any other
    // and the gate then confirms it on its own crop. The frame the rest of
    // this method reads (`frame`) is the runner's — a synthetic box has no
    // pixels of its own for media to be cut from.
    const injection = injectSecondarySubjects(
      frame,
      this.frameState.secondarySubjects.take(key, Date.now()),
    )
    // A subject a REAL detection has taken over rides no further: the runner's
    // native-crop recovery pass found it, or the full-frame pass did.
    for (const id of injection.covered) this.frameState.secondarySubjects.drop(key, id)
    const trackerFrame = injection.frame
    if (trackerFrame !== frame) {
      this.ctx.logger.info('secondary subjects ride this frame as detections', {
        tags: { deviceId },
        meta: {
          source,
          added: trackerFrame.detections.length - frame.detections.length,
          classes: trackerFrame.detections.slice(frame.detections.length).map((d) => d.macroClass),
        },
      })
    }
    const observe = this.tapeRecorder?.isArmed(deviceId) === true
    let result = processor.process({ timestamp: frame.timestamp, frame: trackerFrame, observe })
    // D683 review R1: ask BEFORE ANY consumer of this frame's result runs —
    // not only the TrackStore upsert loop below. A row the store already
    // closed (an operator delete, or an M2 forced close) still has a LIVE
    // tracker chain handing back the same id every frame; dropping it only
    // inside the upsert loop left every OTHER reader of `result` this same
    // frame — stationary evidence, package stillness, the detail dispatcher,
    // the CLIP best-embedding observer, snapshot targets (which only D220's
    // media gate was separately refusing), first-frame retries, the raster
    // fallback — still reading the UNFILTERED array, and `objectEvents` /
    // `appearanceEvents` for the id were persisted and published regardless
    // (a "dropped entirely" birth, but not a dropped event row or
    // notification). Filtering `result` itself, once, right here, is the one
    // place every later reader shares.
    const closedIdsThisFrame = new Set<string>()
    for (const t of result.tracked) {
      if (this.trackStore!.rowClosedAt(t.trackId) !== undefined) closedIdsThisFrame.add(t.trackId)
    }
    if (closedIdsThisFrame.size > 0) {
      for (const trackId of closedIdsThisFrame) {
        this.logClosedRowFrameDrop(deviceId, trackId)
        // Tells the tracker's own chain to stop linking under this id (never
        // links; `linker.ts`) — the subject respawns under a brand-new id on
        // its next sighting instead of being handed back here forever.
        processor.dropTrack(trackId, 'dropped')
      }
      result = {
        ...result,
        tracked: result.tracked.filter((t) => !closedIdsThisFrame.has(t.trackId)),
        rawTrackedDetections: result.rawTrackedDetections.filter(
          (rt) => !closedIdsThisFrame.has(rt.trackId),
        ),
        objectEvents: result.objectEvents.filter(
          (e) => e.trackId === undefined || !closedIdsThisFrame.has(e.trackId),
        ),
        appearanceEvents: result.appearanceEvents.filter(
          (e) => e.trackId === undefined || !closedIdsThisFrame.has(e.trackId),
        ),
        // Review S2: a fold resolved to a closed id would reach
        // `markRiderFolded`, which writes `hasRider` onto the persisted closed
        // row (or a deleted one). The id's drop is already logged above.
        // `fusions` are deliberately NOT filtered here: the fusion service
        // refuses a fusion naming a closed row itself, with a sampled WARN
        // (D683 Task 18, review T16 S2).
        riderFolds: result.riderFolds.filter(
          (f) => f.trackId === undefined || !closedIdsThisFrame.has(f.trackId),
        ),
      }
    }
    if (result.observation !== undefined) {
      this.recordTapeFrame({
        deviceId,
        source,
        frame,
        trackerFrame,
        observation: result.observation,
        liveZones,
        liveRules,
        zoneMembershipMinOverlap: trk.zoneMembershipMinOverlap,
        lowScoreFloor,
      })
    }
    // D683 review S1: the `dropTrack` above is a tracker input no frame
    // carries (spec §1), exactly like a promotion's — the replay must drop the
    // chain too, or it keeps the old id for the rest of the subject's stay.
    // Written AFTER this frame's record, at its time: the replay resolves a
    // drop through the join of the frame it names (`ProcessorTracker`), and
    // the live drop likewise acted after `process()` had answered.
    for (const trackId of closedIdsThisFrame) {
      this.tapeRecorder?.onDrop({
        deviceId,
        plane: processor.source,
        trackId,
        atMs: result.timestamp,
        reason: 'dropped',
      })
    }
    // D683: L2 decisions of this frame. The processor already moved its own
    // per-track state. NOT awaited, by design (Task 18, carry 10): every RAM
    // step of every fusion has run when this call returns — before the
    // TrackStore upsert below lands this frame's sighting on the survivor —
    // and the durable re-point runs on the fusion service's per-device queue,
    // so the frame path never waits on storage. A closed survivor named here
    // is refused by the service (the R1 filter above deliberately leaves
    // `fusions` alone). Caught so a throw is a WARN with its camera, never an
    // anonymous unhandledRejection (review L1).
    if (result.fusions.length > 0) {
      this.applyTrackFusions(deviceId, key, result.fusions).catch((err: unknown) => {
        this.ctx.logger.warn('track fusion handling failed', {
          tags: { deviceId },
          meta: { key, error: err instanceof Error ? err.message : String(err) },
        })
      })
    }
    this.reportTrackerSummary(deviceId, key, processor, 'frame')
    // Follow-up 102, fix round 3 (MEDIUM-2): an out-of-order frame stops here.
    // It was recorded on the tape (a replay drops it the same way) and counted
    // in the summary; nothing below — the registry's clock and outcomes, the
    // TrackStore upsert, media, events — may read its stale timestamp.
    if (result.droppedOutOfOrder === true) return

    // A macro class was offered for the label slot and REFUSED — the slot
    // exists to say something finer than the class, so a coarse token in it is
    // a tier collapse. The refusal is correct; its silence was not. The five
    // rows that produced the rule (`className='person', label='animal'` on
    // 107/104/103/637) were found by reading the rows a week later, because
    // nothing said a word while it was happening. One line per (track, token),
    // never per frame, so a track that keeps matching the wrong class is one
    // entry — and per camera, because the question is always "why is 107 worse
    // than 101?".
    for (const r of processor.getLastLabelWriteRefusals()) {
      // The tier collapse keeps its 2026-08-07 message and meta keys; every
      // other refusal (an UNDECLARED tier, a lower-scoring same-tier candidate)
      // is new information under its own line.
      const message =
        r.reason.kind === 'macro-class' ? 'label tier collapse refused' : 'label write refused'
      this.ctx.logger.info(message, {
        tags: { deviceId },
        meta: { trackId: r.trackId, ...refusalLogMeta(r.reason) },
      })
    }

    // RIDER FOLDS — the person half this frame removed BEFORE the tracker so a
    // cyclist counts once, as a vehicle (D34). Stamped on the surviving track
    // so the record says "a vehicle with a rider" instead of claiming an entity
    // it does not keep; the fold used to reach a RAM field nobody read.
    //
    // Both branches log, and both carry `tags.deviceId`: a fold that landed is
    // the only evidence the pairing fires on this fleet at all (no fold has
    // ever been observed in a measured window), and a fold with NO surviving
    // track is a dropped person that must not read as "never happened".
    for (const fold of result.riderFolds) {
      const meta = {
        vehicleClass: fold.vehicleClass,
        overlap: fold.overlap,
        personScore: fold.personScore,
        vehicleScore: fold.vehicleScore,
      }
      if (fold.trackId === undefined) {
        this.ctx.logger.info('rider folded but no surviving track emitted this frame', {
          tags: { deviceId },
          meta,
        })
        continue
      }
      this.ctx.logger.info('rider folded into its machine', {
        tags: { deviceId },
        meta: { ...meta, trackId: fold.trackId },
      })
      void this.trackStore?.markRiderFolded(fold.trackId)
    }

    // Advance the registry's OBSERVED clock for this device — entry expiry
    // counts frames-flowing time, never quiet wall-clock time (a
    // session-dispatch camera would otherwise flap its parked objects between
    // sessions). Pipeline plane only, matching the gate.
    if (planeRunsStationary(source)) {
      this.stationaryRegistry?.noteFrame(deviceId, result.timestamp)
    }

    // Fold this frame's stationary-gate outcome back into the registry:
    // advance confirmed entries' lastConfirmedAt + retire any that woke (their
    // object departed). The woken detections already flowed to the tracker (the
    // gate only suppressed the confirmed ones), so a departing car spawns a
    // fresh moving track this same frame.
    // Departure STRIKES are not in this guard and must never come back into it:
    // the registry commits them inside its own gate (D279), so a frame whose
    // only outcome is a first departure read cannot lose it here. It used to be
    // able to, which is why this comment exists rather than a fourth condition.
    if (
      this.stationaryRegistry &&
      (result.stationaryConfirmed.length > 0 || result.stationaryWoken.length > 0)
    ) {
      this.stationaryRegistry.applyFrameOutcome({
        deviceId,
        confirmed: result.stationaryConfirmed,
        woken: result.stationaryWoken,
        timestamp: result.timestamp,
      })
    }
    // Weak holds the tracker used to CONTINUE a confirmed track (D410). The
    // registry counts what it handed on; only the tracker knows what came of
    // it, and the sweep line reports both so the two can be read together.
    if (this.stationaryRegistry && result.stationaryContinued > 0) {
      this.stationaryRegistry.noteContinued(deviceId, result.stationaryContinued)
    }

    // Record per-frame occupancy aggregate. recordFrame mirrors the
    // snapshot to `device.state.zoneAnalytics` for live UI subscribers
    // and appends to the rolling history ring. EVERY current registry entry is
    // folded into the occupancy `tracked` list — a parked object is present by
    // definition until it departs/expires, so it keeps counting toward frame
    // occupancy (decision #4) even on frames where the detector skips it
    // (confirmed-only counting flickered occupancy to 0 on detector dropouts —
    // observed live on 102). Woken entries were already retired above, and a
    // suppressed detection never reaches `result.tracked`, so nothing
    // double-counts. The same parked set rides on the snapshot's additive
    // `stationaryObjects` field for the UI.
    const stationaryViews = this.stationaryRegistry?.listViews(deviceId) ?? []
    // Attribute each parked object with the SAME membership path as live
    // tracks (`ZoneEngine` + `zoneMembershipMinOverlap`) — a zone drawn over
    // a parked car must report a count of 1, not leak into `unzoned`. The
    // entry carries its own bbox + frame dims, so membership is resolved
    // against the live zone set here without a live frame.
    const stationaryAsTracked = stationaryViews.map((v) => ({
      trackId: `stationary:${v.id}`,
      className: v.className,
      zones: computeStationaryEntryZones(v, liveZones, trk.zoneMembershipMinOverlap),
      // These are the CENSUS: present, and not going anywhere. Stated here,
      // where the two populations are still separate, because after the
      // concat nothing can tell them apart without parsing the trackId.
      standing: true,
    }))
    // A birth the gate already rejected is a track that never existed — it
    // must not count toward zone OCCUPANCY either (an occupancy rule is a zone
    // rule). The tracker keeps carrying such an id for seconds; the general
    // rejection filter further down runs too late for this reader.
    const occupancyTracked = result.tracked.filter(
      (t) => !this.frameState.suppressedBirths.isRejected(key, t.trackId),
    )
    void this.zoneAnalytics?.recordFrame({
      deviceId,
      timestamp: result.timestamp,
      frameWidth: result.frameWidth,
      frameHeight: result.frameHeight,
      tracked:
        stationaryAsTracked.length > 0
          ? [...occupancyTracked, ...stationaryAsTracked]
          : occupancyTracked,
      zones: liveZones,
      ...(stationaryViews.length > 0 ? { stationaryObjects: stationaryViews } : {}),
    })

    // Record this frame's detection-frame dimensions for the device — the
    // key-event static-object gate normalizes track displacement to the frame
    // diagonal (positions are pixels in this space).
    if (result.frameWidth > 0 && result.frameHeight > 0) {
      this.frameState.lastFrameDimsByDevice.set(deviceId, {
        w: result.frameWidth,
        h: result.frameHeight,
      })
    }

    // Update TrackStore — per-track upsert with position + zones. The upsert
    // returns the (post-sighting) position count, which distinguishes a track's
    // very first sighting (===1) from a resurrection/reappearance (>1) below.
    const currentTrackIds = new Set<string>()
    const positionsCountById = new Map<string, number>()
    // Root model + detection-frame size of THIS frame — kept by a track only
    // when it is BORN here (D646), so a later replay can name the original.
    const provenance = trackProvenanceOf(frame)
    // WHERE this frame was inferred — opens a track born here, closes every
    // track it is a real sighting of (a session can hop node/device, D916).
    const placement = trackPlacementOf(frame, producerNodeId)
    for (const t of result.tracked) {
      // D683 review N2/R1: a closed id is already gone from `result.tracked`
      // by now (filtered right after `process()`, above) — this loop never
      // sees one.
      currentTrackIds.add(t.trackId)
      // A birth the gate rejected never re-enters the store, however long the
      // tracker keeps carrying it. Recording positions for it is what put a
      // suppressed phantom in the operator's track list.
      if (this.frameState.suppressedBirths.isRejected(key, t.trackId)) continue
      const center = {
        x: t.bbox.x + t.bbox.w / 2,
        y: t.bbox.y + t.bbox.h / 2,
      }
      // `t.label` is the enrichment label (identity / plate text) resolved by
      // the FrameProcessor, falling back to the raw detector class when it
      // differs from the macro class. Kept as the track's `label`.
      const upserted = this.trackStore!.upsert({
        trackId: t.trackId,
        deviceId,
        className: t.className,
        // A COASTED frame is not a sighting. The tracker carries a track for
        // `maxMissedMs` after its subject stops matching; those frames used to
        // append a position and advance `lastSeen` here, which is what put a
        // ~3.7 s phantom tail on 94% of person tracks and made a live subject
        // walking over a stale box look like a duplicate track. The capture
        // paths below already refuse them.
        matched: t.matchedThisFrame !== false,
        ...(t.labelPatch !== undefined ? { labelPatch: t.labelPatch } : {}),
        timestamp: result.timestamp,
        position: {
          x: center.x,
          y: center.y,
          timestamp: result.timestamp,
          bbox: { ...t.bbox },
          // WHICH PASS MEASURED THIS BOX (D399). `nativeRecovery` is mirrored
          // onto the tracked detection only when the track MATCHED a real
          // detection this frame, and only by the native second pass — so its
          // presence IS the provenance, and no second source of truth is
          // created. Before this field the answer had to be recovered from the
          // decimal expansion of the bbox.
          source: t.nativeRecovery !== undefined ? 'recovery' : 'frame',
          score: t.confidence,
        },
        zones: t.zones,
        state: t.state,
        ...(provenance !== undefined ? { provenance } : {}),
        ...(placement !== undefined ? { placement } : {}),
      })
      positionsCountById.set(t.trackId, upserted.positions.length)
    }

    // Zero-media policy (spec §"Zero-media track policy"): mark a track
    // CONFIRMED (sticky) the first frame it reaches the tracker's
    // hit-confirmation (`trackAge` = hits ≥ device minHits). Read ONLY at close
    // to protect a real-but-media-less track from false-birth suppression. Uses
    // the RAW tracker output (`rawTrackedDetections` carries `trackAge`; the
    // lightweight `tracked` shape does not).
    if (result.rawTrackedDetections.length > 0) {
      const { minHits } = await this.resolveDeviceDetectionSensitivitySettings(deviceId)
      for (const rt of result.rawTrackedDetections) {
        if (this.frameState.suppressedBirths.isRejected(key, rt.trackId)) continue
        if (rt.trackAge >= minHits) this.residents.markConfirmed(deviceId, rt.trackId)
      }
    }

    // Detect track start/end transitions vs previous frame. All logs are
    // deviceId-tagged so a single camera's tracking can be isolated.
    const log = this.ctx.logger.withTags({ deviceId })
    const prevIds = this.frameState.lastActiveTrackIds.get(key) ?? new Set<string>()
    // Track first-frames captured from the detection-pipeline frame (boxed).
    // Collected here, flushed in ONE dispatcher call below so the frame is
    // resolved once. Falls back to the snapshot canvas when no frame is present.
    const firstFrameTargets: TrackFrameTarget[] = []
    let newTrackCount = 0
    // Births: classify every fresh id, re-offer the deferred ones, and run the
    // confirmation gate over them — `birth/birth-candidates.ts`.
    const { bornCandidates, exhaustedIds, withBirthEvidence, sessionDetector, run } =
      await this.birthCandidates.collectAndConfirm({
        deviceId,
        source,
        key,
        log,
        frame,
        frameHandle,
        result,
        prevIds,
        currentTrackIds,
        positionsCountById,
      })
    const outcome = run.outcome

    const gateNowMs = Date.now()

    for (const { id, t } of bornCandidates) {
      // The verdict — deferral, late-verdict guards, the D409 ledger row and
      // the suppression — `birth/birth-verdict.ts`. Only a born track goes on.
      const born = this.birthVerdict.resolve({
        id,
        t,
        deviceId,
        source,
        key,
        log,
        frameHandle,
        result,
        processor,
        outcome,
        run,
        exhaustedIds,
        withBirthEvidence,
        sessionDetector,
        gateNowMs,
      })
      if (!born) continue
      newTrackCount += 1
      // Phantom-person measurement (NOT suppression). A person born with its
      // box inside a vehicle's is usually a parked car's window pillar; it is
      // also, sometimes, a person leaning on the car — so the detection stands
      // and only the RATE is recorded. Hand-counted on 2026-08-28: 4 of 23
      // person births on camera 102 in two hours, with nothing to check that
      // against next time. Every person birth is the denominator; the
      // containment test is the numerator. Costs one pass over this frame's
      // tracked list per person birth, no IO, no log line.
      if (t.className === 'person') {
        const overlap = personOverVehicle(
          t.bbox,
          result.tracked
            .filter((other) => other.trackId !== id)
            .map((other) => ({ className: other.className, bbox: other.bbox })),
        )
        this.failureReport.notePersonBirth(
          deviceId,
          overlap === null ? undefined : REASON_PERSON_OVER_VEHICLE,
        )
      }
      this.frameState.startedBirths.markStarted(key, id)
      log.info('track started', {
        meta: { trackId: id, className: t.className, source },
      })
      // S1: open the track's resident record at birth (idempotent — every
      // resident mutator also auto-opens, so deviceId always travels).
      this.residents.open(deviceId, id)
      // Capture the track's first full frame from the DECODED frame only.
      // No snapshot fallback — images must always come from decoded frames,
      // never the snapshot cap (a track with no shm frame gets no firstFrame).
      if (this.eventMediaDispatcher) {
        // DEFECT A (FIX): mark this CONFIRMED birth as still-needing a firstFrame
        // and seed the periodic clocks UNCONDITIONALLY (dispatcher present) — do
        // NOT gate them on `frameHandle`. A track born on a handle-less frame
        // (decode/retained-frame starvation) otherwise permanently forfeited its
        // firstFrame: the pending flag was never set, so `collectFirstFrameRetries`
        // never fired even once LATER frames DID carry a handle. Seeding here means
        // the first later matched+handled frame recovers the firstFrame. Suppressed
        // / unconfirmed births never reach this line (the `confirmedBirths` gate +
        // resurrection pre-pass above), so they never enter the pending set.
        this.residents.markFirstFramePending(deviceId, id)
        // Seed the periodic-snapshot clock so the first `snapshot` fires one
        // snapshotIntervalMs AFTER start (the firstFrame covers the start).
        // Seed the movement-gate reference with the start bbox too.
        this.trackStore!.seedSnapshotClock(id, result.timestamp, t.bbox)
        // Seed the rolling-lastFrame clock to the BIRTH timestamp as well.
        // Without this seed `lastFrameAt` defaults to 0, so the FIRST eligible
        // non-snapshot frame — the BIRTH frame itself — rolls a `lastFrame` from
        // the SAME frame handle + bbox + timestamp as the `firstFrame`, producing
        // a byte-identical `lastFrame` (firstFrame === lastFrame). Seeding it here
        // (mirroring the snapshot clock) means the rolling `lastFrame` cannot fire
        // until one interval AFTER birth, so it is always a DISTINCT later frame
        // (or absent for a track that dies within one interval — correct: there is
        // no meaningfully-different last frame to store).
        this.residents.setLastFrameAt(deviceId, id, result.timestamp)
        // The IMMEDIATE birth-frame firstFrame target is gated on the handle AND
        // on the frame being one the subject was OBSERVED in. The handle leg is
        // the old one — a handle-less birth simply has no frame to crop THIS
        // frame. The COASTED leg is new (2026-09-08): a confirmation gate that
        // deferred this birth releases it on whatever frame it is holding, and
        // for a short track that is routinely a frame the tracker is coasting
        // through — which stamped the "primo" tile after the track's own
        // `lastSeen` and cut it from a scene the subject had left. Either way
        // the pending flag above ensures a later matched+handled frame retries
        // (D58 untouched); only THIS dispatch is withheld.
        const birthCapture = decideBirthFirstFrameCapture({
          hasFrameHandle: frameHandle !== undefined,
          matchedThisFrame: t.matchedThisFrame,
        })
        if (birthCapture.capture) {
          firstFrameTargets.push({
            trackId: id,
            timestamp: result.timestamp,
            bbox: { ...t.bbox },
            ...(patchDisplayLabel(t.labelPatch) !== undefined
              ? { label: patchDisplayLabel(t.labelPatch) }
              : {}),
          })
        } else {
          // A branch that DROPS work says so. The birth firstFrame was silent
          // on both legs before this, which is why an inversion had to be found
          // by eye on the operator's own track list.
          log.info('birth firstFrame not captured — retry armed', {
            tags: { deviceId },
            meta: {
              trackId: id,
              className: t.className,
              source,
              refusedBecause: birthCapture.refusedBecause,
              // How far the confirmation gate deferred this birth. The number
              // that says whether the refusal is the gate's deferral running
              // past the subject, or something else.
              deferredMs:
                result.timestamp - (this.trackStore?.peekActive(id)?.firstSeen ?? result.timestamp),
            },
          })
        }
      }
      // Deprecated thin alias — kept briefly (no known subscribers).
      this.ctx.eventBus.emit({
        id: `pa-${randomUUID()}`,
        timestamp: new Date(result.timestamp),
        source: {
          type: 'addon',
          id: 'pipeline-analytics',
          addonId: 'pipeline-analytics',
        },
        category: EventCategory.PipelineAnalyticsTrackStarted,
        data: { deviceId, trackId: id, className: t.className },
      })
      // Unified lifecycle event — `phase:'start'`. Best = the first
      // (possibly low-quality) detection. Seed the update-gate memory so a
      // subsequent `update` is measured against this baseline + debounced.
      const startPayload = buildTrackLifecyclePayload({
        deviceId,
        trackId: id,
        phase: 'start',
        classes: [t.className],
        bestClassName: t.className,
        bestConfidence: t.confidence,
        firstSeen: result.timestamp,
        lastSeen: result.timestamp,
        ...(patchDisplayLabel(t.labelPatch) !== undefined
          ? { label: patchDisplayLabel(t.labelPatch) }
          : {}),
      })
      this.emitTrackLifecycle(startPayload, result.timestamp)
      this.residents.setLifecycleUpdateMem(deviceId, id, {
        lastConfidence: t.confidence,
        lastEmitAt: result.timestamp,
        ...(patchDisplayLabel(t.labelPatch) !== undefined
          ? { lastLabel: patchDisplayLabel(t.labelPatch) }
          : {}),
        lastBboxArea: t.bbox.w * t.bbox.h,
      })
    }
    // Tracks that dropped out of the active set this frame — the per-frame
    // "lost" signal (distinct from the durable TTL-driven `track ended` in
    // sweepExpiredTracks). Frequent loss+restart of ids = tracker churn.
    let lostTrackCount = 0
    for (const id of prevIds) {
      if (!currentTrackIds.has(id)) {
        lostTrackCount += 1
        log.info('track lost', {
          tags: { deviceId },
          meta: { trackId: id, source },
        })
      }
    }
    this.birthCandidates.retainBirths(key, currentTrackIds)
    this.frameState.lastActiveTrackIds.set(key, currentTrackIds)
    // A rejected birth is a track that never existed: no later reader of this
    // frame may do media / best-shot / park / detail work for it. The tracker
    // keeps carrying the id, and `residents.close(…,'prune')` already ran at
    // the rejection — work done here would be refused (or, before the
    // tombstone was honoured, re-create a resident nothing ever closes).
    const rejectedThisFrame = this.birthCandidates.rejectedThisFrame(deviceId, key, log, result)
    // Events are judged on their OWN trackId, never through `tracked`: a
    // `leaving` / zone-exit event names an id that is absent from this frame by
    // definition — the frame the tracker loses it, or later — and `retain`
    // above has already moved that id out of the live set. Cam 101,
    // 2026-10-21: a suppressed person→animal birth's `leaving` events slipped
    // through exactly there and fired a person rule.
    const keptObjectEvents = this.birthCandidates.dropSuppressedBirthEvents(
      deviceId,
      key,
      result.objectEvents,
    )
    const keptAppearanceEvents = this.birthCandidates.dropSuppressedBirthEvents(
      deviceId,
      key,
      result.appearanceEvents,
    )
    if (
      rejectedThisFrame.size > 0 ||
      keptObjectEvents !== result.objectEvents ||
      keptAppearanceEvents !== result.appearanceEvents
    ) {
      result = {
        ...result,
        tracked: result.tracked.filter((t) => !rejectedThisFrame.has(t.trackId)),
        rawTrackedDetections: result.rawTrackedDetections.filter(
          (rt) => !rejectedThisFrame.has(rt.trackId),
        ),
        objectEvents: keptObjectEvents,
        appearanceEvents: keptAppearanceEvents,
      }
    }
    // Motion-activity mirror for the audio-marker gate. Stamped only when
    // something is genuinely alive — an empty set must let the quiet window
    // start running, not keep refreshing it.
    if (currentTrackIds.size > 0) this.frameState.lastTrackActivityMs.set(deviceId, Date.now())

    // Stationary-object EVIDENCE (pipeline plane only). Occasion A: while a
    // motion session is running the pipeline is already decoding and already
    // inferring, so every sighting of a stopped object is a confirmation at
    // zero marginal cost. Each tracked object contributes ONE observation per
    // frame to the ledger; the ledger decides, on repetition, whether the same
    // thing keeps being seen in the same place. Nothing here judges how long a
    // TRACK survived — that criterion rewarded objects seen well and often,
    // which is exactly backwards (see `stationary-evidence.ts`).
    const stationarySettings = this.stationarySettingsFromCache(deviceId)
    // Classes the DEDICATED package path owns — excluded below so one parcel
    // can never produce two entries.
    const packageSettings = this.packageDropSettingsFromCache(deviceId)
    const packageClasses = new Set<string>(packageSettings.packageDropClassFilter)
    if (
      planeRunsStationary(source) &&
      this.stationaryRegistry &&
      this.stationaryEvidence &&
      stationarySettings.enabled
    ) {
      const evidence = this.stationaryEvidence
      for (const t of result.tracked) {
        if (packageClasses.has(t.className)) continue
        // A coasted frame is not a sighting: the detector saw nothing where
        // this box is, and it counts neither for N nor for M (D508).
        if (!trackOffersEvidence(t)) continue
        const active = this.trackStore?.peekActive(t.trackId) ?? null
        const observedLabel = active === null ? undefined : displayLabel(active)
        const observedKeyFrame = this.residents.keyFrameMediaId(t.trackId)
        // The stillness verdict, by OCCASION: the tracker's own `TrackState`
        // on a session frame; none on a burst, where the runner's motion gate
        // — which admits a recheck only while the scene is still — is the
        // authority (`stillnessVerdictFor`).
        const movementState = stillnessVerdictFor(occasion, t.state)
        const observation: StationaryObservation = {
          deviceId,
          className: t.className,
          bbox: { ...t.bbox },
          timestamp: result.timestamp,
          // The occasion the RUNNER named, not a constant. Every observation
          // used to be filed as `'session'`, so `burstAgreed` was structurally
          // zero on the whole fleet and "is the recheck earning its keep on
          // this camera?" had no answer at all. (And then, from 2026-09-14 to
          // 09-16, the runner filed every LIVE frame as `'burst'` — the
          // tallies looked alive and meant the opposite.)
          source: occasion,
          trackId: t.trackId,
          // The frame the candidate's box is judged against — the artifact
          // rule lives inside the verdict now, so the ledger needs it.
          frameWidth: result.frameWidth,
          frameHeight: result.frameHeight,
          ...(observedKeyFrame !== undefined ? { keyFrameMediaId: observedKeyFrame } : {}),
          ...(observedLabel !== undefined ? { label: observedLabel } : {}),
          ...(movementState !== undefined ? { movementState } : {}),
          // Settled but not yet decided (D547): the ledger folds it as neither
          // an agreement nor a dilution.
          settling: t.settling,
        }
        const outcome = evidence.observe(observation)
        if (outcome === undefined || !outcome.promoted) continue
        this.birthStationaryFromEvidence({
          deviceId,
          key,
          processor,
          track: t,
          row: outcome.row,
          frameWidth: result.frameWidth,
          frameHeight: result.frameHeight,
          timestamp: result.timestamp,
          firstSeen: active === null ? outcome.row.firstAgreedAt : active.firstSeen,
        })
      }
      // A binding that outlives its track would keep diluting a candidate with
      // an M it can never raise again. The tracker's live set is the authority.
      evidence.retainTracks(deviceId, currentTrackIds)
    }

    // The DEDICATED package promotion path — see `PackageStillnessTracker`.
    // Runs on EVERY pipeline frame (an empty sighting list is meaningful: it
    // advances the observed clock without confirming anything), and is
    // deliberately NOT gated on the stationary registry's master toggle, which
    // governs parked cars.
    if (planeRunsStationary(source)) {
      this.runPackageStillness({
        deviceId,
        tracked: result.tracked,
        packageClasses,
        packageZoneIds: collectPackageZoneIds(proxy?.state.zoneRules.value?.package ?? []),
        packageRules: proxy?.state.zoneRules.value?.package ?? [],
        zones: proxy?.state.zones.value?.zones ?? [],
        settings: packageSettings,
        frameHandle: frameHandle ?? null,
        frameWidth: result.frameWidth,
        frameHeight: result.frameHeight,
        timestamp: result.timestamp,
        frame,
      })
    }

    // Two-plane detail scheduling: drive the per-track detail dispatcher off the
    // announced child steps (`detailSteps`, present only on the pipeline plane).
    // A new track kicks its immediate (new-track) requests; an ongoing track
    // refreshes its freshest frame and fires `improve`-cadence steps when its
    // detector confidence strictly improves. The dispatcher owns concurrency +
    // cadence; all payload routing flows back through `routeDetailResults`.
    if (this.detailDispatcher && detailSteps && detailSteps.length > 0) {
      const dispatcher = this.detailDispatcher
      const steps = detailSteps
      for (const t of result.tracked) {
        const detailFrame: TrackDetailFrame = {
          bbox: { ...t.bbox },
          frameWidth: result.frameWidth,
          frameHeight: result.frameHeight,
          className: t.className,
          confidence: t.confidence,
          timestamp: result.timestamp,
          // Whether the subject was OBSERVED in this frame (D397). The
          // dispatcher refuses to associate a track with a frame it coasted
          // through — the same media-eligibility rule `buildSnapshotTargets`,
          // `collectFirstFrameRetries` and the raster-fallback retention loop
          // already apply. Carried rather than filtered here so the invariant
          // lives with the consumer that must honour it, and so a future
          // caller of the dispatcher inherits it.
          ...(t.matchedThisFrame !== undefined ? { matchedThisFrame: t.matchedThisFrame } : {}),
          ...(frameHandle !== undefined ? { frameHandle, nodeId: frameHandle.nodeId } : {}),
          // D730: the boxes the root model drew inside this subject — a crop
          // step the root supplies reads them instead of inferring.
          ...(t.rootChildBoxes !== undefined ? { rootChildBoxes: t.rootChildBoxes } : {}),
        }
        if (prevIds.has(t.trackId)) {
          dispatcher.onFrame(deviceId, t.trackId, steps, detailFrame, result.timestamp)
        } else {
          dispatcher.onTrackStarted(
            deviceId,
            t.trackId,
            t.className,
            steps,
            detailFrame,
            result.timestamp,
          )
        }
      }
    }

    // A track born ON TOP of a live track of another class. Two cases have
    // been paid for: a person on a bicycle split into `vehicle` + `person`
    // (07:06:54 and 07:07:13, the second living entirely inside the first),
    // and a person with a dog folded into ONE track whose `animal` label was
    // then refused. Both were seen; neither left a record that the two
    // subjects were TOGETHER. This is that record — a measurement only, so the
    // question can be settled on counts rather than on two anecdotes.
    {
      const bornBoxes = result.tracked
        .filter((t) => !prevIds.has(t.trackId))
        .map((t) => ({ trackId: t.trackId, className: t.className, bbox: t.bbox }))
      if (bornBoxes.length > 0) {
        const liveBoxes = result.tracked.map((t) => ({
          trackId: t.trackId,
          className: t.className,
          bbox: t.bbox,
        }))
        for (const pair of findCoMovingPairs(bornBoxes, liveBoxes)) {
          this.ctx.logger.info('co-moving subjects: a birth lands on another class', {
            tags: { deviceId },
            meta: {
              trackId: pair.trackId,
              className: pair.className,
              otherTrackId: pair.otherTrackId,
              otherClassName: pair.otherClassName,
              iou: Number(pair.iou.toFixed(3)),
              containment: Number(pair.containment.toFixed(3)),
            },
          })
        }
      }
    }

    // Per-frame pipeline summary — the primary churn diagnostic: many new/lost
    // tracks per frame means the tracker is ID-switching; `objectEvents` is how
    // many transitions became persisted events this frame. Logged at info ONLY
    // when something notable happens (a track appeared/disappeared or an event
    // was emitted), so a steady scene with stable tracks stays quiet while
    // churn is fully visible without enabling debug.
    if (
      newTrackCount > 0 ||
      lostTrackCount > 0 ||
      result.objectEvents.length > 0 ||
      result.appearanceEvents.length > 0
    ) {
      const byState: Record<string, number> = {}
      for (const t of result.tracked) byState[t.state] = (byState[t.state] ?? 0) + 1
      log.info('frame processed', {
        meta: {
          source,
          detections: frame.detections.length,
          tracked: result.tracked.length,
          newTracks: newTrackCount,
          lostTracks: lostTrackCount,
          objectEvents: result.objectEvents.length,
          appearanceEvents: result.appearanceEvents.length,
          byState,
        },
      })
    }

    // Persist object events in parallel. Appearance events (Requirement 1) are
    // persisted alongside so they participate in the per-track bestEventId
    // ranking (peakForTrack) + the events/gallery surface — but they are kept
    // OUT of the notification-bus emit below (they must never change
    // notification volume).
    const objectEvents = await this.persistObjectEvents(deviceId, result.objectEvents)
    const appearanceEvents = await this.persistObjectEvents(deviceId, result.appearanceEvents)

    // Notification Center immediate-rule hook (D-2): fired in the SAME
    // persist moment as the durable insert above. Appearance events stay
    // OUT (they must never change notification volume — same contract as
    // the notification-bus emit). Non-blocking for the frame path; the
    // center's outbox + boot reconcile own the loss semantics (D8).
    if (this.notificationCenter !== null) {
      const overlaps = processor.getLastZoneOverlaps()
      const rejections = processor.getLastZoneRejections()
      for (const e of objectEvents) {
        // An event carrying zones is the only kind a zone-scoped notification
        // rule can match, so this is where "how far inside was it?" has to be
        // answerable. The engine computed the fractions and the pipeline used
        // to discard them, which is why the bar was unchoosable from data.
        // Bounded by EVENT rate, not frame rate.
        if (e.zones && e.zones.length > 0) {
          const m = e.trackId ? overlaps.get(e.trackId) : undefined
          this.ctx.logger.info('zone membership stamped on event', {
            tags: { deviceId },
            meta: {
              eventId: e.id,
              trackId: e.trackId,
              className: e.className,
              minOverlap: trk.zoneMembershipMinOverlap,
              zones: (m ?? []).map((z) => ({
                id: z.zoneId,
                name: z.zoneName,
                overlapPct: Math.round(z.overlap * 1000) / 10,
              })),
            },
          })
        }
        // The bar DROPS a zone silently, and raising it therefore silences the
        // line above for exactly the events it was armed to measure: no zone
        // stamped, no log, and the absence reads as "nothing came near the
        // zone". Naming the rejected fractions is what keeps the bar
        // re-choosable AFTER it has been raised. Bounded by event rate, and
        // only for events that actually touched a zone.
        const rejected = e.trackId ? rejections.get(e.trackId) : undefined
        if (rejected !== undefined && rejected.length > 0) {
          this.ctx.logger.info('zone membership REJECTED by the bar', {
            tags: { deviceId },
            meta: {
              eventId: e.id,
              trackId: e.trackId,
              className: e.className,
              minOverlap: trk.zoneMembershipMinOverlap,
              stamped: e.zones?.length ?? 0,
              zones: rejected.map((z) => ({
                id: z.zoneId,
                name: z.zoneName,
                overlapPct: Math.round(z.overlap * 1000) / 10,
              })),
            },
          })
        }
        this.notificationCenter.onObjectEventPersisted(e)
      }
    }

    // Per-track CLIP image embeddings (best-confidence per track). Only vectors
    // whose model carries CLIP metadata are stored here (D649) — arcface
    // embeddings land in the face-recognizer path.
    //
    // UNIFICATION (Step 2-3): the best-per-track DECISION is routed through the
    // shared `TrackBestSelector`, so a NEW best drives ONE tight object-crop
    // capture whose media key is written onto the embedding row (→ a search hit's
    // thumbnail IS the embedded crop). The cross-restart persistence gate stays
    // in `ObjectEmbeddingStore.upsertIfBetter` (in-memory selector resets on
    // restart; the store keeps the durable best — see R3). `observe` runs here,
    // synchronously; the crop capture + upsert are issued below in the live-frame
    // window (so the shm handle is still valid).
    const objectEmbeddingBests: TrackedDetectionOut[] = []
    if (this.objectEmbeddingStore) {
      for (const t of result.tracked) {
        if (!isClipObjectEmbedding(t)) continue
        const isNewBest = this.residents.observeObjectEmbeddingBest(deviceId, {
          trackId: t.trackId,
          confidence: t.confidence,
          atMs: result.timestamp,
          className: t.className,
          bbox: t.bbox,
          embedding: t.embedding,
          embeddingModelId: t.embeddingModelId,
        })
        if (isNewBest) objectEmbeddingBests.push(t)
      }
    }

    // Event/track media FROM the detection-pipeline DECODED frame: a crop +
    // boxed full-frame per object event and a boxed first-frame per new track.
    // The dispatcher resolves the shm frame ONCE for all targets — so it runs
    // immediately here, while the handle is still live (frames recycle in ms).
    // No decoded frame (e.g. native/onboard source) → NO image is produced;
    // images must never come from the snapshot cap.
    // Resolve face-recognition and media settings BEFORE the frame-media reads,
    // so the recognizer's crop read below is issued in the SAME synchronous window
    // as the dispatcher — no I/O await between them that could let the shm handle
    // recycle (frames recycle in ms). Cache hit on the vast majority of frames.
    const faceSettings = this.faceRecognizer ? await this.resolveDeviceFaceSettings(deviceId) : null
    // GLOBAL master switch only (default on). Per-camera face production is
    // governed by the device's detection-pipeline steps, so there is no
    // per-device enable gate here.
    const faceGloballyEnabled = this.faceRecognizer ? await this.resolveGlobalFaceEnabled() : false
    // Always resolved (TTL-cached, near-zero cost) so cropPadding is available
    // to both the dispatcher and the recognizer without null-handling at each site.
    const mediaSettings = await this.resolveDeviceMediaSettings(deviceId)

    if (this.eventMediaDispatcher && frameHandle) {
      // Join ObjectEvent → face/plate detail crops via IoU spatial match.
      // trackId/sourceId are NOT available on raw frame.detections (trackId is
      // assigned by the tracker downstream and never back-written onto
      // frame.detections), so we match each event bbox to the first-level
      // detection with the highest IoU (threshold 0.3) and inherit its children.
      // Appearance events share the SAME current-frame crop path as regular
      // object events (Requirement 1) — so a valued passer-by gets a real crop.
      const mediaEvents = [...objectEvents, ...appearanceEvents]
      const childCropsByEvent = buildEventChildCrops(mediaEvents, frame.detections)

      // Only a positive-area box in THIS frame gets media. A `state:'left'`
      // departure event is emitted for a track that has left the active set:
      // the frame-processor now omits its `bbox` entirely (it used to stamp a
      // degenerate `{0,0,0,0}`, and cropping that clamps to a 1×1 pixel which
      // `writeEventMedia` upsizes to a uniform ~1648-byte 640×360 JPEG).
      // Either way there is no object in-frame to crop — but the refusal is
      // now SAID, per camera. A branch that drops work silently reads as
      // "never happened", and this one dropped every departure event's media
      // without a line.
      const uncroppable = mediaEvents.filter(
        (e) => e.bbox === undefined || e.bbox.w <= 0 || e.bbox.h <= 0,
      )
      if (uncroppable.length > 0) {
        this.ctx.logger.debug(
          'event media: no crop for events with no box in this frame (a departed track has nothing to cut)',
          {
            tags: { deviceId },
            meta: {
              events: uncroppable.length,
              states: [...new Set(uncroppable.map((e) => e.state ?? 'unknown'))],
              zeroArea: uncroppable.filter((e) => e.bbox !== undefined).length,
            },
          },
        )
      }
      const eventTargets: EventMediaTarget[] = mediaEvents
        .filter((e) => e.bbox !== undefined && e.bbox.w > 0 && e.bbox.h > 0)
        .map((e) => {
          const childCrops = childCropsByEvent.get(e.id)
          return {
            // A media OWNER id, and it lands in a media key — text (D474).
            eventId: String(e.id),
            timestamp: e.timestamp,
            bbox: e.bbox!,
            className: e.className,
            ...(typeof e.confidence === 'number' ? { confidence: e.confidence } : {}),
            ...(displayLabel(e) !== undefined ? { label: displayLabel(e) } : {}),
            ...(childCrops && childCrops.length > 0 ? { childCrops } : {}),
          }
        })
      // Per-device media-capture step log: how many event crops/boxed frames
      // and face/plate child crops the IoU join produced this frame. This is the
      // primary diagnostic for the detail-media pipeline — `faceCrops`/`plateCrops`
      // at 0 while persons/plates are present points at the event→detection join.
      let faceCrops = 0
      let plateCrops = 0
      for (const crops of childCropsByEvent.values()) {
        for (const c of crops) {
          if (c.kind === 'faceCrop') faceCrops += 1
          else plateCrops += 1
        }
      }

      // §5 snapshot cadence — periodic per-track media from the SAME decoded
      // frame (no camera round-trip). Three destinations, each gated:
      //  • `snapshot`  — appended timeline filmstrip, one per snapshotIntervalMs,
      //  • `lastFrame` — single rolling overwrite (newest view at track end),
      //  • `thumbnail` — single best (highest-confidence) frame, hysteresis-gated.
      const snapshotTargets = this.snapshotTargets.buildSnapshotTargets(
        deviceId,
        result.tracked,
        result.timestamp,
        mediaSettings,
        result.frameWidth,
        result.frameHeight,
        frameHandle,
      )

      // DEFECT A: re-schedule a `firstFrame` for every confirmed-birth track
      // whose birth capture never landed (still pending) and that is observed
      // (matched) this frame — the analog of the #27-A thumbnail retry. Stamped
      // with THIS frame's real timestamp (the earliest AVAILABLE view still
      // beats no firstFrame at all). Guarded by the scheduler's firstFrame
      // hold key so at most one capture is outstanding per track.
      for (const retry of this.snapshotTargets.collectFirstFrameRetries(
        deviceId,
        result.tracked,
        result.timestamp,
        firstFrameTargets,
      )) {
        firstFrameTargets.push(retry)
      }

      // FIX B (widened, computed BEFORE the media-target guard): retain ONE
      // last-resort detection-raster crop for ANY confirmed track observed
      // (matched) this frame that still has none — not only tracks with a
      // firstFrame/snapshot target. A confirmed track can reach close media-less
      // (every native write dropped, or it never earned a target — e.g. a
      // resurrected track) and would then render a BLANK reel tile. Computed here
      // (outside the guard) so a confirmed track observed on a TARGET-LESS frame
      // still gets its fallback retained — closing the residual zero-media gap.
      // Cut from the already-copied `frameData` (robust even when native drops),
      // committed only at close if the track is still media-less. Bounded
      // one-per-track (first wins) + honest sub-native (extract-only, never
      // upscaled). Targets already carrying the bbox are deduped by the dispatcher.
      const targetedThisFrame = new Set<string>([
        ...firstFrameTargets.map((t) => t.trackId),
        ...snapshotTargets.map((s) => s.trackId),
      ])
      const rasterFallbackCandidates: RasterFallbackCandidate[] = []
      const widenedRasterWantedIds = new Set<string>()
      for (const t of result.tracked) {
        // A coasted/stale box (subject not observed this frame) would crop the
        // empty scene — only retain from a REAL observation.
        if (t.matchedThisFrame === false) continue
        const closure = this.residents.closure(t.trackId)
        if (!closure?.confirmed) continue
        if (closure.rasterFallback) continue
        if (targetedThisFrame.has(t.trackId)) continue
        widenedRasterWantedIds.add(t.trackId)
        rasterFallbackCandidates.push({
          trackId: t.trackId,
          timestamp: result.timestamp,
          bbox: { ...t.bbox },
        })
      }

      if (
        eventTargets.length > 0 ||
        firstFrameTargets.length > 0 ||
        snapshotTargets.length > 0 ||
        widenedRasterWantedIds.size > 0
      ) {
        const captureCounts = {
          events: eventTargets.length,
          trackFrames: firstFrameTargets.length,
          snapshots: snapshotTargets.length,
          faceCrops,
          plateCrops,
        }
        log.debug('media capture', { meta: { source, ...captureCounts } })
        const captureAgg = this.mediaCaptureLog.note(deviceId, captureCounts, Date.now())
        if (captureAgg !== null) {
          log.info('media capture (window)', {
            meta: {
              source,
              windowSec: Math.round(captureAgg.windowMs / 1000),
              frames: captureAgg.frames,
              ...captureAgg.sums,
            },
          })
        }
        // RC-1 → S3: the per-track in-flight gates are now scheduler-owned
        // keys. The batch dispatch below HOLDS one `device:kind:track` key per
        // thumbnail / firstFrame / rolling-lastFrame it covers while it is
        // queued or running, so the next frame's buildSnapshotTargets /
        // collectFirstFrameRetries (which consult `isKeyActive`) suppress a
        // duplicate capture until THIS dispatch settles — released
        // unconditionally on settle (whether or not the media landed); the
        // land-only bookkeeping (pending clear / clock advance) runs in `.then`.
        const heldCaptureKeys: string[] = [
          ...snapshotTargets
            .filter((t) => t.bestThumbnail)
            .map((t) => captureCoalesceKey(deviceId, 'thumbnail', t.trackId)),
          ...firstFrameTargets.map((t) => captureCoalesceKey(deviceId, 'firstFrame', t.trackId)),
          ...snapshotTargets
            .filter((t) => t.rollingLastFrame)
            .map((t) => captureCoalesceKey(deviceId, 'lastFrame', t.trackId)),
        ]
        // The frame timestamp the rolling `lastFrame` clock advances to on a
        // landed write (all targets in this dispatch share it).
        const dispatchTimestamp = result.timestamp
        // Zero-media raster fallback wanted set: the widened confirmed-track ids
        // (computed above, outside the guard) UNION every track with a target this
        // frame that has no retained fallback yet. The dispatcher cuts ONE clean
        // detection-raster subject crop per wanted track (returned, not persisted),
        // bounded to one per track for its whole life — retained below, committed
        // only at close if the track ends media-less.
        const rasterFallbackWantedTrackIds = new Set<string>(widenedRasterWantedIds)
        for (const t of firstFrameTargets) {
          if (!this.residents.closure(t.trackId)?.rasterFallback) {
            rasterFallbackWantedTrackIds.add(t.trackId)
          }
        }
        for (const s of snapshotTargets) {
          if (!this.residents.closure(s.trackId)?.rasterFallback) {
            rasterFallbackWantedTrackIds.add(s.trackId)
          }
        }
        // S3: the whole batched dispatch is ONE scheduler request (kind derived
        // from its highest-priority content) so it counts against the device's
        // capture budget. The land-only bookkeeping stays chained INSIDE the
        // exec so it still runs before the hold keys release, exactly like the
        // legacy `.then` → `.finally` order.
        const dispatcher = this.eventMediaDispatcher
        // PIN the ≤640 detection frame NOW, in the live-frame window (2026-07-23
        // boxed-tile regression fix): since S3 the whole batch below is ONE
        // scheduler request against the 3-slot device lane — under saturation it
        // queues and its exec starts SECONDS late, by which time the handle's
        // ring slot is recycled and the dispatcher's by-handle resolve returned
        // empty (firstFrame + snapshot + lastFrame all silently lost). The
        // resolve is issued synchronously here and the pixels are COPIED
        // (~0.7MB), so recycling can no longer touch them.
        // The copy lives as long as the QUEUED entry does, which is why this
        // request carries `staleAfterMs` like every other capture call site:
        // until 2026-08-25 it did not, and a queued batch could hold its pinned
        // frame for as long as the lane stayed saturated. Measured on the live
        // hub: `hub/pipeline-analytics` at rss=3911MB with heapUsed=153MB and
        // arrayBuffers=2281MB — 2.28 GB of pinned frames in a runner limited to
        // 1216 MB of heap. The scheduler now also caps queue depth, so the pin
        // really is bounded by the lane.
        // A genuine live-window miss leaves `pinnedFrame` null and the
        // dispatcher's by-handle resolve (now WARN-logged on failure) remains
        // the fallback.
        const pinnedFramePromise = dispatcher.resolvePinnedFrame(deviceId, frameHandle)
        void this.captureScheduler
          .request({
            deviceId,
            kind: deriveFrameDispatchKind({
              hasFirstFrame: firstFrameTargets.length > 0,
              hasThumbnail: snapshotTargets.some((t) => t.bestThumbnail),
              hasLastFrame: snapshotTargets.some((t) => t.rollingLastFrame),
              hasSnapshot: snapshotTargets.some((t) => t.appendSnapshot),
            }),
            holdKeys: heldCaptureKeys,
            // A batch whose pinned frame is this old has lost its reason to
            // exist: the media it would write is seconds behind the event.
            staleAfterMs: ENRICHMENT_CAPTURE_STALE_MS,
            exec: () =>
              pinnedFramePromise
                .then((pinnedFrame) => {
                  // The batch can start seconds after its tracks closed: a
                  // raster crop for a closed track would be composed (sharp)
                  // and then refused by the resident. Skip it up front.
                  const liveWanted = new Set<string>()
                  for (const id of rasterFallbackWantedTrackIds) {
                    if (this.residents.isLive(id)) liveWanted.add(id)
                  }
                  return dispatcher.captureForFrame({
                    deviceId,
                    frameHandle,
                    events: eventTargets,
                    trackFrames: firstFrameTargets,
                    snapshots: snapshotTargets,
                    cropPadding: mediaSettings.cropPadding,
                    rasterFallbackWantedTrackIds: liveWanted,
                    rasterFallbackCandidates: rasterFallbackCandidates.filter((c) =>
                      this.residents.isLive(c.trackId),
                    ),
                    ...(pinnedFrame !== null ? { pinnedFrame } : {}),
                  })
                })
                .then((res) => {
                  // Retain the FIRST detection-raster crop per track (zero-media
                  // fallback); a later frame never overwrites an existing one.
                  for (const rf of res.rasterFallbacks) {
                    this.residents.retainRasterFallback(deviceId, rf.trackId, {
                      jpeg: rf.jpeg,
                      timestamp: rf.timestamp,
                    })
                  }
                  // Wire appended snapshots onto the TrackStore so Track.snapshots
                  // references the persisted media (and lastSnapshotAt advances).
                  for (const s of res.storedSnapshots) {
                    this.trackStore?.addSnapshot(s.trackId, {
                      timestamp: s.timestamp,
                      position: {
                        x: s.bbox.x + s.bbox.w / 2,
                        y: s.bbox.y + s.bbox.h / 2,
                        timestamp: s.timestamp,
                        bbox: s.bbox,
                      },
                      mediaId: s.mediaId,
                    })
                  }
                  // #27-A: a track whose best thumbnail actually landed stops forcing
                  // per-frame retries (see buildSnapshotTargets / planPeriodicMedia).
                  for (const trackId of res.thumbnailTrackIds)
                    this.residents.markThumbnailLanded(deviceId, trackId)
                  // D400, the OUTCOME half of the promotion log: a promotion
                  // that fired and whose capture MISSED used to be
                  // indistinguishable from one that never fired — the operator
                  // sees an old best shot either way. Now the miss says so.
                  const landedThumbnails = new Set(res.thumbnailTrackIds)
                  for (const target of snapshotTargets) {
                    if (!target.bestThumbnail || landedThumbnails.has(target.trackId)) continue
                    log.warn('best shot capture did not land', {
                      tags: { deviceId },
                      meta: {
                        trackId: target.trackId,
                        timestamp: target.timestamp,
                        // The held peak advanced when the promotion was
                        // ACCEPTED; this capture was its only chance to become
                        // the picture, and it did not.
                        keyFrameRequested: target.keyFrame !== 'skip',
                      },
                    })
                  }
                  // DEFECT A: a track whose firstFrame actually persisted is no longer
                  // pending — the retry pass stops re-scheduling it. The landed flag
                  // is what lets a later RESUME distinguish "already have a first
                  // view" from "never captured one" (suppressed-birth recovery).
                  for (const trackId of res.firstFrameTrackIds) {
                    this.residents.clearFirstFramePending(trackId)
                    this.residents.markFirstFrameLanded(deviceId, trackId)
                  }
                  // DEFECT B: advance the rolling-`lastFrame` clock ONLY for tracks
                  // whose write actually landed. A dropped roll (recycled/blank frame)
                  // is absent here → the clock stays put and the roll retries on the
                  // next eligible non-snapshot frame (honouring "last ACTUALLY-written
                  // lastFrame"). Stamp with the dispatch frame's own timestamp.
                  for (const trackId of res.lastFrameTrackIds) {
                    this.residents.setLastFrameAt(deviceId, trackId, dispatchTimestamp)
                  }
                  // The same rule, finally applied to `snapshot` — the one kind that
                  // had no retry of any shape. Its gate was advanced SYNCHRONOUSLY at
                  // decision time (anti-burst, and that stays); a capture that did not
                  // land now gives the interval back so the next frame re-evaluates
                  // instead of waiting out an interval it never used. Bounded at
                  // SNAPSHOT_MAX_ROLLBACKS consecutive misses — see
                  // `pipeline/snapshot-retry.ts` (D60).
                  const landedSnapshots = new Set(res.storedSnapshots.map((s) => s.trackId))
                  for (const target of snapshotTargets) {
                    if (!target.appendSnapshot || landedSnapshots.has(target.trackId)) continue
                    const gaveBack = this.trackStore?.rollbackSnapshotPending(
                      target.trackId,
                      target.timestamp,
                    )
                    // A branch that DROPS work says so. This one was silent, and the
                    // 197 snapshots it lost in 3 h were found by counting rows, not
                    // by reading logs.
                    log.warn('snapshot capture did not land', {
                      tags: { deviceId },
                      meta: {
                        trackId: target.trackId,
                        timestamp: target.timestamp,
                        // false ⇒ the bounded retry budget is spent (or something
                        // newer already moved the gate): this slot is conceded.
                        intervalReturned: gaveBack === true,
                      },
                    })
                  }
                }),
          })
          .catch(() => {
            /* dispatcher logs its own failures; the scheduler released the
               hold keys on settle (the legacy `.finally` clears). */
          })
      }

      // Design B: capture ONE native-resolution KEY FRAME per track at its
      // best-detection moment (the SAME `bestThumbnail` signal that drives the
      // `thumbnail`), reusing the native-first `captureCrop` path. Decoupled
      // from the CLIP object-embedding path (which no longer runs on the root
      // frame under the two-plane pipeline and is disabled) so a native key
      // frame is produced for EVERY track, not only clip-embedded ones. Issued
      // in this live-frame window (no await separates this from the batch
      // dispatch above) so the decode worker's native lease is still held.
      // Best-effort (D8).
      //
      // ORDERING — keep this AFTER the batch dispatch above (2026-07-23
      // boxed-tile regression fix). `persistKeyFrames` issues up to N heavy
      // native-fetch execs that START SYNCHRONOUSLY while the lane has room;
      // issued FIRST they saturated the 3-slot device lane, so the batch
      // dispatch (priority-0 content: firstFrame) queued behind them and ran
      // seconds late on a recycled handle — every boxed tile lost. Scheduling
      // the batch first lets its priority-0 content claim a lane slot when
      // there is room. Only the SCHEDULING moved: `snapshotTargets` (whose
      // per-track `keyFrame` flags — `isNewBest` from `buildSnapshotTargets` —
      // feed `selectKeyFrameCaptures`) is computed above, unchanged. A
      // scheduler-ordering unit test is impractical (the order lives in this
      // handler pass, not in the scheduler) — this comment is the assertion.
      const keyFrameCaptures = selectKeyFrameCaptures(snapshotTargets)
      if (keyFrameCaptures.length > 0) {
        void this.mediaCapture.persistKeyFrames(deviceId, result.timestamp, keyFrameCaptures)
      }
    }
    // No `else` snapshot fallback: object events without a decoded frame
    // (e.g. native/onboard) get NO image. Images come ONLY from decoded frames,
    // never the snapshot cap.

    // Pre-resolved above (same synchronous window as captureForFrame) so the
    // crop read happens while the frame handle is still live.
    if (this.faceRecognizer && faceGloballyEnabled && faceSettings) {
      void this.faceRecognizer.processFrame({
        deviceId,
        timestamp: frame.timestamp,
        frameWidth: result.frameWidth,
        frameHeight: result.frameHeight,
        tracked: result.tracked,
        settings: faceSettings,
        cropPadding: mediaSettings.cropPadding,
        ...(frameHandle !== undefined ? { frameHandle } : {}),
      })
    }

    // Buffer the best plate read per vehicle track for the plate gallery (the
    // OCR text already rides on the event; this collects reads + crops for
    // review/grouping). Same live-frame window as captureForFrame.
    if (this.plateRecognizer) {
      void this.plateRecognizer.processFrame({
        deviceId,
        timestamp: frame.timestamp,
        frameWidth: result.frameWidth,
        frameHeight: result.frameHeight,
        tracked: result.tracked,
        cropPadding: mediaSettings.cropPadding,
        ...(frameHandle !== undefined ? { frameHandle } : {}),
      })
    }

    // Best-object-crop + CLIP embedding upsert (Step 3): capture the tight object
    // crop for each NEW best in this SAME live-frame window (shm still valid) and
    // persist the embedding with its crop's media key. Issued after the other
    // captures; the embedding is still upserted when no frame is available.
    if (objectEmbeddingBests.length > 0) {
      void this.enrichmentFanout.persistObjectEmbeddingBests(
        deviceId,
        result.timestamp,
        objectEmbeddingBests,
        frameHandle,
        result.frameWidth,
        result.frameHeight,
        mediaSettings.cropPadding,
      )
    }

    // Emit canonical detection-event notifications on the bus for each
    // persisted object event.
    for (const e of objectEvents) {
      this.ctx.eventBus.emit({
        id: `pa-${e.id}`,
        timestamp: new Date(e.timestamp),
        source: {
          type: 'addon',
          id: 'pipeline-analytics',
          addonId: 'pipeline-analytics',
        },
        category: EventCategory.PipelineAnalyticsDetectionEvent,
        // Enriched (flat) so consumers (advanced-notifier) can filter on
        // className / confidence / zones / source WITHOUT re-fetching the
        // persisted event by id. `zones` is an array (a detection can sit
        // in several zones); `source` is the multi-source discriminator.
        data: {
          deviceId,
          kind: 'object',
          eventId: e.id,
          timestamp: e.timestamp,
          source: e.source ?? source,
          className: e.className,
          confidence: e.confidence,
          zones: e.zones ?? [],
        },
      })
    }

    // Enriched frame emit for downstream stream overlays (two-plane
    // re-injection): roots pass through with track info + identity label;
    // face/plate details are synthesized from per-track overlay state.
    let overlayDetections: readonly ObjectDetection[]
    try {
      overlayDetections = buildOverlayDetections({
        frameDetections: frame.detections,
        tracked: result.tracked,
        overlayFor: (trackId) => this.overlayState.get(deviceId, trackId),
        // The overlay draws a CAPTION, so it takes the display value. A track
        // with both tiers renders the instance (`Turdus migratorius`), not the
        // sub-class it also knows.
        labelFor: (trackId) => {
          const t = this.trackStore?.getActiveByTrack(trackId)
          return t === undefined || t === null ? undefined : displayLabel(t)
        },
        // Date.now() is fine here (impure caller); the pure builder never reads
        // the clock — it only compares against each detail's capturedAt.
        nowMs: Date.now(),
      })
    } catch (err) {
      const now = Date.now()
      const lastWarnAt = this.frameState.overlaySynthesisWarnAt.get(deviceId) ?? 0
      if (now - lastWarnAt >= OVERLAY_SYNTHESIS_WARN_THROTTLE_MS) {
        this.frameState.overlaySynthesisWarnAt.set(deviceId, now)
        this.ctx.logger.warn('overlay synthesis failed — emitting unenriched frame detections', {
          tags: { deviceId },
          meta: { error: String(err) },
        })
      }
      overlayDetections = frame.detections
    }
    // PRESENCE flag for the orchestrator's on-motion session-hold: is a subject
    // still tracked on this frame AND still doing something. Deliberately NOT
    // derived from the track STATE — a `moving`-only predicate flaps on every
    // detector jitter (D261) — but from the same recent-window stillness metric
    // the key-event static gate uses.
    //
    // The stillness test is what STOPS the hold, and that is the only job it
    // has left. It used to also CREATE the stationary entry, and those are two
    // very different decisions: creating an entry blinds the pipeline to an
    // object (it needs repeated evidence, see `stationary-evidence.ts`), while
    // ending a hold destroys nothing — if it is wrong the session closes early
    // and the next motion re-opens it.
    //
    // Removing the first job WITHOUT keeping the second here is the trap: a
    // parked car would keep counting as present forever and pin every session
    // to `maxSessionHoldMs` (120 s). On 102 that is 504 sessions x 120 s = 70%
    // detection uptime on one camera, and 104/103/111 are already above 50%.
    //
    // `result.tracked` is also the post-suppression set: once an object has an
    // entry the registry filters its detections out before the tracker sees
    // them, so it stops appearing here at all.
    const stillnessConfig = {
      ...DEFAULT_SESSION_STILLNESS_CONFIG,
      windowMs: this.stationarySettingsFromCache(deviceId).sessionStillnessWindowMs,
    }
    const stillnessDims = this.frameState.lastFrameDimsByDevice.get(deviceId)
    const stillnessDiag =
      stillnessDims && stillnessDims.w > 0 && stillnessDims.h > 0
        ? Math.hypot(stillnessDims.w, stillnessDims.h)
        : 0
    const hasLiveTrack = result.tracked.some((t) => {
      const active = this.trackStore?.peekActive(t.trackId)
      // No recorded path is no evidence of stillness — count it as present.
      if (!active) return true
      return !trackIsStill({
        positions: active.positions,
        referenceDiagonalPx: stillnessDiag,
        now: result.timestamp,
        config: stillnessConfig,
      }).still
    })
    this.ctx.eventBus.emit({
      id: `pa-${randomUUID()}`,
      timestamp: new Date(result.timestamp),
      source: {
        type: 'addon',
        id: 'pipeline-analytics',
        addonId: 'pipeline-analytics',
      },
      category: EventCategory.PipelineAnalyticsFrameTracked,
      data: {
        deviceId,
        timestamp: result.timestamp,
        frameWidth: result.frameWidth,
        frameHeight: result.frameHeight,
        detections: overlayDetections,
        hasLiveTrack,
        // The tracker's own count, still subjects included — what the close
        // line reports as `liveTracks` (D652). Decides nothing.
        liveTrackCount: result.tracked.length,
      },
    })
  }

  /** S6: shared cold-miss loader for every per-device settings kind — the
   *  GLOBAL addon store under the device store, then the kind's pure resolve.
   *
   *  The cascade is device override > global value > schema default, resolved
   *  per field. The global half is NOT optional: the global settings page
   *  (`updateGlobalSettings`) writes the ADDON store, and until 2026-08-21
   *  this read consulted only the DEVICE store — so a device with no override
   *  silently ran on schema defaults and every global retune was a knob
   *  nobody at frame-time read (the operator's 0.45 face threshold ran at
   *  0.55; a 0.507-cosine face surfaced as a "51%" suggestion instead of
   *  auto-assigning — see `__tests__/global-settings-cascade.spec.ts`).
   *  `resolveGlobalStore()` is the sanctioned BaseAddon read (per-node
   *  projection applied; a raw `readAddonStore` would leak `@node` keys if a
   *  perNode field is ever declared).
   *
   *  Both raw reads go through `rawGlobalStoreMirror` / `rawDeviceBlobMirror`
   *  rather than straight to the store: this method is the ONE place all
   *  eight settings kinds funnel through on a cache miss, so calling the raw
   *  reads directly here means eight kinds expiring in the same window each
   *  pay for the same two reads — see `store/settings-raw-mirror.ts`. */
  /**
   * Insert the frame's object-event DRAFTS and return them with the id the
   * database actually assigned (D474).
   *
   * The frame path cannot name an event: the id is a SQLite rowid, minted by
   * the write. So this is the ONE place a draft becomes an `ObjectEvent`, and
   * everything downstream — the media targets, the notification-centre hook,
   * the bus emit — consumes what comes back rather than what went in.
   *
   * Order is preserved. A draft whose row did not land is DROPPED and SAID:
   * it owns no media, can be named on no bus and can match no rule, and an
   * invented id would put `event:NaN` in a media key. A branch that accepts
   * work and produces nothing must log it.
   */
  private async persistObjectEvents(
    deviceId: number,
    drafts: readonly ObjectEventDraft[],
  ): Promise<readonly ObjectEvent[]> {
    if (drafts.length === 0) return []
    const store = this.eventStore
    if (store === null) return []
    const ids = await Promise.all(drafts.map((d) => store.insertObject(d)))
    const persisted: ObjectEvent[] = []
    for (const [i, draft] of drafts.entries()) {
      const id = ids[i]
      if (id === undefined || id === null) continue
      persisted.push({ ...draft, id })
    }
    const lost = drafts.length - persisted.length
    if (lost > 0) {
      this.ctx.logger.warn('object events did not persist — no id, so no media, no bus, no rule', {
        tags: { deviceId },
        meta: {
          lost,
          of: drafts.length,
          trackIds: [...new Set(drafts.map((d) => d.trackId ?? 'none'))],
        },
      })
    }
    return persisted
  }

  private async readDeviceSettings<T>(deviceId: number, resolve: SettingsResolver<T>): Promise<T> {
    // `ctxIfReady`, not `ctx`: the getter THROWS outside the initialized
    // window, and a frame in flight during shutdown must resolve to defaults,
    // not become an unhandled rejection. The old `this.ctx?.` was a lie — the
    // getter never returns undefined.
    const globalRaw = this.ctxIfReady !== null ? await this.rawGlobalStoreMirror.resolve() : {}
    const deviceRaw = await this.rawDeviceBlobMirror.resolve(deviceId)
    return resolve({ ...globalRaw, ...deviceRaw })
  }

  /**
   * The addon's ONE read of its own per-device blob
   * (the shared per-device settings, D870).
   *
   * A chokepoint rather than six scattered `ctx.settings.readDeviceStore(…)`
   * calls, for two reasons that are the same reason: the census can name which
   * of the six is spending, and anything done about it is done once. On the
   * live hub this read ran 6 133 times a minute and found nothing 98% of the
   * time, and the `(op, collection)` the engine reports could not say which
   * reader that was.
   *
   * `rows` is counted as the number of FIELDS the blob carried, so a census
   * line distinguishes "read a real override" from "asked the disk whether one
   * exists" — which is the whole question here.
   */
  private async readDeviceBlob(deviceId: number): Promise<Record<string, unknown>> {
    const site = this.readCensus.siteOf(this.readDeviceBlob)
    const raw = (await this.ctxIfReady?.settings?.readDeviceStore(deviceId)) ?? {}
    this.readCensus.record('readDeviceStore', site, Object.keys(raw).length)
    return raw
  }

  /**
   * Read per-device audio-detection settings with a TTL cache so the store
   * is not hit on every ~30 Hz audio frame.
   */
  private async resolveDeviceAudioSettings(deviceId: number): Promise<AudioDetectionSettings> {
    return this.audioSettingsCache.get(deviceId, (id) =>
      this.readDeviceSettings(id, resolveAudioDetectionSettings),
    )
  }

  /**
   * Read per-device detection-sensitivity settings with a TTL cache so the
   * store is not hit on every inference frame (~30 Hz).
   */
  private async resolveDeviceDetectionSensitivitySettings(
    deviceId: number,
  ): Promise<DetectionSensitivitySettings> {
    return this.sensitivitySettingsCache.get(deviceId, (id) =>
      this.readDeviceSettings(id, resolveDetectionSensitivitySettings),
    )
  }

  private async resolveDeviceTrackingSettings(deviceId: number): Promise<TrackingSettings> {
    return this.trackingSettingsCache.get(deviceId, (id) =>
      this.readDeviceSettings(id, resolveTrackingSettings),
    )
  }

  /** Per-device confirmation-gate settings (default OFF), TTL-cached like the
   *  other per-device tunables. */
  private async resolveDeviceConfirmationGateSettings(
    deviceId: number,
  ): Promise<ConfirmationGateSettings> {
    return this.confirmationGateSettingsCache.get(deviceId, (id) =>
      this.readDeviceSettings(id, resolveConfirmationGateSettings),
    )
  }

  /**
   * The birth path — `birth/`. LAZY, like the media runners: `ctx` is not
   * assigned when field initialisers run, and the stores, the ledger and the
   * crop functions are opened in `onInitialize`, so those are read through
   * getters.
   */
  private birthGateInstance: BirthGate | null = null
  private birthLedgerInstance: BirthLedger | null = null
  private birthCandidatesInstance: BirthCandidates | null = null
  private birthVerdictInstance: BirthVerdict | null = null

  private get birthGate(): BirthGate {
    this.birthGateInstance ??= new BirthGate({
      ctx: () => this.ctx,
      frameState: this.frameState,
      captureScheduler: () => this.captureScheduler,
      captureCrop: () => this.captureCrop,
      captureDisplayCropFn: () => this.captureDisplayCropFn,
      phantomCells: () => this.phantomCells,
      resolveDeviceConfirmationGateSettings: (deviceId) =>
        this.resolveDeviceConfirmationGateSettings(deviceId),
      procKey: (deviceId, source) => this.procKey(deviceId, source),
    })
    return this.birthGateInstance
  }

  private get birthLedger(): BirthLedger {
    this.birthLedgerInstance ??= new BirthLedger({
      ctx: () => this.ctx,
      frameState: this.frameState,
      birthDecisionLedger: () => this.birthDecisionLedger,
    })
    return this.birthLedgerInstance
  }

  private get birthCandidates(): BirthCandidates {
    this.birthCandidatesInstance ??= new BirthCandidates({
      ctx: () => this.ctx,
      frameState: this.frameState,
      residents: this.residents,
      eventMediaDispatcher: () => this.eventMediaDispatcher,
      birthGate: () => this.birthGate,
      resolveDeviceConfirmationGateSettings: (deviceId) =>
        this.resolveDeviceConfirmationGateSettings(deviceId),
    })
    return this.birthCandidatesInstance
  }

  private get birthVerdict(): BirthVerdict {
    this.birthVerdictInstance ??= new BirthVerdict({
      frameState: this.frameState,
      trackStore: () => this.trackStore,
      mediaStore: () => this.mediaStore,
      birthLedger: () => this.birthLedger,
      offerDebugCrop: (input) => this.offerDebugCrop(input),
      clearLiveTrackState: (deviceId, trackId) => this.clearLiveTrackState(deviceId, trackId),
    })
    return this.birthVerdictInstance
  }

  // Called from processFrame — the GLOBAL face-recognition master switch (a
  // temporary kill for the whole subsystem). Read from the addon-level store
  // (NOT per-device — face production per camera is controlled by the device's
  // detection-pipeline steps). On by default. TTL-cached so the addon store is
  // not hit on every inference frame (~30 Hz).
  private async resolveGlobalFaceEnabled(): Promise<boolean> {
    return this.faceGlobalEnabledCache.get(() => this.faceGlobalEnabledState.get())
  }

  // Called from processFrame — resolves per-device face-recognition TUNING
  // (thresholds, buffer limits) with TTL cache. The `enabled` field it returns
  // is NOT used as a gate (that is the global switch above); per-device enable
  // does not exist.
  private async resolveDeviceFaceSettings(deviceId: number): Promise<FaceSettings> {
    return this.faceSettingsCache.get(deviceId, (id) =>
      this.readDeviceSettings(id, resolveFaceSettings),
    )
  }

  // Called from processFrame — resolves per-device media-crop settings with TTL cache.
  private async resolveDeviceMediaSettings(deviceId: number): Promise<MediaSettings> {
    return this.mediaSettingsCache.get(deviceId, (id) =>
      this.readDeviceSettings(id, resolveMediaSettings),
    )
  }

  // Called from processFrame — resolves+caches per-device stationary settings (#31)
  // with the shared TTL, so the sync `stationarySettingsFromCache` reads a warm
  // value at the gate/promotion/sweep call sites.
  private async resolveDeviceStationarySettings(deviceId: number): Promise<StationarySettings> {
    return this.stationarySettingsCache.get(deviceId, (id) =>
      this.readDeviceSettings(id, resolveStationarySettings),
    )
  }

  /** Per-device stillness scale. An absent/zero bar resolves to `undefined`
   *  ({@link resolveStillSpeedFracPerSec}) and leaves the state analyzer on
   *  its original absolute threshold — uncalibrated is exactly today. */
  private async resolveDeviceStillnessSettings(deviceId: number): Promise<StillnessSettings> {
    return this.stillnessSettingsCache.get(deviceId, (id) =>
      this.readDeviceSettings(id, resolveStillnessSettings),
    )
  }

  // Synchronous read of the per-device stationary settings (#31) — the registry
  // gate + sweep run synchronously, so they read the cache warmed by
  // `resolveDeviceStationarySettings` in the async frame path; a cold miss falls
  // back to the defaults (== today's constants). `peek` deliberately returns an
  // expired entry too — exact legacy behavior (the sync read never checked TTL).
  /**
   * Count SHORT + MOTIONLESS track closes per frame cell.
   *
   * The stationary registry answers a different question (is this object parked,
   * and should it be suppressed?). This one raises a spawn bar. The dead
   * ornamental grass on device 101 produced tracks of 3.8 s,
   * 4.1 s, 6.5 s and 19.0 s with 0-2.5 px of total displacement, roughly
   * fifteen of them in a day, all at the same spot. Each one is individually
   * innocent; the RECURRENCE is the signal, and nothing survives a track death
   * to notice it.
   *
   * Lowering the promotion window is not the fix — those 30 s exist so someone
   * standing still at a door is not declared scenery.
   *
   * The measurement half established how often a cell repeats — 32 cells with
   * ≥3 closes in 24 h across the fleet, the worst at 31. The MEMORY half now
   * lives in `pipeline/stationary/phantom-cells.ts` and is fed from here: a
   * short-motionless close ARMS its cell (raising the confirmation gate's bar
   * there), and a track that actually went somewhere CLEARS it.
   *
   * The in-RAM counter below stays. It is the line an operator reads
   * (`repeatsInWindow`), it costs one map, and it is the only thing that keeps
   * working if the durable registry failed to construct.
   */
  private noteShortMotionlessTrack(track: {
    readonly trackId: string
    readonly deviceId: number
    readonly className: string
    readonly firstSeen: number
    readonly lastSeen: number
    readonly totalDistance?: number
    readonly positions?: readonly { readonly x: number; readonly y: number }[]
  }): void {
    const first = track.positions?.[0]
    if (!first) return
    const lifeMs = track.lastSeen - track.firstSeen
    const moved = netDisplacementPx(track.positions ?? [])
    // Bounds: ≤25 s; person net ≤40 px (9310d1ff), vehicle net ≤8 px
    // (86918072 at 15 px must still list). Net, not walk.
    const motionless = isShortMotionlessTrack(lifeMs, moved, track.className)
    if (!motionless) {
      // REACTIVATION. A track born here that GOES SOMEWHERE revokes the
      // scenery reading — the whole reason the memory is safe to hold. Fire and
      // forget: the close path must never wait on SQLite, and a lost clear
      // costs one more suppressed birth, not lost work.
      void this.phantomCells
        ?.noteMovingClose({
          deviceId: track.deviceId,
          className: track.className,
          x: first.x,
          y: first.y,
        })
        .then((forgotten) => {
          if (!forgotten) return
          // A suppression that LIFTS silently is as hard to explain as one that
          // starts silently.
          this.ctx.logger.info('phantom cell cleared — a real subject moved through it', {
            tags: { deviceId: track.deviceId },
            meta: {
              trackId: track.trackId,
              className: track.className,
              lifeMs,
              movedPx: moved,
            },
          })
        })
        .catch(() => undefined)
      return
    }
    // Quantise to a coarse grid so the same scenery lands in one cell across
    // respawns, whose boxes never repeat to the pixel.
    const cell = `${Math.round(first.x / PHANTOM_CELL_PX)},${Math.round(first.y / PHANTOM_CELL_PX)}`
    const key = `${track.deviceId}:${track.className}:${cell}`
    const now = Date.now()
    const seen =
      this.frameState.shortMotionlessCells
        .get(key)
        ?.filter((t) => now - t < PHANTOM_CELL_WINDOW_MS) ?? []
    seen.push(now)
    this.frameState.shortMotionlessCells.set(key, seen)
    this.ctx.logger.info('short motionless track closed', {
      tags: { deviceId: track.deviceId },
      meta: {
        trackId: track.trackId,
        className: track.className,
        lifeMs,
        movedPx: Math.round(moved * 10) / 10,
        cell,
        // The number that matters: how many times THIS cell has done this
        // inside the window. A real subject standing still scores 1.
        repeatsInWindow: seen.length,
      },
    })
    void this.phantomCells
      ?.noteMotionlessClose({
        deviceId: track.deviceId,
        className: track.className,
        trackId: track.trackId,
        x: first.x,
        y: first.y,
        now,
      })
      .then((result) => {
        if (!result.raised) return
        this.ctx.logger.info('phantom cell armed — spawn bar raised here', {
          tags: { deviceId: track.deviceId },
          meta: {
            trackId: track.trackId,
            className: track.className,
            cell: result.cell,
            closesInWindow: result.closesInWindow,
          },
        })
      })
      .catch(() => undefined)
  }

  private stationarySettingsFromCache(deviceId: number): StationarySettings {
    return this.stationarySettingsCache.peek(deviceId) ?? STATIONARY_DEFAULTS
  }

  /** Synchronous read of the per-device package-drop settings — warmed by
   *  `processFrame` before the promotion loop, exactly like the stationary one. */
  private packageDropSettingsFromCache(deviceId: number): PackageDropSettings {
    return this.packageDropSettingsCache.peek(deviceId) ?? PACKAGE_DROP_DEFAULTS
  }

  // Per-device package-drop settings (TTL-cached, mirrors media/tracking).
  private async resolveDevicePackageDropSettings(deviceId: number): Promise<PackageDropSettings> {
    return this.packageDropSettingsCache.get(deviceId, (id) =>
      this.readDeviceSettings(id, resolvePackageDropSettings),
    )
  }

  /**
   * Resolve a device's ENABLED `package`-stage zone rules independent of the
   * live frame path (mirrors `resolveDeviceZones`). Warms the proxy and,
   * when the cached slice is empty, forces one refresh.
   *
   * The `package` slice is written through the `zone-rules` capability
   * (`zoneRules.setRules({stage:'package'})`), which is live. An earlier
   * version of this comment claimed the provider did not exist yet and that
   * "no package events fire" — that was stale, and believing it produced a
   * confidently wrong diagnosis on 2026-07-30. An empty list here means the
   * operator has drawn no package zone rule, nothing more.
   */
  private async resolveDevicePackageRules(deviceId: number): Promise<readonly ZoneRule[]> {
    const proxy = await this.ensureProxy(deviceId)
    if (!proxy) return []
    // Same correction as `resolveDeviceZones`: an operator who has drawn no
    // package rule is the COMMON case, and the old length test made that the
    // one case that could never be cached — 15 of 16 cameras re-fetched on
    // every `listEventKindsBatch`. See read-slice.ts.
    return (await readSliceOnce(proxy.state.zoneRules))?.package ?? []
  }

  /**
   * Frame admission — `frame/frame-admission.ts`. LAZY, like the media
   * runners: `ctx` is not assigned when field initialisers run.
   */
  private frameAdmissionInstance: FrameAdmission | null = null

  private get frameAdmission(): FrameAdmission {
    this.frameAdmissionInstance ??= new FrameAdmission({
      ctx: () => this.ctx,
      frameState: this.frameState,
      frameLag: this.frameLag,
      shuttingDown: () => this.shuttingDown,
      processFrame: (
        deviceId,
        frame,
        source,
        rawFrameHandle,
        detailSteps,
        occasion,
        producerNodeId,
      ) =>
        this.processFrame(
          deviceId,
          frame,
          source,
          rawFrameHandle,
          detailSteps,
          occasion,
          producerNodeId,
        ),
    })
    return this.frameAdmissionInstance
  }

  /**
   * The detail route — `frame/detail-route.ts`. LAZY, like the media
   * runners: `ctx` is not assigned when field initialisers run, and the
   * stores and recognizers are opened in `onInitialize`, so those are read
   * through getters.
   */
  private detailRouteInstance: DetailRoute | null = null

  private get detailRoute(): DetailRoute {
    this.detailRouteInstance ??= new DetailRoute({
      ctx: () => this.ctx,
      residents: this.residents,
      overlayState: this.overlayState,
      failureReport: this.failureReport,
      trackStore: () => this.trackStore,
      faceRecognizer: () => this.faceRecognizer,
      plateRecognizer: () => this.plateRecognizer,
      objectEmbeddingStore: () => this.objectEmbeddingStore,
      semanticBestShot: () => this.semanticBestShot,
      enrichmentFanout: () => this.enrichmentFanout,
      resolveGlobalFaceEnabled: () => this.resolveGlobalFaceEnabled(),
      resolveDeviceFaceSettings: (deviceId) => this.resolveDeviceFaceSettings(deviceId),
      resolveDeviceMediaSettings: (deviceId) => this.resolveDeviceMediaSettings(deviceId),
    })
    return this.detailRouteInstance
  }

  /**
   * The enrichment fan-out — `frame/enrichment-fanout.ts`. LAZY, like the
   * media runners: `ctx` is not assigned when field initialisers run, and the
   * stores are opened in `onInitialize`, so those are read through getters.
   */
  private enrichmentFanoutInstance: EnrichmentFanout | null = null

  private get enrichmentFanout(): EnrichmentFanout {
    this.enrichmentFanoutInstance ??= new EnrichmentFanout({
      ctx: () => this.ctx,
      residents: this.residents,
      captureScheduler: () => this.captureScheduler,
      trackStore: () => this.trackStore,
      eventStore: () => this.eventStore,
      mediaStore: () => this.mediaStore,
      objectEmbeddingStore: () => this.objectEmbeddingStore,
      captureCrop: () => this.captureCrop,
    })
    return this.enrichmentFanoutInstance
  }

  /**
   * Media capture off the frame path — `media/`. LAZY, like the retention
   * runners: `ctx` is not assigned when field initialisers run, and the
   * stores are opened in `onInitialize`, so those are read through getters.
   */
  private mediaCaptureInstance: FrameMediaCapture | null = null
  private semanticBestShotInstance: SemanticBestShot | null = null
  private snapshotTargetsInstance: SnapshotTargetPlanner | null = null

  private get mediaCapture(): FrameMediaCapture {
    this.mediaCaptureInstance ??= new FrameMediaCapture({
      ctx: () => this.ctx,
      ctxIfReady: () => this.ctxIfReady,
      shuttingDown: () => this.shuttingDown,
      frameState: this.frameState,
      residents: this.residents,
      keyFrameCaptureLog: this.keyFrameCaptureLog,
      nodeLiveness: this.nodeLiveness,
      pendingPreviewUpgrades: this.pendingPreviewUpgrades,
      captureScheduler: () => this.captureScheduler,
      keyFrameThumbnailDerive: () => this.keyFrameThumbnailDerive,
      parkedFrames: () => this.parkedFrames,
      mediaStore: () => this.mediaStore,
      trackStore: () => this.trackStore,
      captureDisplayCropFn: () => this.captureDisplayCropFn,
    })
    return this.mediaCaptureInstance
  }

  private get semanticBestShot(): SemanticBestShot {
    this.semanticBestShotInstance ??= new SemanticBestShot({
      ctxIfReady: () => this.ctxIfReady,
      residents: this.residents,
      captureScheduler: () => this.captureScheduler,
      eventMediaDispatcher: () => this.eventMediaDispatcher,
      mediaCapture: this.mediaCapture,
      resolveDeviceMediaSettings: (deviceId) => this.resolveDeviceMediaSettings(deviceId),
    })
    return this.semanticBestShotInstance
  }

  private get snapshotTargets(): SnapshotTargetPlanner {
    this.snapshotTargetsInstance ??= new SnapshotTargetPlanner({
      ctx: () => this.ctx,
      residents: this.residents,
      captureScheduler: () => this.captureScheduler,
      closedRowMediaGate: this.closedRowMediaGate,
      trackStore: () => this.trackStore,
      stationaryRegistry: () => this.stationaryRegistry,
      mediaCapture: this.mediaCapture,
      maybeEmitTrackLifecycleUpdate: (deviceId, t, timestamp, isNewBest) =>
        this.maybeEmitTrackLifecycleUpdate(deviceId, t, timestamp, isNewBest),
      offerDebugCrop: (input) => this.offerDebugCrop(input),
    })
    return this.snapshotTargetsInstance
  }

  /** Emit a `PipelineAnalyticsTrackLifecycle` event (start / update / end). */
  private emitTrackLifecycle(
    payload: PipelineAnalyticsTrackLifecyclePayload,
    timestamp: number,
  ): void {
    this.ctx.eventBus.emit({
      id: `pa-life-${randomUUID()}`,
      timestamp: new Date(timestamp),
      source: {
        type: 'addon',
        id: 'pipeline-analytics',
        addonId: 'pipeline-analytics',
      },
      category: EventCategory.PipelineAnalyticsTrackLifecycle,
      data: payload,
    })
  }

  /**
   * Fire a `phase:'update'` lifecycle event when this frame's observation is
   * a MATERIAL improvement over the last emit (confidence delta, a
   * newly-resolved identity/plate label, or a materially larger crop),
   * debounced per `DEFAULT_UPDATE_GATE_CONFIG`. Reuses the already-computed
   * `isNewBest`; the gate is pure and the per-track memory is advanced in
   * place. Carries the CURRENT best incl. the improved key-frame media key.
   */
  private maybeEmitTrackLifecycleUpdate(
    deviceId: number,
    t: TrackedDetectionOut,
    timestamp: number,
    isNewBest: boolean,
  ): void {
    const memory = this.residents.lifecycleUpdateMem(t.trackId)
    /**
     * The signal's label reads the frame patch AND the track row: the face
     * recognizer writes a recognised identity to the ROW over the async
     * detail plane, never into a frame patch, and a patch-only read left the
     * identity trigger unable to fire for a face — every face name reached
     * the export surfaces only on the `end` event, ~30 s after the subject
     * left the frame (measured live 2026-09-05).
     */
    const peeked = this.trackStore?.peekActive(t.trackId)
    const label = resolveLifecycleUpdateLabel(t.labelPatch, peeked?.label)
    const decision = evaluateTrackLifecycleUpdate(
      {
        isNewBest,
        confidence: t.confidence,
        now: timestamp,
        ...(label !== undefined ? { label } : {}),
        ...(peeked !== null && peeked !== undefined
          ? { zonesVisitedCount: peeked.zonesVisitedCount }
          : {}),
        bboxArea: t.bbox.w * t.bbox.h,
      },
      memory,
      DEFAULT_UPDATE_GATE_CONFIG,
    )
    this.residents.setLifecycleUpdateMem(deviceId, t.trackId, decision.memory)
    if (!decision.emit) {
      /**
       * Dropped for cadence (debounce) — counted, never silent. The count
       * since the last emit rides the memory and this line; a throttle
       * with no ledger is how a 30 s delivery delay stayed invisible.
       */
      if (decision.suppressed !== undefined) {
        this.ctx.logger.debug('lifecycle update suppressed (debounce)', {
          tags: { deviceId },
          meta: {
            trackId: t.trackId,
            reason: decision.suppressed,
            suppressedSinceEmit: decision.memory.suppressedSinceEmit ?? 0,
          },
        })
      }
      return
    }

    const track = this.trackStore?.getActiveByTrack(t.trackId)
    const keyFrameMediaId = this.residents.keyFrameMediaId(t.trackId)
    const payload = buildTrackLifecyclePayload({
      deviceId,
      trackId: t.trackId,
      phase: 'update',
      classes: track?.classes ?? [t.className],
      bestClassName: t.className,
      bestConfidence: t.confidence,
      firstSeen: track?.firstSeen ?? timestamp,
      lastSeen: track?.lastSeen ?? timestamp,
      ...(label !== undefined ? { label } : {}),
      ...(t.plateText !== undefined ? { plateText: t.plateText } : {}),
      ...(track?.zonesVisited !== undefined ? { zonesVisited: track.zonesVisited } : {}),
      ...(track?.totalDistance !== undefined ? { totalDistance: track.totalDistance } : {}),
      ...(track?.positions !== undefined ? { positionsCount: track.positions.length } : {}),
      ...(track?.audioLabels !== undefined ? { audioLabels: track.audioLabels } : {}),
      ...(keyFrameMediaId !== undefined ? { keyFrameMediaId } : {}),
      ...(t.embeddingModelId !== undefined ? { embeddingModelId: t.embeddingModelId } : {}),
    })
    this.emitTrackLifecycle(payload, timestamp)
  }

  /**
   * Is something VISUAL happening on this camera right now? Answered from two
   * in-RAM mirrors and nothing else — two `Map.get`s, no query, no await —
   * because the caller is the audio-marker gate and it runs at ~30 Hz per
   * camera. A query per audio event would be a per-frame round trip.
   *
   * The two mirrors answer different halves and neither subsumes the other:
   *  - {@link lastTrackActivityMs} — a tracked object was alive. Present only
   *    while the camera is ATTACHED and producing inference frames.
   *  - {@link lastMotionTickByDevice} — motion was reported (analyzer or
   *    onboard, ANY source). Covers a camera whose detector found nothing,
   *    and a camera on `detectionMode: 'on-motion'` in the window before it
   *    attaches. This is a plain per-device mirror, deliberately NOT the
   *    per-source episode state in {@link motionEpisodes} — this question is
   *    "is something visual happening on the camera", not "which episode".
   *
   * Staleness is safe in the direction that matters: a mirror that is late
   * suppresses a marker, it never invents one.
   */
  private isMotionActive(deviceId: number, atMs: number, quietMs: number): boolean {
    const trackAt = this.frameState.lastTrackActivityMs.get(deviceId)
    if (trackAt !== undefined && atMs - trackAt < quietMs) return true
    const motion = this.frameState.lastMotionTickByDevice.get(deviceId)
    return motion !== undefined && motion.detected && atMs - motion.atMs < quietMs
  }

  /** Per-device audio-marker config, folded from the cached audio settings. */
  private audioMarkerConfig(settings: AudioDetectionSettings): AudioMarkerConfig {
    return {
      enabled: settings.audioMarkerEnabled,
      baselineMs: settings.audioMarkerBaselineSec * 1000,
      silenceFloorDbfs: SILENCE_FLOOR_DBFS,
      minDbfs: settings.audioMarkerMinDbfs,
      minDeviations: settings.audioMarkerMinDeviations,
      minDeviationDb: settings.audioMarkerMinDeviationDb,
      motionQuietMs: settings.audioMarkerMotionQuietSec * 1000,
      cooldownMs: settings.audioMarkerCooldownSec * 1000,
      maxPerHour: settings.audioMarkerMaxPerHour,
      maxPerDay: settings.audioMarkerMaxPerDay,
    }
  }

  private audioEpisodeKnobs(settings: AudioDetectionSettings): AudioEpisodeKnobs {
    return {
      enabled: settings.audioEpisodeEnabled,
      openHoldMs: settings.audioEpisodeOpenHoldSec * 1000,
      closeGapMs: settings.audioEpisodeCloseGapSec * 1000,
      cooldownMs: settings.audioEpisodeCooldownSec * 1000,
    }
  }

  private hasLiveVisualTrack(deviceId: number, atMs: number): boolean {
    const at = this.frameState.lastTrackActivityMs.get(deviceId)
    return at !== undefined && atMs - at < AUDIO_EPISODE_VISUAL_QUIET_MS
  }

  private async driveAudioEpisode(input: {
    readonly deviceId: number
    readonly timestamp: number
    readonly className: string | null
    readonly score: number
    readonly originalClass?: string
    readonly rms: number
    readonly dbfs: number
    readonly knobs: AudioEpisodeKnobs
  }): Promise<void> {
    const prior =
      this.frameState.audioEpisodeByDevice.get(input.deviceId) ?? emptyAudioEpisodeState()
    const { nextState, action } = observeAudioEpisode(
      prior,
      { timestampMs: input.timestamp, className: input.className },
      input.knobs,
    )
    this.frameState.audioEpisodeByDevice.set(input.deviceId, nextState)
    switch (action.kind) {
      case 'none':
        return
      case 'open':
        await this.openAudioEpisode(input, action)
        return
      case 'hold':
        await this.holdAudioEpisode(input, action)
        return
      case 'close':
        await this.persistAudioEpisodeLastSeen(action, input.timestamp, true)
        return
      case 'replace':
        await this.persistAudioEpisodeLastSeen(action.closed, input.timestamp, true)
        await this.openAudioEpisode(input, action.opened)
        return
    }
  }

  /**
   * The ONE writer for a classified audio observation: the durable row, the
   * Notification Center hook fired in the same persist moment (D-2), the
   * track-level `audioLabels` stamp, and the telemetry event.
   *
   * Shared by both routes on purpose. `audioEpisodeEnabled` selects WHEN this
   * runs (once per episode, or once per heartbeat), never WHETHER — a knob
   * that names the grouping must not be able to silence the classified path
   * (D62). This body was inlined in `openAudioEpisode` and the knob-off camera
   * therefore persisted nothing at all.
   */
  private async persistClassifiedAudio(input: {
    readonly deviceId: number
    readonly timestamp: number
    readonly className: string
    readonly score: number
    readonly originalClass?: string
    readonly rms: number
    readonly dbfs: number
  }): Promise<void> {
    // Built WITHOUT an id: the column is a rowid alias and SQLite assigns it,
    // so the id is knowable only from the insert's reply (D474).
    const draft: AudioEventDraft = {
      deviceId: input.deviceId,
      timestamp: input.timestamp,
      kind: 'audio',
      rms: input.rms,
      dbfs: input.dbfs,
      // A labelled row exists only because the model ran (D660).
      classifyOutcome: { state: 'classified' },
      classification: {
        className: input.className,
        ...(input.originalClass !== undefined ? { originalClass: input.originalClass } : {}),
        score: input.score,
      },
    }
    this.frameState.lastAudioInsertByDevice.set(input.deviceId, {
      className: input.className,
      atMs: input.timestamp,
    })
    const insertedId = await this.eventStore!.insertAudio(draft)
    // A failed write is already logged by the store with the deviceId. There is
    // no id to hand on, and inventing one would put a dangling reference on the
    // event bus and inside a media key (D474).
    if (insertedId === null) return
    const ev: AudioEvent = { ...draft, id: insertedId }
    this.notificationCenter?.onAudioEventPersisted(ev)
    this.trackStore?.addAudioLabelEpisode(
      input.deviceId,
      input.className,
      input.score,
      input.timestamp,
    )
    this.ctx.eventBus.emit({
      id: `pa-${ev.id}`,
      timestamp: new Date(ev.timestamp),
      source: {
        type: 'addon',
        id: 'pipeline-analytics',
        addonId: 'pipeline-analytics',
      },
      category: EventCategory.PipelineAnalyticsDetectionEvent,
      data: {
        deviceId: input.deviceId,
        kind: 'audio',
        eventId: ev.id,
        timestamp: ev.timestamp,
      },
    })
  }

  /**
   * Classified audio with episodes OFF: persist on class change or heartbeat,
   * and open NO synthetic track. This is the whole of what the knob switches —
   * the timeline track and the episode coalescing — and it is what the form
   * promises.
   */
  private async persistClassifiedAudioUngrouped(input: {
    readonly deviceId: number
    readonly timestamp: number
    readonly className: string
    readonly score: number
    readonly originalClass?: string
    readonly rms: number
    readonly dbfs: number
  }): Promise<void> {
    const last = this.frameState.lastAudioInsertByDevice.get(input.deviceId)
    const sameClass = last?.className === input.className
    const heartbeatDue =
      last === undefined || input.timestamp - last.atMs >= AUDIO_EVENT_HEARTBEAT_MS
    if (sameClass && !heartbeatDue) return
    await this.persistClassifiedAudio(input)
  }

  private async openAudioEpisode(
    input: {
      readonly deviceId: number
      readonly timestamp: number
      readonly score: number
      readonly originalClass?: string
      readonly rms: number
      readonly dbfs: number
    },
    ref: AudioEpisodeRef,
  ): Promise<void> {
    await this.persistClassifiedAudio({ ...input, className: ref.className })
    if (this.hasLiveVisualTrack(input.deviceId, input.timestamp)) return
    const materializer = this.syntheticTracks
    if (materializer === null) return
    try {
      const track = await materializer.materialize({
        cameraId: input.deviceId,
        sourceDeviceId: input.deviceId,
        source: 'audio',
        // The taxonomy macro, NEVER the heard class (D189). The class heard
        // travels on `audioLabels` below — the same field a regular track uses
        // — so a consumer cannot tell this row apart from one, and a
        // `classes: ['animal']` rule can never be matched by a barking dog.
        kind: AUDIO_TRACK_CLASS,
        timestamp: input.timestamp,
        audioLabels: [
          {
            label: ref.className,
            peakScore: input.score,
            count: 1,
            firstAt: input.timestamp,
            lastAt: input.timestamp,
          },
        ],
      })
      if (track) {
        this.frameState.audioEpisodeTracks.set(ref.episodeId, track)
        this.frameState.audioEpisodeLastPersistMs.set(ref.episodeId, input.timestamp)
      }
    } catch (err) {
      this.ctx.logger.warn('audio-episode synthetic track failed', {
        tags: { deviceId: input.deviceId },
        meta: { className: ref.className, error: errMsg(err) },
      })
    }
  }

  private async holdAudioEpisode(
    input: {
      readonly deviceId: number
      readonly timestamp: number
      readonly score: number
    },
    ref: AudioEpisodeRef,
  ): Promise<void> {
    await this.persistAudioEpisodeLastSeen(ref, input.timestamp, false)
  }

  private async persistAudioEpisodeLastSeen(
    ref: AudioEpisodeRef,
    timestamp: number,
    force: boolean,
  ): Promise<void> {
    const track = this.frameState.audioEpisodeTracks.get(ref.episodeId)
    if (!track) {
      if (force) {
        this.frameState.audioEpisodeTracks.delete(ref.episodeId)
        this.frameState.audioEpisodeLastPersistMs.delete(ref.episodeId)
      }
      return
    }
    const last = this.frameState.audioEpisodeLastPersistMs.get(ref.episodeId) ?? 0
    if (!force && timestamp - last < AUDIO_EPISODE_PERSIST_MS) return
    const updated: Track = { ...track, lastSeen: timestamp }
    this.frameState.audioEpisodeTracks.set(ref.episodeId, updated)
    this.frameState.audioEpisodeLastPersistMs.set(ref.episodeId, timestamp)
    try {
      await this.trackStore?.persistSyntheticTrack(updated)
    } catch (err) {
      this.ctx.logger.warn('audio-episode lastSeen persist failed', {
        tags: { deviceId: track.deviceId },
        meta: { episodeId: ref.episodeId, error: errMsg(err) },
      })
    }
    if (force) {
      this.frameState.audioEpisodeTracks.delete(ref.episodeId)
      this.frameState.audioEpisodeLastPersistMs.delete(ref.episodeId)
    }
  }

  private async handleAudioResult(data: PipelineAudioInferenceResultPayload): Promise<void> {
    if (this.shuttingDown) return
    const { deviceId, frame } = data
    const active = await this.bindingCache!.isActive(deviceId)
    if (!active) return

    // AudioResult shape: has level + detections + timestamp.
    const level = frame.level
    const timestamp = frame.timestamp ?? Date.now()
    const topClassification =
      frame.detections && frame.detections.length > 0 ? frame.detections[0] : undefined

    // Feed the rolling-window audio metrics aggregator. The provider
    // mirrors a snapshot to `device.state.audioMetrics` on every call
    // so the operator UI gets push updates without a custom event
    // subscription.
    void this.audioMetrics?.recordAudioFrame({
      deviceId,
      timestamp,
      ...(level ? { level } : {}),
      ...(topClassification
        ? {
            topClassification: {
              className: topClassification.macroClass,
              score: topClassification.score,
            },
          }
        : {}),
    })

    // Audio chunks arrive at ~25-30 Hz (32 ms windows). Routing logic:
    //   • Confident non-silence classification (score ≥ classificationMinScore):
    //     → classification path — hysteresis opens ONE episode (event +
    //       synthetic track) and holds it; a 5 s heartbeat used to spam both.
    //   • Everything else (low score, silence class, no classification):
    //     → level path — driven by the per-device rolling-window detector
    //       (observeLevel); emits only on genuine loudness peaks / heartbeats;
    //       frames below the silence floor never emit. The hysteresis state
    //       is still fed (className=null) so the close-gap can fire.
    // Operators wanting per-chunk telemetry should subscribe to the
    // `pipeline.audio-inference-result` bus event directly instead.
    const settings = await this.resolveDeviceAudioSettings(deviceId)

    // Audio markers (D62) — fed BEFORE the route split, deliberately. A
    // baseline that only sees the level route is blind to exactly the loud,
    // confidently-classified frames a marker exists for; and a frame that
    // takes the classification route returns before `observeLevel` ever runs.
    // Synchronous: the decision costs one exp() and two Map lookups, and only
    // an actual marker goes async.
    this.audioMarkers?.observe(
      {
        deviceId,
        timestampMs: timestamp,
        dbfs: level?.dbfs ?? Number.NEGATIVE_INFINITY,
        ...(topClassification !== undefined
          ? {
              className: topClassification.macroClass,
              score: topClassification.score,
            }
          : {}),
      },
      this.audioMarkerConfig(settings),
    )

    // Level history (device-history): EVERY measured frame, before the route
    // split and independent of the level detector's emit decision — the bar is
    // a continuous PEAK level, one point per 10 s window. An unmeasured frame
    // (no `level`) feeds nothing: unmeasured is absent, not silent (D431).
    if (level !== undefined) this.lts?.observeAudioLevel(deviceId, level.dbfs, timestamp)

    // Notification Center AUDIO WINDOW feed — fed BEFORE the route split, for
    // the same reason the markers are: a rule about how loud this camera has
    // been is a question about EVERY frame, and a feed placed after the split
    // sees only the half its branch kept (a loudness rule fed from the
    // classification route alone is blind to loud UNCLASSIFIED noise, which is
    // most of it). Synchronous and a no-op unless some rule declares an
    // `audio` condition; the labels offered are the ones the classifier is
    // confident about, using the SAME per-device floor the router uses, so a
    // rule and the event log never disagree about what was heard.
    // The sample carries whether the model RAN (D660), so a window nobody
    // listened to is never read as one that heard nothing.
    this.notificationCenter?.observeAudio(
      deviceId,
      ncAudioSampleFromFrame(frame, timestamp, settings),
    )

    const topForRouter = topClassification
      ? {
          className: topClassification.macroClass,
          score: topClassification.score,
        }
      : undefined
    const route = classifyAudioFrame(topForRouter, {
      classificationMinScore: settings.classificationMinScore,
      allowedClasses: settings.audioAllowedClasses,
    })

    if (route.kind === 'classification') {
      if (!topClassification) {
        // Unreachable: classifyAudioFrame only routes here when top is defined.
        this.ctx.logger.warn(
          'classifyAudioFrame returned classification but topClassification is null',
          { tags: { deviceId }, meta: { deviceId } },
        )
        return
      }
      // Corroboration window. It sits HERE, not on the level path, because a
      // held frame must produce NOTHING: routing it to the level detector
      // would let a loud unconfirmed bark emit an unclassified event and swap
      // the event rather than suppress it. A held frame is skipped exactly the
      // way a classified frame already skips the level detector below.
      const confirm = observeAudioConfirm(
        this.frameState.audioConfirmByDevice.get(deviceId) ?? emptyAudioConfirmState(),
        { className: route.className, timestampMs: timestamp },
        {
          confirmHits: settings.audioConfirmHits,
          confirmWindowSec: settings.audioConfirmWindowSec,
        },
      )
      this.frameState.audioConfirmByDevice.set(deviceId, confirm.nextState)
      if (!confirm.confirmed) {
        // A branch that drops work says so, per-camera (CLAUDE.md/Logging).
        this.ctx.logger.debug('audio event held for corroboration', {
          tags: { deviceId },
          meta: {
            deviceId,
            className: route.className,
            confirmHits: settings.audioConfirmHits,
            confirmWindowSec: settings.audioConfirmWindowSec,
          },
        })
        return
      }
      const classified = {
        deviceId,
        timestamp,
        className: route.className,
        score: topClassification.score,
        ...(topClassification.debug?.originalClass !== undefined
          ? { originalClass: topClassification.debug.originalClass }
          : {}),
        rms: level?.rms ?? 0,
        dbfs: level?.dbfs ?? 0,
      }
      // The knob selects the WRITER, not whether there is one. Off ⇒ the
      // pre-episode heartbeat rule, still persisting + still notifying.
      if (!settings.audioEpisodeEnabled) {
        await this.persistClassifiedAudioUngrouped(classified)
        return
      }
      await this.driveAudioEpisode({
        ...classified,
        knobs: this.audioEpisodeKnobs(settings),
      })
      return
    }

    // Feed the hysteresis a class-less sample so an open episode's close-gap
    // can fire. Pointless work when the knob is off — there is no state to
    // advance.
    if (settings.audioEpisodeEnabled) {
      await this.driveAudioEpisode({
        deviceId,
        timestamp,
        className: null,
        score: 0,
        rms: level?.rms ?? 0,
        dbfs: level?.dbfs ?? 0,
        knobs: this.audioEpisodeKnobs(settings),
      })
    }

    // Level path — drive the per-device rolling-window detector.
    const st = this.frameState.levelStateByDevice.get(deviceId) ?? emptyLevelState()
    const res = observeLevel(
      st,
      { timestampMs: timestamp, dbfs: level?.dbfs ?? -Infinity },
      {
        windowMs: settings.levelWindowSec * 1000,
        deviationDb: settings.levelDeviationDb,
        maxWaitMs: settings.levelMaxWaitSec * 1000,
        silenceFloorDbfs: SILENCE_FLOOR_DBFS,
      },
    )
    this.frameState.levelStateByDevice.set(deviceId, res.nextState)
    if (!res.emit) return

    // Built WITHOUT an id: the column is a rowid alias and SQLite assigns it,
    // so the id is knowable only from the insert's reply (D474).
    // The level-path row carries whether the model RAN on its window (D660):
    // "loud, nothing above the floor" and "loud, nobody listened" are
    // different rows.
  }

  /**
   * Persist motion-analysis bus events into the EPISODE tracker (D475): a
   * rising edge with no open episode INSERTs a row; a further edge inside an
   * open episode extends it in place; the episode closes on its own timer,
   * `MOTION_CLOSE_AFTER_MS` after the last rising edge. See
   * `motion-episode.ts` / `motion-episode-tracker.ts` for the state machine.
   *
   * Gated on the same `pipeline-analytics` wrapper binding as the
   * inference + audio handlers so toggling the wrapper off for a
   * camera stops every kind of event persistence at once.
   */
  private async handleMotionAnalysis(
    deviceId: number,
    payload: MotionAnalysisPayload,
    timestamp: number,
  ): Promise<void> {
    if (this.shuttingDown) return
    const active = await this.bindingCache!.isActive(deviceId)
    if (!active) return

    const detected = payload.detected === true
    this.frameState.lastMotionTickByDevice.set(deviceId, { detected, atMs: timestamp })
    // The motion-activity LTS tap used to ride `insertMotion`, which fired on
    // every heartbeat row (~5 s while motion stayed on). An episode now
    // inserts only once, at open — sampled here, on every observation
    // instead, so a long continuous episode still feeds the aggregator at
    // the same density (D475).
    if (detected) this.eventStore?.noteMotionSample(deviceId, payload.regionCount, timestamp)
    await this.motionEpisodes?.observe(deviceId, 'analyzer', detected, timestamp, {
      regionCount: payload.regionCount,
      regions: payload.regions.map((r) => ({
        bbox: { x: r.bbox.x, y: r.bbox.y, w: r.bbox.w, h: r.bbox.h },
        pixelCount: r.pixelCount,
        intensity: r.intensity,
      })),
      frameWidth: payload.frameWidth,
      frameHeight: payload.frameHeight,
    })
  }

  /**
   * Persist firmware-driven (onboard / device-activity) motion events into
   * the SAME episode tracker as {@link handleMotionAnalysis}, keyed per
   * `(deviceId, source)` so the two paths can never share — or fight over —
   * one episode on a camera whose `motionSources` lists both (D475). Reads
   * from the {@link MotionOnMotionChangedPayload} shape which lacks frame
   * dimensions and pixel-level region details (firmware reports a binary
   * detected flag plus, on rare devices, a coarse bbox via the optional
   * `regions` field).
   */
  private async handleOnboardMotion(
    deviceId: number,
    payload: MotionOnMotionChangedPayload,
    timestamp: number,
  ): Promise<void> {
    if (this.shuttingDown) return
    const active = await this.bindingCache!.isActive(deviceId)
    if (!active) return

    const detected = payload.detected === true
    this.frameState.lastMotionTickByDevice.set(deviceId, { detected, atMs: timestamp })
    // Onboard payloads carry an optional `regions` array (firmware
    // bbox passed through the cap event). Most cameras don't expose
    // it, so default to an empty array + zero counts. Frame
    // dimensions are unknown (omitted from the row).
    const regions = payload.regions ?? []
    // See the analyzer handler's identical call for why this rides every
    // observation rather than only the (now much rarer) inserts (D475).
    if (detected) this.eventStore?.noteMotionSample(deviceId, regions.length, timestamp)
    // D672: only the camera's ONBOARD source has a trigger to record. The
    // tracker reads regionData on the episode's FIRST edge only, so the first
    // trigger is what lands on the row and a later edge of the same episode
    // cannot move it. Any other source leaves the key absent: NOT RECORDED,
    // never a guessed camera (D393).
    const provenance =
      payload.source === 'onboard' ? readMotionTriggeredBy(payload.triggeredBy) : null
    // Said on the rising edge only: a falling edge opens nothing, so there is
    // no row for the value to be read onto.
    if (detected && provenance?.malformed === true) {
      this.ctx.logger.warn('onboard motion: triggeredBy malformed — read as the camera', {
        tags: { deviceId },
        meta: { triggeredBy: payload.triggeredBy },
      })
    }
    await this.motionEpisodes?.observe(deviceId, payload.source, detected, timestamp, {
      regionCount: regions.length,
      regions: regions.map((r) => ({
        bbox: { x: r.bbox.x, y: r.bbox.y, w: r.bbox.w, h: r.bbox.h },
        pixelCount: r.pixelCount,
        intensity: r.intensity,
      })),
      frameWidth: 0,
      frameHeight: 0,
      ...(provenance !== null ? { triggeredBy: provenance.triggeredBy } : {}),
    })
  }

  /**
   * `MotionEpisodeTracker.insertRow` — builds and inserts the row that opens
   * a motion episode. `regionData` carries the per-kind fields the two motion
   * handlers differ on (regions/frameWidth/frameHeight); everything else
   * (id, durationMs, edges) is the episode's own concern, not the caller's.
   */
  private async insertMotionEpisodeRow(
    deviceId: number,
    timestamp: number,
    regionData: MotionEpisodeRowData,
  ): Promise<number | null> {
    // Built WITHOUT an id: the column is a rowid alias and SQLite assigns it,
    // so the id is knowable only from the insert's reply (D474).
    const draft: MotionEventDraft = {
      deviceId,
      timestamp,
      kind: 'motion',
      durationMs: null,
      ...regionData,
    }
    return this.eventStore!.insertMotion(draft)
  }

  /**
   * `MotionEpisodeTracker.closeRow` — the UPDATE that closes an episode.
   */
  private async closeMotionEpisodeRow(input: {
    readonly deviceId: number
    readonly eventId: number
    readonly durationMs: number
    readonly edges: readonly number[]
  }): Promise<boolean> {
    return this.eventStore!.updateMotion(input.eventId, input.deviceId, {
      durationMs: input.durationMs,
      edges: input.edges,
    })
  }

  /**
   * `MotionEpisodeTracker.onNewEdge` — the side effects the pre-D475 code
   * fired on every `transitionedOn`: the birth-latency onset mark (D409, only
   * the FIRST edge of a burst moves it — a further edge inside the same
   * episode is a fresh onset in its own right, so it moves too) and the
   * motion-marker still (self-throttled by `motion-marker-policy.ts`;
   * `String` because a media key is a URL component while the id itself
   * stays a number, D474).
   */
  private onMotionEpisodeEdge(input: {
    readonly deviceId: number
    readonly timestamp: number
    readonly eventId: number
  }): void {
    this.frameState.motionOnsets.noteRisingEdge(input.deviceId, input.timestamp)
    // Fire-and-forget from the tracker's perspective (`onNewEdge` is
    // synchronous) — caught here rather than left to become an unhandled
    // rejection, which is the ONE behaviour change from the pre-D475 code:
    // that awaited this call, but from a dispatch site that itself never
    // awaited `handleMotionAnalysis`/`handleOnboardMotion` (`wire-subscriptions.ts`
    // uses `void deps.onMotionAnalysis(...)`), so a failure here was already
    // unobserved by any caller — this just stops it from reaching the process
    // as an unhandled rejection instead of a log line.
    this.captureMotionMarkerStill(input.deviceId, String(input.eventId), input.timestamp).catch(
      (err: unknown) => {
        this.ctx.logger.debug('motion marker still capture failed', {
          tags: { deviceId: input.deviceId },
          meta: { eventId: input.eventId, error: errMsg(err) },
        })
      },
    )
    this.ctx.eventBus.emit({
      id: `pa-${input.eventId}`,
      timestamp: new Date(input.timestamp),
      source: {
        type: 'addon',
        id: 'pipeline-analytics',
        addonId: 'pipeline-analytics',
      },
      category: EventCategory.PipelineAnalyticsDetectionEvent,
      data: {
        deviceId: input.deviceId,
        kind: 'motion',
        eventId: input.eventId,
        timestamp: input.timestamp,
      },
    })
  }

  /**
   * `MotionEpisodeTracker.onTick` — fires on every `detected:true`
   * observation that reaches an open or newly-opened episode, transition or
   * continuation. Arms the scene quiet-edge trigger: a scene is checked
   * `quietSeconds` AFTER the last motion, never during it, so this wants
   * "motion is still happening" — the SAME question `onNewEdge` does not
   * answer, since a long continuous burst is mostly continuation ticks.
   */
  private onMotionEpisodeTick(input: {
    readonly deviceId: number
    readonly timestamp: number
  }): void {
    this.sceneEngine?.noteMotion(input.deviceId, input.timestamp)
  }

  /**
   * The gate in front of the motion still. Both motion handlers reach it, so
   * there is exactly one place that decides.
   *
   * With debug media OFF (the default) the still is the operator's fallback
   * marker: produced only during a DETECTION DROUGHT, once per
   * `motionMarkerQuietMs` window. See `services/motion-marker-policy.ts` for
   * why the raw edge is not a scene fact — it is the provider's ~1 Hz
   * keepalive beating against the analyzer's per-frame sample through one
   * shared edge map.
   *
   * A dropped write is REPORTED, but as a per-window summary and never per
   * event: the suppressed count since the last marker rides on the marker's
   * own line. At 92 400 suppressions/day a line each would be the flood the
   * logging rules exist to prevent, and a silent branch reads as "never
   * happened".
   */
  private async captureMotionMarkerStill(
    deviceId: number,
    eventId: string,
    timestamp: number,
  ): Promise<void> {
    const capturer = this.motionEventSnapshots
    if (!capturer) return
    const media = await this.resolveDeviceMediaSettings(deviceId)
    await capturer.capture({
      deviceId,
      eventId,
      timestamp,
      policy: {
        debugMediaEnabled: media.debugMediaEnabled,
        quietMs: media.motionMarkerQuietMs,
        // The D49 mirror, not a read: a stale value SUPPRESSES a marker and
        // never invents one, and there is nothing here that can fail.
        lastDetectionAtMs: this.frameState.lastTrackActivityMs.get(deviceId),
      },
    })
  }

  // ── Housekeeping ─────────────────────────────────────────────────────

  private async sweepExpiredTracks(): Promise<void> {
    if (this.shuttingDown || !this.trackStore) return
    try {
      // D683 (review C2): silence ends tracklets and commits fusions BEFORE the
      // closer runs — a camera whose frames stopped has no other trigger.
      await this.trackerSweep.run(Date.now())
      // A silent camera's summary is due too (review L4): the sweep ended its
      // tracklets, and the next frame may be hours away.
      for (const [key, p] of this.frameState.processors)
        this.reportTrackerSummary(p.deviceId, key, p, 'sweep')
    } catch (err) {
      // `run` contains each processor's failure; this is the belt for a throw
      // outside them. Either way the closer below MUST run (review H3): a
      // sweep that stopped it would stop every row on this runner closing.
      this.ctx.logger.warn('tracker sweep failed — the track closer still runs', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    } finally {
      // Full per-track close orchestration (incl. the single-flight sweep latch)
      // lives in `TrackCloser` (S2, pipeline/track-close.ts).
      await this.trackCloser.sweep()
    }
  }

  /**
   * The retention pass and the track prune it drives — `retention/`. LAZY:
   * `ctx` is not assigned when field initialisers run, and the stores are
   * opened in `onInitialize`, so every dependency is read through a getter.
   */
  private trackPruneInstance: TrackPruneRunner | null = null
  private retentionInstance: RetentionSweepRunner | null = null

  private get trackPrune(): TrackPruneRunner {
    this.trackPruneInstance ??= new TrackPruneRunner({
      ctx: () => this.ctx,
      shuttingDown: () => this.shuttingDown,
      trackStore: () => this.trackStore,
      eventStore: () => this.eventStore,
      mediaStore: () => this.mediaStore,
      mediaLocationStorage: () => this.mediaLocationStorage,
      stationaryRegistry: () => this.stationaryRegistry,
      phantomCells: () => this.phantomCells,
      stationaryEvidence: () => this.stationaryEvidence,
      packageBackground: () => this.packageBackground,
      buildTrackCascadeRegistry: () => this.buildTrackCascadeRegistry(),
      clearLiveTrackState: (deviceId, trackId) => this.clearLiveTrackState(deviceId, trackId),
      logExpandBatchFailure: (deviceId, failedIds, err) =>
        this.logExpandBatchFailure(deviceId, failedIds, err),
      deleteTracks: (input) => this.deleteTracks(input),
    })
    return this.trackPruneInstance
  }

  private get retention(): RetentionSweepRunner {
    this.retentionInstance ??= new RetentionSweepRunner({
      ctx: () => this.ctx,
      shuttingDown: () => this.shuttingDown,
      trackStore: () => this.trackStore,
      eventStore: () => this.eventStore,
      mediaStore: () => this.mediaStore,
      sensorEventStore: () => this.sensorEventStore,
      faceStore: () => this.faceStore,
      plateStore: () => this.plateStore,
      eventsOpsLog: () => this.eventsOpsLog,
      readDeviceBlob: (deviceId) => this.readDeviceBlob(deviceId),
      resolveGlobalStore: () => this.resolveGlobalStore(),
      retiredSettings: new RetiredSettingsPurge({
        ctx: () => this.ctx,
        ctxIfReady: () => this.ctxIfReady,
        readDeviceBlob: (deviceId) => this.readDeviceBlob(deviceId),
        rawDeviceBlobMirror: this.rawDeviceBlobMirror,
        resolveGlobalStore: () => this.resolveGlobalStore(),
        updateGlobalSettings: (patch) => this.updateGlobalSettings(patch),
        resolveDeviceFaceSettings: (deviceId) => this.resolveDeviceFaceSettings(deviceId),
      }),
      trackPrune: this.trackPrune,
    })
    return this.retentionInstance
  }

  /** The retention pass (D61/D62) — `retention/retention-sweep-runner.ts`. */
  private async sweepRetention(): Promise<void> {
    return this.retention.sweepRetention()
  }

  /** The buffer capacity in force — `retention/retention-sweep-runner.ts`. */
  protected async resolveBufferCap(): Promise<number> {
    return this.retention.resolveBufferCap()
  }

  /*
   * `handleNativeDetection` lived here and is GONE. The camera-native plane
   * was a second door into `processFrame`, and the pipeline never knew it
   * existed — no addon outside the vendor could even see the toggle that
   * governed it. Everything this plane gets for free was lost on the way in:
   * the per-camera `detailSteps` announce, the subject tiles, the birth
   * evidence, and the frame handle itself, because in this process there are
   * no decoded pixels to name. An onboard-born track therefore had no face, no
   * plate and no embedding.
   *
   * The camera's detections now enter at the RUNNER — the one place holding a
   * decoded frame and its detections at the same instant — gated by the
   * camera's `detectionSources`, and arrive here on the ordinary
   * `PipelineInferenceResult` with `source: 'onboard'`. One door, one plane.
   * See `addon-pipeline/src/pipeline-runner/detection-source-plan.ts`.
   */

  /**
   * Best-effort bus notification for a gallery face-row change (buffer /
   * assign / unassign / delete). Passed into the `FaceRecognizer` and
   * `FaceGalleryProvider` as their `emitFaceGalleryChanged` dep. Telemetry
   * (D8): a lost/failed emit only delays the admin-ui live-refresh — never
   * allowed to fail the caller's mutation.
   */
  private emitFaceGalleryChanged(payload: PipelineAnalyticsFaceGalleryChangedPayload): void {
    try {
      this.ctx.eventBus.emit({
        id: `pa-${randomUUID()}`,
        timestamp: new Date(),
        source: {
          type: 'addon',
          id: 'pipeline-analytics',
          addonId: 'pipeline-analytics',
        },
        category: EventCategory.PipelineAnalyticsFaceGalleryChanged,
        data: payload,
      })
    } catch (err) {
      this.ctx.logger.debug('face-gallery-changed emit failed', {
        meta: {
          deviceId: payload.deviceId,
          faceId: payload.faceId,
          error: String(err),
        },
      })
    }
  }

  /**
   * Best-effort bus notification for a gallery plate-row change (buffer /
   * assign / unassign / delete). Passed into the `PlateRecognizer` and
   * `PlateGalleryProvider` as their `emitPlateGalleryChanged` dep. Telemetry
   * (D8): a lost/failed emit only delays the admin-ui live-refresh — never
   * allowed to fail the caller's mutation.
   */
  private emitPlateGalleryChanged(payload: PipelineAnalyticsPlateGalleryChangedPayload): void {
    try {
      this.ctx.eventBus.emit({
        id: `pa-${randomUUID()}`,
        timestamp: new Date(),
        source: {
          type: 'addon',
          id: 'pipeline-analytics',
          addonId: 'pipeline-analytics',
        },
        category: EventCategory.PipelineAnalyticsPlateGalleryChanged,
        data: payload,
      })
    } catch (err) {
      this.ctx.logger.debug('plate-gallery-changed emit failed', {
        meta: {
          deviceId: payload.deviceId,
          plateId: payload.plateId,
          error: String(err),
        },
      })
    }
  }

  /** Composite key for the per-(device, source) processor + track maps. */
  private procKey(deviceId: number, source: DetectionSource): string {
    return `${deviceId}:${source}`
  }

  /** Drop all per-source processor + track state for a device (every source). */
  private forgetDeviceProcessors(deviceId: number): void {
    const prefix = `${deviceId}:`
    for (const k of this.frameState.processors.keys()) {
      if (k.startsWith(prefix)) {
        this.frameState.processors.delete(k)
        this.frameState.processorInputs.delete(k)
      }
    }
    for (const k of this.frameState.lastActiveTrackIds.keys()) {
      if (k.startsWith(prefix)) this.frameState.lastActiveTrackIds.delete(k)
    }
    for (const source of ['pipeline', 'onboard'] as const) {
      this.frameState.secondarySubjects.forget(this.procKey(deviceId, source))
    }
    for (const k of this.frameState.dropoutSkipsByKey.keys()) {
      if (k.startsWith(prefix)) this.frameState.dropoutSkipsByKey.delete(k)
    }
    this.frameState.lastFrameDimsByDevice.delete(deviceId)
  }

  /** Apply a mutation to every live source-processor of a device (zones/rules
   *  are device-level and must reach all sources). */
  private forEachDeviceProcessor(deviceId: number, fn: (p: FrameProcessor) => void): void {
    const prefix = `${deviceId}:`
    for (const [k, p] of this.frameState.processors) {
      if (k.startsWith(prefix)) fn(p)
    }
  }

  /**
   * Turn a parked track into a stationary-registry entry and tear the track
   * down WITHOUT firing an 'end' key-event / importance scoring / media flush
   * (a parked object is not a highlight; the durable record is the entry). The
   * tracker + store forget the track so its detections stop re-spawning tracks,
   * and the registry suppresses them from the next frame on.
   */
  /**
   * Feed this frame's package-class detections to the dedicated stillness
   * tracker and bridge its transitions into `PackageDropDetector` — the SAME
   * `onStationaryChange` contract the generic registry uses, so the detector
   * has no idea there are two producers.
   *
   * Called on every pipeline frame with the (possibly empty) sighting list:
   * an empty list is what advances the observed clock, and dropping the call
   * on quiet frames would mean a parcel that was taken away is never reported
   * as picked up.
   */
  private packageSceneCoordinator(): PackageSceneCoordinator {
    const existing = this.packageScene
    if (existing !== null) return existing
    const created = new PackageSceneCoordinator({
      query: (request) => this.queryPackageSceneCrop(request),
      logger: this.ctx.logger.child('PackageScene'),
      onSightings: (delivery) => this.deliverPackageSceneSightings(delivery),
    })
    this.packageScene = created
    return created
  }

  private queryPackageSceneCrop(
    request: Parameters<PackageSceneNativeQuery>[0],
  ): ReturnType<PackageSceneNativeQuery> {
    const crop = this.ctx.api.pipelineRunner.getNativeCrop
    return crop.query(
      {
        handle: request.handle,
        bbox: request.bbox,
        acceptJpegBytes: request.acceptJpegBytes,
        encodeJpeg: request.encodeJpeg,
      },
      request.pin,
    )
  }

  private deliverPackageSceneSightings(delivery: PackageSceneDelivery): void {
    const settings = this.packageDropSettingsFromCache(delivery.deviceId)
    const lastActivityAt = this.frameState.lastNonPackageActivityAt.get(delivery.deviceId)
    const outcome = this.frameState.packageStillness.observe({
      deviceId: delivery.deviceId,
      sightings: delivery.sightings,
      frameWidth: delivery.frameWidth,
      frameHeight: delivery.frameHeight,
      timestamp: delivery.timestamp,
      minHits: settings.packageDropMinFrames,
      minDwellMs: settings.packageDropDwellSec * 1000,
      activityWindowMs: settings.packageDropActivityWindowSec * 1000,
      ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
      looked: false,
    })
    this.bridgePackageStillness({
      deviceId: delivery.deviceId,
      outcome,
      timestamp: delivery.timestamp,
      settings,
      ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
      via: 'frame',
    })
  }

  private async confirmPackageDelivery(input: {
    readonly deviceId: number
    readonly entryId: string
    readonly zoneIds: readonly string[]
  }): Promise<PackageLlmConfirmOutcome> {
    const crops = this.packageScene?.cropsFor(input.deviceId)
    return confirmPackageWithLlm({
      generateVision: (request) => this.generatePackageVision(request),
      cancel: async (requestId) => {
        await this.ctx.api.llm.cancel.mutate({ requestId })
      },
      ...(crops?.beforeJpeg !== undefined ? { beforeJpeg: crops.beforeJpeg } : {}),
      ...(crops?.afterJpeg !== undefined ? { afterJpeg: crops.afterJpeg } : {}),
    })
  }

  private async generatePackageVision(request: PackageLlmGenerateRequest) {
    const result = await this.ctx.api.llm.generateVision.mutate({
      consumer: request.consumer,
      system: request.system,
      prompt: request.prompt,
      jsonSchema: request.jsonSchema,
      images: request.images.map((image) => ({
        bytes: new Uint8Array(image.bytes),
        mimeType: image.mimeType,
      })),
      temperature: request.temperature,
      timeoutMs: request.timeoutMs,
      requestId: request.requestId,
      retry: request.retry,
    })
    if (result.ok) return { ok: true, text: result.text }
    return { ok: false, code: result.code, message: result.message }
  }

  private runPackageStillness(input: {
    deviceId: number
    tracked: readonly TrackedDetectionOut[]
    packageClasses: ReadonlySet<string>
    packageZoneIds: ReadonlySet<string>
    packageRules: readonly PackageOptionRule[]
    zones: readonly PackageReferenceZone[]
    settings: PackageDropSettings
    frameHandle: FrameHandle | null
    frameWidth: number
    frameHeight: number
    timestamp: number
    /** The executor's frame: whether the package step LOOKED, and what it
     *  returned before the tracker (D687 — `packageLookEvidence`). */
    frame: FrameResult
  }): void {
    if (this.packageDropDetector === null) return
    const tags = { deviceId: input.deviceId }
    // Activity mirror — a non-package track IN A PACKAGE DROP-OFF ZONE
    // stamps the device. A walker at the far gate is not a deliverer.
    // The package-class FP itself must never vouch for its own delivery.
    for (const t of input.tracked) {
      if (input.packageClasses.has(t.className)) continue
      if (!isDelivererInPackageZone(t.zones, input.packageZoneIds)) continue
      this.frameState.lastNonPackageActivityAt.set(input.deviceId, input.timestamp)
      break
    }
    // …and WHO they were (D404). Same population, same gate — but the stamp
    // above answers "was somebody around", which a pick-up notification cannot
    // put a face on. The mirror keeps the trackIds and their key-frame HANDLES
    // so the departure, concluded minutes later, can still name the collector.
    // Every qualifying track is noted, not just the first: two people on the
    // porch is exactly when picking the right one matters.
    this.frameState.packageCollectors.noteFrame({
      deviceId: input.deviceId,
      tracked: input.tracked,
      packageClasses: input.packageClasses,
      packageZoneIds: input.packageZoneIds,
      timestamp: input.timestamp,
      keyFrameMediaIdFor: (trackId) => this.residents.keyFrameMediaId(trackId),
    })
    const lookEvidence = packageLookEvidence({
      frame: input.frame,
      tracked: input.tracked,
      packageClasses: input.packageClasses,
      earlyPickupEnabled: input.settings.packageDropEarlyPickupEnabled,
    })
    const ref = packageReferenceArea({
      zones: input.zones,
      packageZoneIds: input.packageZoneIds,
      frameWidth: input.frameWidth,
      frameHeight: input.frameHeight,
    })
    const rawKept: PackageLookRawKept[] = []
    for (const d of input.frame.detections) {
      if (d.kind !== 'first-level' || !input.packageClasses.has(d.macroClass)) continue
      rawKept.push({
        bbox: { x: d.bbox.x, y: d.bbox.y, w: d.bbox.width, h: d.bbox.height },
        score: d.score,
      })
    }
    const trackedPackages = input.tracked
      .filter((t) => input.packageClasses.has(t.className))
      .map((t) => {
        const keyFrameMediaId = this.residents.keyFrameMediaId(t.trackId)
        return {
          className: t.className,
          bbox: { ...t.bbox },
          trackId: t.trackId,
          confidence: t.confidence,
          ...(keyFrameMediaId !== undefined ? { keyFrameMediaId } : {}),
        }
      })
    const personBoxes = input.tracked
      .filter((t) => t.className === 'person')
      .map((t) => ({ x: t.bbox.x, y: t.bbox.y, w: t.bbox.w, h: t.bbox.h }))
    const { sightings, drops } = packageLookSightings({
      looked: lookEvidence.looked === true,
      rawKept,
      trackedPackages,
      personBoxes,
      frameWidth: input.frameWidth,
      frameHeight: input.frameHeight,
      referenceAreaPx: ref.areaPx,
      referenceKind: ref.kind,
      minAreaFrac: input.settings.packageDropMinBboxAreaFrac,
      maxAreaFrac: input.settings.packageDropMaxBboxAreaFrac,
    })
    for (const drop of drops) {
      if (drop.reason === 'above-area-ceiling') {
        const lastLogAt = this.frameState.packageOversizeLogAt.get(input.deviceId) ?? 0
        if (input.timestamp - lastLogAt >= 5 * 60_000) {
          this.frameState.packageOversizeLogAt.set(input.deviceId, input.timestamp)
          this.ctx.logger.info('package sighting dropped — bbox above the maximum area', {
            tags,
            meta: {
              bbox: drop.bbox,
              areaFrac: Number(drop.areaFrac.toFixed(5)),
              maxAreaFrac: input.settings.packageDropMaxBboxAreaFrac,
              score: drop.score,
              frame: [input.frameWidth, input.frameHeight],
            },
          })
        }
      }
    }
    const episodeDrops = drops.filter(
      (d) => d.reason === 'person-overlap' || d.reason === 'below-area-floor',
    )
    const previous =
      this.frameState.packageLookDropReasons.get(input.deviceId) ?? new Set<PackageLookDropReason>()
    const { announce, next } = nextPackageLookDropEpisodes(previous, episodeDrops)
    this.frameState.packageLookDropReasons.set(input.deviceId, next)
    for (const drop of announce) {
      const message =
        drop.reason === 'person-overlap'
          ? 'package box dropped — overlaps a person'
          : 'package box dropped — bbox under the area floor'
      this.ctx.logger.info(message, {
        tags,
        meta: {
          reason: drop.reason,
          bbox: drop.bbox,
          areaFrac: Number(drop.areaFrac.toFixed(5)),
          referenceKind: drop.referenceKind,
          score: drop.score,
          frame: [input.frameWidth, input.frameHeight],
        },
      })
    }
    const lastActivityAt = this.frameState.lastNonPackageActivityAt.get(input.deviceId)
    const planned = planPackageSceneFrame(input.deviceId, {
      rules: input.packageRules,
      zones: input.zones,
      sightings,
      tracked: input.tracked.map((t) => ({ className: t.className, zones: t.zones, bbox: t.bbox })),
      frameWidth: input.frameWidth,
      frameHeight: input.frameHeight,
      frameHandle: input.frameHandle,
      timestamp: input.timestamp,
      minAreaFrac: input.settings.packageDropMinBboxAreaFrac,
      modelBoxes: rawKept.map((box) => ({ bbox: box.bbox, score: box.score })),
    })
    if (planned.note !== null) this.packageSceneCoordinator().note(planned.note)
    const outcome = this.frameState.packageStillness.observe({
      deviceId: input.deviceId,
      sightings: planned.sightings,
      frameWidth: input.frameWidth,
      frameHeight: input.frameHeight,
      timestamp: input.timestamp,
      minHits: input.settings.packageDropMinFrames,
      minDwellMs: input.settings.packageDropDwellSec * 1000,
      activityWindowMs: input.settings.packageDropActivityWindowSec * 1000,
      ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
      ...lookEvidence,
    })
    this.bridgePackageStillness({
      deviceId: input.deviceId,
      outcome,
      timestamp: input.timestamp,
      settings: input.settings,
      ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
      via: 'frame',
    })
  }

  /**
   * Judge the package TTL without a frame (F4) — on the existing TTL sweep
   * tick, for the devices holding a candidate. The tracker concludes only a
   * parcel the step looked for and did not find; see
   * `PackageStillnessTracker.sweep`.
   */
  /**
   * The tick's entry point: a throw here is an uncaught exception in a timer
   * callback, so it is caught and named (review M3). Per-device throws are
   * already caught inside the driver, so one camera cannot stop the others.
   */
  private runPackageStillnessSweep(now: number): void {
    try {
      this.sweepPackageStillness(now)
    } catch (err) {
      this.ctx.logger.warn('package stillness sweep threw', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  private sweepPackageStillness(now: number): void {
    if (this.packageDropDetector === null) return
    sweepPackageStillness({
      tracker: this.frameState.packageStillness,
      now,
      activityWindowMsFor: (deviceId) =>
        this.packageDropSettingsFromCache(deviceId).packageDropActivityWindowSec * 1000,
      lastActivityAtFor: (deviceId) => this.frameState.lastNonPackageActivityAt.get(deviceId),
      onOutcome: (deviceId, outcome, at) => {
        const lastActivityAt = this.frameState.lastNonPackageActivityAt.get(deviceId)
        this.bridgePackageStillness({
          deviceId,
          outcome,
          timestamp: at,
          settings: this.packageDropSettingsFromCache(deviceId),
          ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
          via: 'sweep',
        })
      },
      onDeviceError: (deviceId, err) => {
        this.ctx.logger.warn('package stillness sweep threw', {
          tags: { deviceId },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      },
    })
  }

  /**
   * Bridge one stillness outcome into `PackageDropDetector` — the SAME
   * `onStationaryChange` contract the generic registry uses. A frame's outcome
   * and a sweep's take this one path, so a pick-up concluded without a frame
   * is logged, paired and notified exactly like one concluded on a frame.
   */
  private bridgePackageStillness(input: PackageStillnessBridgeInput): void {
    if (this.packageDropDetector === null) return
    const tags = { deviceId: input.deviceId }
    const { outcome, lastActivityAt } = input
    for (const entry of outcome.promoted) {
      // Background net: a position that has already produced ghost
      // delivered→vanished cycles with never a real pick-up is scenery.
      // Sync RAM read (D49) — the promotion path never waits on SQLite.
      const centroid = {
        x: entry.bbox.x + entry.bbox.w / 2,
        y: entry.bbox.y + entry.bbox.h / 2,
      }
      const verdict = this.packageBackground?.isBackground({
        deviceId: input.deviceId,
        className: entry.className,
        x: centroid.x,
        y: centroid.y,
        now: input.timestamp,
      })
      if (verdict?.background === true) {
        this.ctx.logger.info('package delivery suppressed — background position', {
          tags,
          meta: {
            entryId: entry.id,
            className: entry.className,
            bbox: entry.bbox,
            cell: verdict.cell,
            ghostCyclesInWindow: verdict.cyclesInWindow,
            ...(entry.confidence !== undefined ? { confidence: entry.confidence } : {}),
          },
        })
        continue
      }
      this.ctx.logger.info('package promoted to stationary (dedicated path)', {
        tags,
        meta: {
          entryId: entry.id,
          className: entry.className,
          bbox: entry.bbox,
          dwellMs: entry.becameStationaryAt - entry.firstSeenAt,
          ...(entry.sourceTrackId !== undefined ? { trackId: entry.sourceTrackId } : {}),
          ...(entry.confidence !== undefined ? { confidence: entry.confidence } : {}),
        },
      })
      void this.packageDropDetector.onStationaryChange({
        phase: 'appeared',
        entry,
        timestamp: entry.becameStationaryAt,
      })
    }
    for (const entry of outcome.departed) {
      this.ctx.logger.info('package no longer observed (dedicated path)', {
        tags,
        meta: {
          entryId: entry.id,
          className: entry.className,
          unseenForMs: input.timestamp - entry.lastConfirmedAt,
          via: input.via,
          // WHICH rule concluded it: the TTL, or positive evidence (D687).
          rule: outcome.earlyDepartureIds.includes(entry.id) ? 'early' : 'ttl',
        },
      })
      // A real pick-up proves the position is a genuine delivery spot —
      // clear any ghost-cycle memory there.
      void this.packageBackground
        ?.noteRealPickup({
          deviceId: input.deviceId,
          className: entry.className,
          x: entry.bbox.x + entry.bbox.w / 2,
          y: entry.bbox.y + entry.bbox.h / 2,
        })
        .then((cleared) => {
          if (cleared) {
            this.ctx.logger.info('package background cell cleared — a real pick-up happened', {
              tags,
              meta: { entryId: entry.id },
            })
          }
        })
        .catch(() => undefined)
      // WHOSE picture the pick-up notification carries (D404). The instant is
      // the parcel's LAST SIGHTING, never `input.timestamp` — the departure is
      // concluded up to `PACKAGE_STILLNESS_TTL_MS` of observed time later, and
      // scoring against that would name whoever happened to walk past then.
      const collector = this.frameState.packageCollectors.pickCollector({
        deviceId: input.deviceId,
        pickupAt: pickupInstantOf(entry),
      })
      if (collector === null) {
        // Dropped work is logged: the notification still ships, carrying the
        // parcel's own frame, and this line is why.
        this.ctx.logger.info('package pick-up has no collector in the drop-off zone', {
          tags,
          meta: {
            entryId: entry.id,
            pickupAt: entry.lastConfirmedAt,
            departedAt: input.timestamp,
            presencesKnown: this.frameState.packageCollectors.debugPresenceCount(input.deviceId),
          },
        })
      }
      void this.packageDropDetector.onStationaryChange({
        phase: 'departed',
        entry,
        timestamp: input.timestamp,
        ...(collector !== null ? { collector } : {}),
      })
    }
    for (const entry of outcome.departedWithoutActivity) {
      // NOT bridged to the detector: a box that vanishes with nobody around
      // is the detector losing it (or the light turning off), not a pick-up.
      // Logged (dropped work), and remembered as a ghost cycle.
      this.ctx.logger.info('package pickup suppressed — nobody around the disappearance', {
        tags,
        meta: {
          entryId: entry.id,
          className: entry.className,
          bbox: entry.bbox,
          unseenForMs: input.timestamp - entry.lastConfirmedAt,
          ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
          via: input.via,
        },
      })
      void this.packageBackground
        ?.noteGhostCycle({
          deviceId: input.deviceId,
          className: entry.className,
          x: entry.bbox.x + entry.bbox.w / 2,
          y: entry.bbox.y + entry.bbox.h / 2,
          now: input.timestamp,
        })
        .then((r) => {
          if (r.background) {
            this.ctx.logger.info('package background cell armed — deliveries suppressed here', {
              tags,
              meta: { cell: r.cell, ghostCyclesInWindow: r.cyclesInWindow },
            })
          }
        })
        .catch(() => undefined)
    }
    for (const u of outcome.earlyEvidenceUnbacked) {
      // Complete early-pick-up evidence that concludes NOTHING (D687): a
      // branch that accepts work and drops it logs it. Once per candidate.
      this.ctx.logger.info('early pick-up evidence complete — nobody around, left to the TTL', {
        tags,
        meta: { entryId: u.id, reason: u.reason, via: input.via },
      })
    }
    for (const ex of outcome.expired) {
      // The 2026-08-18 13:41 lesson: a candidate that dies un-promoted in
      // silence hides a missed delivery for a day. Say WHY it never promoted.
      const observedDwellMs = ex.lastSeenAt - ex.firstSeenAt
      const requiredDwellMs = input.settings.packageDropDwellSec * 1000
      const requiredHits = input.settings.packageDropMinFrames
      const reasons: string[] = []
      if (!ex.activityBackedAtOpen) reasons.push('no-activity-before-open')
      if (ex.hits < requiredHits) reasons.push('hits')
      if (observedDwellMs < requiredDwellMs) reasons.push('dwell')
      this.ctx.logger.info('package candidate expired without promotion', {
        tags,
        meta: {
          candidateId: ex.id,
          className: ex.className,
          bbox: ex.bbox,
          hits: ex.hits,
          minHits: requiredHits,
          observedDwellMs,
          requiredDwellMs,
          activityBackedAtOpen: ex.activityBackedAtOpen,
          reasons,
        },
      })
    }
  }

  /**
   * Turn a candidate whose evidence is sufficient into a registry entry.
   *
   * The BOX, label and key-frame come from the evidence row — the best agreeing
   * sighting across every track that ever contributed — not from whichever
   * track happened to be alive on the tipping frame. That is the point of the
   * ledger: the object outlives its tracks, so the entry must be built from
   * what was learned about the object, not from the last one to see it.
   */
  private birthStationaryFromEvidence(input: {
    deviceId: number
    key: string
    processor: FrameProcessor
    track: TrackedDetectionOut
    row: StationaryEvidenceRow
    firstSeen: number
    frameWidth: number
    frameHeight: number
    timestamp: number
  }): void {
    const { deviceId, key, processor, track, row, firstSeen, frameWidth, frameHeight, timestamp } =
      input
    const label = row.label
    const keyFrameMediaId = row.keyFrameMediaId ?? this.residents.keyFrameMediaId(track.trackId)
    // No plausibility gate HERE, on purpose (D508). The ledger only tips a
    // candidate whose box clears the artifact rule (`implausible-box` is a
    // verdict shortfall, and a refused candidate keeps its evidence instead of
    // being forgotten and re-tipped every half hour), and it only tips on an
    // observation that AGREED — so `track` is a track OF the object, never a
    // one-position `entered` track that merely rotated the ratio window. An
    // oversize box is born like any other and neutered in the matcher, where
    // the damage was: at or above `OVERSIZE_AREA_FRAC` it holds strong reads
    // only and can swallow no neighbour.
    const areaFrac = Number(boxAreaFraction(row.bestBbox, frameWidth, frameHeight).toFixed(3))
    const entry: StationaryEntry = {
      id: randomUUID(),
      deviceId,
      className: row.className,
      bbox: { ...row.bestBbox },
      frameWidth,
      frameHeight,
      firstSeenAt: firstSeen,
      becameStationaryAt: timestamp,
      lastConfirmedAt: timestamp,
      sourceTrackId: row.sourceTrackId ?? track.trackId,
      ...(label !== undefined ? { label } : {}),
      ...(keyFrameMediaId !== undefined ? { keyFrameMediaId } : {}),
    }
    // The per-device suppress/wake sliders decide what "this spot is already
    // taken" means, exactly as they do on the frame path — the registry then
    // absorbs the promotion instead of minting a neighbour.
    const gate = this.stationarySettingsFromCache(deviceId)
    void this.stationaryRegistry?.promote(entry, {
      suppressIou: gate.suppressIou,
      wakeAssocIou: gate.wakeAssocIou,
    })
    // D683 round 4 (operator 2026-09-30): a promoted subject that ever MOVED
    // is a real track of a moving subject — it closes `stationary`, at its
    // last sighting, is KEPT and closes normally at its TTL, and a later piece
    // may still be linked to it. One that never moved was never a moving
    // subject: D547's disposal, unchanged. "Moved" is the store's running
    // judgement over every box the track was seen at (fix round 1, M1) — an
    // absent row (already swept) reads as never moved, and is disposed
    // exactly as before.
    const live = this.trackStore?.promotionPlanOf(track.trackId) ?? planPromotion([])
    // The tracker forgets the parked object — 'stationary' ends the chain at
    // its last sighting and leaves it linkable; 'dropped' ends it now and
    // never links (tracker-v2.ts `dropTrack`).
    processor.dropTrack(track.trackId, live.dropReason)
    // A tracker input no frame carries (spec §1): the replay must drop it too,
    // with the same reason it closed with live — tape/replay parity.
    this.tapeRecorder?.onDrop({
      deviceId,
      plane: processor.source,
      trackId: track.trackId,
      atMs: timestamp,
      reason: live.dropReason,
    })
    // Marked NOW, before anything below awaits: its last box IS the entry's
    // box, and the TTL close must never take it for a parked re-sighting
    // (review C1). The executor marks it again, idempotently.
    if (!live.disposeLiveTrack) this.trackStore?.markKeptAtPromotion(track.trackId)
    let recognizersSettled: Promise<unknown> = Promise.resolve()
    if (live.disposeLiveTrack) {
      // Live per-track state teardown — mirrors sweepExpiredTracks MINUS the 'end'
      // key-event, importance scoring + media-capture flush. Face/plate
      // recognizers still get their normal end (they read the key frame first) so
      // no per-track recognizer state leaks. A KEPT track skips all of this: its
      // ordinary close runs the same litany.
      const faceEnd = this.faceRecognizer?.onTrackEnd(deviceId, track.trackId)
      const dropKeyFrame = (): void => {
        this.residents.dropKeyFrameMediaId(track.trackId)
      }
      if (faceEnd) void faceEnd.finally(dropKeyFrame)
      else dropKeyFrame()
      // Same trail the sweep close hands over: the plate's durable keyFrame crop
      // needs it to tell a parked vehicle from a crossing one. `track` here is a
      // per-frame `TrackedDetectionOut` and carries no trail, so it comes off the
      // still-live store row — absent leaves the temporal bound in charge.
      const promotedPath = this.trackStore?.getActiveByTrack(track.trackId)?.positions
      const plateEnd = this.plateRecognizer?.onTrackEnd(deviceId, track.trackId, promotedPath)
      // Disposal waits for the recognizers, which read the key frame at their end.
      recognizersSettled = Promise.allSettled([faceEnd, plateEnd])
      // ONE close runs the FULL per-track litany (S1); the keyFrame key stays
      // readable until the deferred drop above settles.
      this.residents.close(track.trackId, 'stationary')
      this.detailDispatcher?.onTrackEnded(deviceId, track.trackId)
      this.overlayState.onTrackEnded(deviceId, track.trackId)
      // Don't let the next frame log a spurious 'track lost' for the promoted id.
      this.frameState.lastActiveTrackIds.get(key)?.delete(track.trackId)
    }
    const birth = {
      trackId: track.trackId,
      className: row.className,
      entryId: entry.id,
      // The numbers that justified it, so a birth can be argued with.
      agreed: row.agreed,
      seen: row.seen,
      agreementRatio: row.seen > 0 ? Number((row.agreed / row.seen).toFixed(3)) : 0,
      spanMs: row.lastAgreedAt - row.firstAgreedAt,
      // Per producer: the answer to "is the burst earning its keep here?".
      sessionAgreed: row.sessionAgreed,
      burstAgreed: row.burstAgreed,
      // How big, and whether the matcher will hold it on strong reads only
      // (D508). Size decides nothing at birth any more; it is logged because
      // "the parked car is a third of the frame" is the fact the next audit
      // asks first.
      areaFrac,
      oversize: areaFrac >= OVERSIZE_AREA_FRAC,
      dropReason: live.dropReason,
      ...(label ? { label } : {}),
    }
    // The TRACKS: each judged on its own path (review H3), the source through
    // the L2 chain (M4). One line per birth, naming what was kept and what went.
    this.settlePromotedTracks({
      deviceId,
      entry,
      processor,
      liveTrackId: track.trackId,
      live,
      sourceTrackId: row.sourceTrackId,
      recognizersSettled,
    })
      .then((effects) => {
        this.ctx.logger.info('stationary entry born from repeated evidence', {
          tags: { deviceId },
          meta: {
            ...birth,
            keptTrackIds: effects.keepTrackIds,
            disposedTrackIds: effects.disposeTrackIds,
            ...(effects.leftAloneSourceTrackId !== undefined
              ? { leftAloneSourceTrackId: effects.leftAloneSourceTrackId }
              : {}),
          },
        })
      })
      .catch((err: unknown) => {
        this.ctx.logger.warn('stationary entry born — its tracks could not be settled', {
          tags: { deviceId },
          meta: { ...birth, error: String(err) },
        })
      })
  }

  /**
   * What the promotion does to each track that carried its evidence (D683
   * round 4, fix round 1): the live one on the tipping frame and the source
   * of the entry's best box. Moved → kept, closes normally; never moved →
   * D547's disposal, once the recognizers have read the key frame.
   */
  private async settlePromotedTracks(input: {
    readonly deviceId: number
    readonly entry: StationaryEntry
    readonly processor: FrameProcessor
    readonly liveTrackId: string
    readonly live: PromotionPlan
    readonly sourceTrackId: string | undefined
    readonly recognizersSettled: Promise<unknown>
  }): Promise<PromotionEffects> {
    const source = await this.readPromotionSource(input)
    const effects = planPromotionEffects({
      liveTrackId: input.liveTrackId,
      live: input.live,
      ...(source !== undefined ? { source } : {}),
    })
    await executePromotionEffects(effects, {
      markKept: (trackId) => {
        this.trackStore?.markKeptAtPromotion(trackId)
      },
      beforeDispose: input.recognizersSettled,
      dispose: (trackIds) => this.disposePromotedTracks(input.deviceId, input.entry, trackIds),
    })
    return effects
  }

  /**
   * The SOURCE of the entry's best box, judged on its OWN movement (review
   * H3): the running judgement while it is active, the row's persisted
   * `moved` verdict once it has closed (R2). It shares the live track's fate
   * when it is in the same L2 chain (review M4). A read that FAILS, or a row
   * that predates the verdict, answers `plan: null` — the source is left
   * alone; a row that is simply not there reads as never moved, as before.
   */
  private async readPromotionSource(input: {
    readonly deviceId: number
    readonly processor: FrameProcessor
    readonly liveTrackId: string
    readonly sourceTrackId: string | undefined
  }): Promise<PromotionSource | undefined> {
    const { deviceId, processor, liveTrackId, sourceTrackId } = input
    if (sourceTrackId === undefined || sourceTrackId === liveTrackId) return undefined
    if (processor.rootOf(sourceTrackId) === processor.rootOf(liveTrackId)) {
      return { trackId: sourceTrackId, plan: null, sameChainAsLive: true }
    }
    const store = this.trackStore
    const active = store?.promotionPlanOf(sourceTrackId) ?? null
    if (active !== null) return { trackId: sourceTrackId, plan: active, sameChainAsLive: false }
    if (!store) return { trackId: sourceTrackId, plan: null, sameChainAsLive: false }
    try {
      // Its own verdict, judged on every box as it arrived — never the
      // persisted trail, which has forgotten a walk-in after a dwell (R2).
      const persisted = await store.getPersistedByTrackId(sourceTrackId)
      return {
        trackId: sourceTrackId,
        plan: planForPersistedSource(persisted),
        sameChainAsLive: false,
      }
    } catch (err) {
      this.ctx.logger.warn('stationary promotion: source track unreadable — left alone', {
        tags: { deviceId },
        meta: { deviceId, trackId: sourceTrackId, error: String(err) },
      })
      return { trackId: sourceTrackId, plan: null, sameChainAsLive: false }
    }
  }

  private async getOrCreateProcessor(
    deviceId: number,
    source: DetectionSource,
  ): Promise<FrameProcessor> {
    const key = this.procKey(deviceId, source)
    let p = this.frameState.processors.get(key)
    if (!p) {
      const inputs: FrameProcessorInputs = {
        sensitivity: await this.resolveDeviceDetectionSensitivitySettings(deviceId),
        tracking: await this.resolveDeviceTrackingSettings(deviceId),
        stillSpeedFracPerSec: resolveStillSpeedFracPerSec(
          await this.resolveDeviceStillnessSettings(deviceId),
        ),
      }
      p = createFrameProcessor(deviceId, source, inputs)
      this.frameState.processorInputs.set(key, inputs)
      this.tapeRecorder?.noteProcessor(deviceId, source, inputs)
      // D683: tracker v2's split / link facts, stamped with the camera. The
      // old tracker's salvage-bind, track-loss and spawn-beside-coasting lines
      // described mechanisms v2 does not have (it splits on doubt and lets L2
      // link the pieces); their questions are answered by the split and link
      // lines and the per-minute summary.
      this.wireTrackerObservers(p, deviceId, source)
      // The OPPOSITE failure: a detection that reached the tracker and became
      // no subject at all. `info`, not `debug` — a dropped subject is the
      // thing an operator reports ("the dog was there and you said nothing"),
      // and on 2026-09-07 the only way to tell a score floor from a
      // person-over-animal fold from an association absorption was to deploy
      // instrumentation and wait for the dog to come back. Sampled inside the
      // tracker (first ten of each reason, then every tenth, with the exact
      // running total on `refusalCount`).
      p.setSpawnRefusalObserver((record) => {
        // One line, one vocabulary, for every branch between "a detection
        // arrived" and "a position was stored" — the zone filter, the spawn
        // gates, the association absorptions, the merge, and the emission
        // gate a sub-`minHits` track dies under (D391). The suffix is
        // deliberately about the OUTCOME rather than about a spawn: a merged
        // duplicate had a track and still produced nothing.
        this.ctx.logger.info('tracker: detection dropped — nothing downstream received it', {
          tags: { deviceId },
          meta: { source, ...record },
        })
      })
      // A detection refused INSIDE a watched zone. Diagnostics only — this
      // never becomes an event, so no rule can alert on it (D426). It exists
      // to answer one question with numbers instead of guesses: is there a
      // class of refusal we are wrong to throw away? Ten hours of the
      // previous, event-emitting shape said the population is overwhelmingly
      // stationary (1473 of 1511 were one parcel at a door) and that the only
      // two alerts it raised were phantoms the gate had rightly refused.
      // `seenSoFar` is the UNthrottled total, so the volume is readable even
      // though identical refusals are collapsed for a minute.
      // A track that was born already carrying a zone. This is the line the
      // 2026-09-10 cat needed and did not have: the passage through the
      // flowerbed happened two seconds before the track existed, and nothing
      // recorded that the birth had inherited anything (D430).
      p.setBirthZoneTrailObserver((trail) => {
        this.ctx.logger.info('track born carrying zones it crossed before it was a track', {
          tags: { deviceId },
          meta: { source, ...trail },
        })
      })
      p.setZoneRefusalObserver((observation) => {
        this.ctx.logger.info('detection refused inside a watched zone — not notified', {
          tags: { deviceId },
          meta: { source, ...observation },
        })
      })
      // Every object event of a track carries the track's label, including the
      // ones emitted AFTER the recogniser answered — the in-RAM active-track
      // cache, the same read `hasTrackLabel` uses, no I/O on the frame path.
      p.setTrackLabelState((trackId) => {
        const active = this.trackStore?.getActiveByTrack(trackId)
        return active !== null && active !== undefined
          ? {
              className: active.className,
              ...(active.label !== undefined ? { label: active.label } : {}),
              ...(active.labelScore !== undefined ? { labelScore: active.labelScore } : {}),
              ...(active.labelMeta !== undefined ? { labelMeta: active.labelMeta } : {}),
              ...(active.subLabel !== undefined ? { subLabel: active.subLabel } : {}),
              ...(active.subLabelScore !== undefined
                ? { subLabelScore: active.subLabelScore }
                : {}),
              ...(active.subLabelMeta !== undefined ? { subLabelMeta: active.subLabelMeta } : {}),
            }
          : undefined
      })
      // Parked-object suppression runs on the ML `pipeline` plane only (where
      // the measured 102 re-spawn flood + detail-plane re-cost originate). The
      // gate reads the registry each frame, bound to this device.
      if (planeRunsStationary(source) && this.stationaryRegistry) {
        const registry = this.stationaryRegistry
        p.setStationaryGate({
          // SpatialDetection carries the macro-class on `.class`; the registry
          // matcher speaks `className`. Map preserves index order, so the
          // returned suppressedIndices line up with the detection array.
          filter: (input) => {
            // Per-device settings (#31), read synchronously from the warmed
            // cache. The master toggle OFF ⇒ no suppression (every detection
            // spawns a normal track); otherwise the per-device suppress/wake
            // IoU sliders drive the partition.
            const s = this.stationarySettingsFromCache(deviceId)
            if (!s.enabled) {
              return {
                suppressedIndices: new Set(),
                continuableIndices: new Set(),
                confirmed: [],
                woken: [],
              }
            }
            const matchConfig: StationaryMatchConfig = {
              suppressIou: s.suppressIou,
              wakeAssocIou: s.wakeAssocIou,
            }
            return registry.filter(
              {
                deviceId,
                detections: input.detections.map((d) => ({
                  bbox: d.bbox,
                  className: d.class,
                })),
                frameWidth: input.frameWidth,
                frameHeight: input.frameHeight,
                timestamp: input.timestamp,
              },
              matchConfig,
            )
          },
        })
      }
      this.frameState.processors.set(key, p)
    }
    return p
  }

  /**
   * Resolve and cache a {@link DeviceProxy} for a device. Pins the
   * `state.zones` + `state.zoneRules` slice handles so `.value` stays
   * warm via the kernel runtime-state mirror. Slice subscribers also
   * forward updates to the per-device FrameProcessor so a rule change
   * applies to the very next frame even when frames stop briefly
   * (e.g. during binding flips).
   *
   * RECONCILE: the push channel behind `subscribe` is `device.state-changed`
   * via the addon's `ctx.eventBus` (`createEventBusSliceSource`). That
   * declares UDS interest so the parent actually fans the slice here. Events
   * remain lossy (D8); `refresh()` round-trips `deviceState.getCapSlice` on
   * this timer as the backstop.
   */
  private async ensureProxy(deviceId: number): Promise<DeviceProxy | null> {
    const cached = this.proxies.get(deviceId)
    if (cached) return cached
    try {
      const proxy = (await this.ctx.api!.deviceManager)
        ? await this.ctx.fetchDevice(deviceId)
        : null
      if (!proxy) return null
      this.proxies.set(deviceId, proxy)
      const reconcile = setInterval(() => {
        void proxy.state.zones.refresh().catch(() => undefined)
        void proxy.state.zoneRules.refresh().catch(() => undefined)
      }, ZONE_SLICE_RECONCILE_MS)
      reconcile.unref?.()
      const unsubs = [
        proxy.state.zones.subscribe((slice) => {
          const zones = slice?.zones ?? []
          this.forEachDeviceProcessor(deviceId, (p) => p.setZones(zones))
          // The mirror moved — drop the cap-side catalogue so an operator who
          // deletes their LAST zone is not shadowed by a cached non-empty
          // answer for the rest of the TTL.
          this.deviceZones.invalidate(deviceId)
        }),
        proxy.state.zoneRules.subscribe((slice) => {
          const rules = slice?.detection ?? []
          this.forEachDeviceProcessor(deviceId, (p) => p.setDetectionRules(rules))
        }),
        (): void => clearInterval(reconcile),
      ]
      this.proxyUnsubs.set(deviceId, unsubs)
      return proxy
    } catch (err: unknown) {
      this.ctx.logger.debug('analytics ensureProxy failed', {
        tags: { deviceId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return null
    }
  }

  /**
   * Resolve a device's current 0–1 zone catalogue independent of the live
   * frame path — used by zone-analytics snapshot hydration + the occupancy
   * baseline sampler when the camera is detached (no frames). Warms the proxy
   * (cold read via `fetchDevice`) so the mirror fast path has something to
   * read, then goes through the SAME resolver the live frame path uses.
   *
   * `readSliceOnce(proxy.state.zones)` used to be the whole body, and it is
   * exactly what could not answer for device 102: the mirror slice was absent
   * hub-side (`deviceState.getCapSlice {102,'zones'}` → `null`), so the one
   * permitted refresh brought back nothing and hydration fell to `[]` forever.
   */
  private async resolveDeviceZones(deviceId: number): Promise<readonly Zone[]> {
    await this.ensureProxy(deviceId)
    return this.deviceZones.resolve(deviceId)
  }

  private releaseProxy(deviceId: number): void {
    const unsubs = this.proxyUnsubs.get(deviceId)
    if (unsubs) {
      for (const u of unsubs) {
        try {
          u()
        } catch {
          /* swallow */
        }
      }
    }
    this.proxyUnsubs.delete(deviceId)
    this.proxies.delete(deviceId)
    this.deviceZones.forgetDevice(deviceId)
  }

  // ── Cap query methods ────────────────────────────────────────────────

  // ── Thin query/prune delegates (S8) — bodies in analytics-query-facade.ts ──

  async getActiveTracks(input: { deviceId: number }): Promise<readonly Track[]> {
    return this.queryFacade.getActiveTracks(input)
  }

  async getTrack(input: { deviceId: number; trackId: string }): Promise<Track | null> {
    return this.queryFacade.getTrack(input)
  }

  async listTracks(input: {
    deviceId: number
    since?: number
    until?: number
    limit?: number
    zone?: TrackZoneFilter
    projection?: TrackProjection
    includeStationary?: boolean
    /** Track classes to keep. Absent or empty ⟺ no filter — see the cap. */
    classes?: readonly string[]
    /** Track SOURCES to leave out. Absent or empty ⟺ no filter — see
     *  `ExcludeSourcesDoc` in the cap. */
    excludeSources?: readonly TrackSource[]
  }): Promise<readonly Track[]> {
    return this.queryFacade.listTracks(input)
  }

  async listRecentTracks(input: {
    deviceIds: number[]
    since?: number
    until?: number
    limit?: number
    cursor?: string
    projection?: TrackProjection
    includeStationary?: boolean
    /** Track classes to keep. Absent or empty ⟺ no filter — see the cap. */
    classes?: readonly string[]
    /** Track SOURCES to leave out. Absent or empty ⟺ no filter — see
     *  `ExcludeSourcesDoc` in the cap. */
    excludeSources?: readonly TrackSource[]
  }): Promise<RecentTracksPage> {
    return this.queryFacade.listRecentTracks(input)
  }

  /**
   * Every event kind the device can produce: built-ins (motion + audio), the
   * detection classes its CONFIGURED pipeline can emit, and sensor kinds from
   * LINKED devices (device-manager `getLinkedDevices`, binding-driven per
   * linked device). Degrades to the built-ins on error.
   *
   * The detection and audio facts are read from `resolvePipeline` — the
   * configuration — and never from `getCameraStatus`, which is RUNTIME: an
   * on-motion camera holds no session between motion events
   * (`reasons.detection: 'armed:on-motion'`, `detection: null`) and was being
   * advertised as detecting nothing while its tracks said person / vehicle /
   * animal ([D449](../../../../docs/decisions/adr-0449-the-timeline-taxonomy-is-the-configured-one-raw-forward-has-no-switch-and-a-one-row-write-waits-on-the-disk.md)).
   */
  async listEventKinds(input: { deviceId: number }): Promise<readonly EventKindDescriptor[]> {
    const api = this.ctx.api
    const emittable = await this.emittableFromConfig(input.deviceId, 'listEventKinds')

    return composeEventKinds(
      {
        linkedDevices: {
          getLinkedDevices: (i) => api.deviceManager.getLinkedDevices.query(i),
        },
        bindings: {
          getBindings: (i) => api.deviceManager.getBindings.query(i),
        },
        enabledMacroClasses: async () => emittable.macroClasses,
        audioEnabled: async () => emittable.audioEnabled,
        packageZonesEnabled: async (deviceId) => {
          const rules = await this.resolveDevicePackageRules(deviceId)
          return rules.some((r) => r.enabled !== false)
        },
        onError: (scope, err) =>
          this.ctx.logger.warn('listEventKinds: partial compose', {
            tags: { deviceId: input.deviceId },
            meta: { scope, error: errMsg(err) },
          }),
      },
      input.deviceId,
    )
  }

  /**
   * What one camera's configured pipeline can emit (`resolvePipeline`), or
   * the honest fallback when the orchestrator could not answer: nothing
   * advertised, and a WARN saying so. The cap's answer is a plain list, so it
   * has no room for "unknown" — that residual of D315 is named in D449; the
   * steady state (an armed camera with no session) is no longer in it.
   */
  private async emittableFromConfig(deviceId: number, scope: string): Promise<EmittableFromConfig> {
    try {
      const config = await this.ctx.api.pipelineOrchestrator.resolvePipeline.query({ deviceId })
      return emittableFromPipelineConfig(config)
    } catch (err: unknown) {
      this.ctx.logger.warn(`${scope}: resolvePipeline failed — no ML kinds advertised`, {
        tags: { deviceId },
        meta: { error: errMsg(err) },
      })
      return NO_EMITTABLE
    }
  }

  /**
   * `listEventKinds` for many cameras, in one call.
   *
   * The saving is not the round-trips the CALLER avoids — it is the fan-out
   * this method used to do on its own. Composing one camera's vocabulary asks
   * device-manager for its status, its linked devices, and the bindings of
   * itself plus each linked device; asked per camera that was 1 + N + (N +
   * linked) cross-process calls. Measured on the live hub 2026-08-25 over this
   * deployment's 30 cameras: 106 calls, of which 30 concurrent
   * `getLinkedDevices` alone took 4110 ms — each one runs a full-fleet
   * `listAll` inside device-manager and thirty of them QUEUE.
   *
   * Now two calls for the whole topology, whatever N is —
   * `prefetchDeviceTopology`'s `getLinkedDevicesBatch` + `getBindingsBatch` —
   * plus one `resolvePipeline` per camera, all in flight at once (D449; there
   * is no batch form of it). `composeEventKinds` is unchanged — it is handed
   * the same per-device client interfaces, backed by maps instead of RPC.
   *
   * A camera whose composition fails yields an EMPTY list rather than dropping
   * out of the response: a caller that asked for twelve and got eleven cannot
   * tell which one is missing, or that one is.
   */
  async listEventKindsBatch(input: {
    deviceIds: number[]
  }): Promise<readonly EventKindsForDevice[]> {
    const api = this.ctx.api
    const deviceIds = [...new Set(input.deviceIds)]

    // One `resolvePipeline` per camera, all in flight at once: there is no
    // batch form of it on the orchestrator today, and measured on the live hub
    // (32 cameras, 2026-09-11) the whole set answers in under a second. A
    // camera whose pipeline cannot be read degrades alone to "no ML kinds",
    // logged with its id, and never fails the batch.
    const emittableByDevice = new Map(
      await Promise.all(
        deviceIds.map(
          async (deviceId) =>
            [deviceId, await this.emittableFromConfig(deviceId, 'listEventKindsBatch')] as const,
        ),
      ),
    )

    // VERSION SKEW, not a design choice: this addon deploys on its own, so it
    // can be running against a hub whose `@camstack/server` closure predates
    // the two batch methods. That hub rejects them, and the per-device path is
    // the honest thing to do rather than answering an empty vocabulary for
    // every camera. It is logged at warn precisely so it does not become the
    // quiet steady state after the closure lands.
    const topology = await prefetchDeviceTopology(
      {
        getLinkedDevicesBatch: (i) => api.deviceManager.getLinkedDevicesBatch.query(i),
        getBindingsBatch: (i) => api.deviceManager.getBindingsBatch.query(i),
      },
      deviceIds,
    ).catch((err: unknown) => {
      this.ctx.logger.warn(
        'listEventKindsBatch: batched device topology unavailable — per-device fallback',
        { meta: { deviceCount: deviceIds.length, error: errMsg(err) } },
      )
      return null
    })

    return composeEventKindsForDevices(
      deviceIds,
      async (deviceId) => {
        const emittable = emittableByDevice.get(deviceId) ?? NO_EMITTABLE
        return composeEventKinds(
          {
            linkedDevices: topology?.linkedDevices ?? {
              getLinkedDevices: (i) => api.deviceManager.getLinkedDevices.query(i),
            },
            bindings: topology?.bindings ?? {
              getBindings: (i) => api.deviceManager.getBindings.query(i),
            },
            enabledMacroClasses: async () => emittable.macroClasses,
            audioEnabled: async () => emittable.audioEnabled,
            packageZonesEnabled: async (id) => {
              const rules = await this.resolveDevicePackageRules(id)
              return rules.some((r) => r.enabled !== false)
            },
            onError: (scope, err) =>
              this.ctx.logger.warn('listEventKindsBatch: partial compose', {
                tags: { deviceId },
                meta: { scope, error: errMsg(err) },
              }),
          },
          deviceId,
        )
      },
      (deviceId, err) =>
        this.ctx.logger.warn('listEventKindsBatch: compose threw — empty vocabulary', {
          tags: { deviceId },
          meta: { error: errMsg(err) },
        }),
    )
  }

  /** Per-camera sensor-event history (state changes of linked devices). */
  async getSensorEvents(input: {
    deviceId: number
    since?: number
    until?: number
    kinds?: string[]
    limit?: number
  }): Promise<readonly SensorEvent[]> {
    return this.queryFacade.getSensorEvents(input)
  }

  /**
   * Start the linked set's capture (ADR 0632) with the UNFILTERED camera list:
   * the centre applies the mute itself and says so per camera.
   */
  private startLinkedStills(
    data: SensorStateChangedData,
    timestamp: number,
    cameras: SensorNotificationCameras,
  ): NcLinkedStills | undefined {
    // Mapped by construction (`resolveSensorNotificationCameras` answers no
    // cameras for an unmapped cap) — an absent kind is no capture, not a guess.
    const sensorKind = EVENT_KIND_BY_CAP[data.capName]?.kind
    if (sensorKind === undefined) return undefined
    // The edge the evaluation will read off the same slice (D640) — absent
    // when it cannot say, which the gate reads as "capture".
    const sensorRaised = sensorRaisedOf(sensorKind, sensorSliceRecord(data.slice))
    try {
      return this.notificationCenter?.beginLinkedStills({
        sensorId: data.deviceId,
        sensorKind,
        ...(sensorRaised !== undefined ? { sensorRaised } : {}),
        cameraIds: cameras.mediaCameraIds,
        rowCameraIds: cameras.rowCameraIds,
        atMs: timestamp,
      })
    } catch (err) {
      this.ctx.logger.warn(
        'linked-camera capture could not start — the notification ships without it',
        {
          tags: { deviceId: data.deviceId },
          meta: {
            capName: data.capName,
            cameraIds: [...cameras.mediaCameraIds],
            error: errMsg(err),
          },
        },
      )
      return undefined
    }
  }

  /**
   * The ONE sensor-level evaluation of a linked set (ADR 0632). Its record is
   * the primary camera's row when that camera has one, else another camera's
   * row, else a camera-attributed event that is NOT a timeline row (no linking
   * camera opted the sensor in). The cameras that took a row travel as
   * `rowCameraIds`: with the sensor, what a camera-scoped rule matches on
   * (D630 §6).
   */
  private handOffLinkedSensorEvent(input: LinkedSensorHandOff): void {
    const { data, timestamp, persisted } = input
    const primary = input.mediaCameraIds[0]
    if (primary === undefined) return
    const row = persisted.find((ev) => ev.deviceId === primary) ?? persisted[0]
    const event: SensorEvent = row ?? {
      id: `pa-sensor-${randomUUID()}`,
      deviceId: primary,
      sourceDeviceId: data.deviceId,
      kind: EVENT_KIND_BY_CAP[data.capName]?.kind ?? data.capName,
      value: sensorSliceRecord(data.slice),
      timestamp,
    }
    const markerTrackId = input.markerByCamera.get(primary)?.trackId
    try {
      this.notificationCenter?.onSensorEvent({
        event: { ...event, deviceId: primary },
        linkedCameraIds: input.mediaCameraIds,
        rowCameraIds: persisted.map((ev) => ev.deviceId),
        ...(markerTrackId !== undefined ? { markerTrackId } : {}),
        ...(input.linkedStills !== undefined ? { linkedStills: input.linkedStills } : {}),
      })
    } catch (err) {
      this.ctx.logger.warn('sensor event hand-off to the notification centre failed', {
        tags: { deviceId: data.deviceId },
        meta: {
          kind: event.kind,
          linkedCameraIds: [...input.mediaCameraIds],
          error: errMsg(err),
        },
      })
    }
  }

  /**
   * The bus's door into {@link handleSensorStateChanged}: tracked, so shutdown
   * can drain it, and caught, so a throw is a tagged line instead of an
   * unhandled rejection. Refused once shutdown began.
   */
  private dispatchSensorStateChanged(
    data: SensorStateChangedData,
    timestampMs: number,
  ): Promise<void> {
    if (this.shuttingDown) return Promise.resolve()
    const run = this.handleSensorStateChanged(data, timestampMs).catch((err: unknown) => {
      // `ctxIfReady`: past the drain bound the context may already be gone.
      this.ctxIfReady?.logger.warn('sensor state change handler failed', {
        tags: { deviceId: data.deviceId },
        meta: { capName: data.capName, error: errMsg(err) },
      })
    })
    this.sensorHandlersInFlight.add(run)
    void run.finally(() => this.sensorHandlersInFlight.delete(run))
    return run
  }

  /** Wait for the in-flight sensor handlers, bounded — see {@link sensorHandlersInFlight}. */
  private async drainSensorHandlers(): Promise<void> {
    const inFlight = [...this.sensorHandlersInFlight]
    if (inFlight.length === 0) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const bound = new Promise<'bound'>((resolve) => {
      timer = setTimeout(() => resolve('bound'), SENSOR_HANDLER_DRAIN_MS)
    })
    const outcome = await Promise.race([
      Promise.all(inFlight).then(() => 'drained' as const),
      bound,
    ])
    clearTimeout(timer)
    if (outcome === 'bound') {
      this.ctx.logger.warn('shutdown: sensor handlers still running past the drain bound', {
        meta: { inFlight: this.sensorHandlersInFlight.size, boundMs: SENSOR_HANDLER_DRAIN_MS },
      })
    }
  }

  /**
   * Sensor-event ingest handler — `DeviceStateChanged` of a device exposing a
   * mapped sensor cap. Resolves the camera set through the TTL cache (the
   * device's LINKED cameras, plus the device itself when it is a camera
   * carrying the cap) and inserts ONE row per camera. Best-effort
   * (telemetry-lossy). The NOTIFICATION is not per row when more than one
   * camera links the sensor (ADR 0632): the linked cameras are photographed at
   * the trigger and the change is evaluated ONCE, at the sensor level.
   *
   * D8/D11 boundary, stated plainly: the ride here is the LOSSY
   * `DeviceStateChanged` bus, and there is no reconcile that replays a missed
   * press from the durable `doorbell.getStatus.lastPressedAt`. A dropped bus
   * event is a missing history row and a missing notification — never wrong
   * durable state.
   *
   * The FIRST question is whether the sensor changed at all. This event is
   * emitted on a slice diff, and a level cap's slice carries its transition
   * timestamp beside its boolean — so an availability flap or a device rebuild
   * re-emits with the boolean unmoved. Both the row and the marker are gated on
   * the same verdict, in that one place: two derivations of "did this happen"
   * is one too many, and it is the mistake this handler already made once with
   * "which cameras" (`resolveSensorEventCameras`).
   */
  private async handleSensorStateChanged(
    data: SensorStateChangedData,
    timestamp: number,
  ): Promise<void> {
    const store = this.sensorEventStore
    const cache = this.linkedCamerasCache
    if (store === null || cache === null) return
    if (!this.sensorSliceCarriedATransition(data)) return
    // Every camera a notification about this change shows (ADR 0632) —
    // resolved and photographed NOW, before the rows and markers below are
    // awaited: the capture runs while they do, and the shelf's owners exist
    // synchronously. More than one ⇒ ONE sensor-level evaluation at the end.
    // A failed resolution is no set: the per-row path below, as before (D49).
    const cameras = await resolveSensorNotificationCameras(cache, data).catch(
      (err: unknown): SensorNotificationCameras => {
        this.ctx.logger.debug('linked-camera resolution failed — evaluated per row', {
          tags: { deviceId: data.deviceId },
          meta: { capName: data.capName, error: errMsg(err) },
        })
        return NO_SENSOR_NOTIFICATION_CAMERAS
      },
    )
    // ADR 0632 + link-alone media: ≥2 cameras always use the sensor-level
    // shelf path; exactly ONE linked camera with NO tracked row also does —
    // otherwise it falls through to unowned text-only despite a live link.
    // One tracked camera keeps today's per-row + marker path (no double capture).
    const linkedSet =
      cameras.mediaCameraIds.length > 1 ||
      (cameras.mediaCameraIds.length === 1 && cameras.rowCameraIds.length === 0)
    const linkedStills = linkedSet ? this.startLinkedStills(data, timestamp, cameras) : undefined
    // The rows this state change inserted, HELD rather than handed straight to
    // the notification centre — see the projection below for why.
    const persisted: SensorEvent[] = []
    // A sensor no camera takes a row for (linked to none, or only by cameras
    // that did not opt it in): no row, but still evaluated (D630 §6) — held
    // the same way, handed over after the projection below.
    const unowned: UnownedSensorEvent[] = []
    try {
      await ingestSensorStateChange(
        {
          sink: store,
          cache,
          onPersisted: (ev) => persisted.push(ev),
          onUnowned: (u) => unowned.push(u),
          // A mapped sensor cap that ingests NOTHING says so. Silence here is
          // what let camera 101's doorbell press produce no row, no evaluation
          // and no line for months.
          onDropped: (reason, kind) => this.logSensorIngestDrop(data, reason, kind),
        },
        data,
        timestamp,
      )
    } catch (err) {
      this.ctx.logger.warn('sensor-event ingest failed', {
        tags: { deviceId: data.deviceId },
        meta: { capName: data.capName, error: errMsg(err) },
      })
    }
    this.flushCameraIndexUnknownDrops()
    // Project the event into a synthetic snapshot-carrying track per camera
    // the event belongs to (§8) — the SAME cameras the row ingest above used,
    // derived once in `resolveSensorEventCameras`. Debounced per
    // (camera, kind), best-effort (telemetry).
    //
    // It runs BEFORE the notification and the notification waits for it: the
    // marker carries the camera's frame, and it is the ONLY media a device
    // event owns. The durable row is already written at this point, so what is
    // being delayed is one notification by a bounded snapshot fetch
    // (`SENSOR_MARKER_SNAPSHOT_TIMEOUT_MS`) — never the record.
    const markerByCamera = new Map<number, SensorMarkerRef>()
    const materializer = this.syntheticTracks
    if (materializer !== null) {
      try {
        await projectSensorMarkers(
          {
            cache,
            markers: materializer,
            // Producing-device NAME so clients can label the synthetic marker.
            // Best-effort: a device-manager hiccup leaves the name unset (the
            // track still materializes), it never blocks the projection.
            producingDeviceName: (deviceId) => this.resolveProducingDeviceName(deviceId),
            onProjected: (r) => {
              markerByCamera.set(r.cameraId, {
                trackId: r.trackId,
                hasMedia: r.hasMedia,
              })
              // `debounced`: a second state change of the same event, inside
              // the (camera, kind) window, sharing the marker the first one
              // landed — its own reason, so one press never reads as two markers.
              this.ctx.logger.info('synthetic sensor-track projected', {
                tags: { deviceId: r.cameraId },
                meta: {
                  capName: r.capName,
                  kind: r.kind,
                  trackId: r.trackId,
                  reason: r.via,
                  sourceDeviceId: r.sourceDeviceId,
                  selfCamera: r.selfCamera,
                  // Whether the notification about this press has a picture to
                  // attach. `false` is the marker landing without its snapshot
                  // — the materializer's own line says which step failed.
                  hasMedia: r.hasMedia,
                },
              })
            },
            // A projection that lands NOTHING says why. Silence here is what
            // let camera 101's doorbell press produce a SensorEvent row, a ring
            // and a matched rule — and no marker — with nothing to grep for.
            // `debug` because both no-camera branches ride at bus rate (every
            // camera's native `motion`, every unlinked sensor in the fleet).
            onSkipped: (r) => {
              // A materialize that REJECTED is a bug on that camera — it rides
              // at warn with its message.
              if (r.error !== undefined) {
                this.ctx.logger.warn('synthetic sensor-track materialize rejected', {
                  tags: { deviceId: r.cameraId ?? r.sourceDeviceId },
                  meta: {
                    capName: r.capName,
                    kind: r.kind,
                    reason: r.reason,
                    sourceDeviceId: r.sourceDeviceId,
                    error: r.error,
                  },
                })
                return
              }
              // A camera WAS resolved and no marker exists for it: a real
              // failure now (a debounce shares the window's marker), and never
              // at bus rate — warn, so the text-only notification it causes
              // has its reason next to it (review L3).
              if (r.cameraId !== null && r.reason === 'not-materialized') {
                this.ctx.logger.warn('synthetic sensor-track NOT materialized', {
                  tags: { deviceId: r.cameraId },
                  meta: {
                    capName: r.capName,
                    kind: r.kind,
                    reason: r.reason,
                    sourceDeviceId: r.sourceDeviceId,
                  },
                })
                return
              }
              this.ctx.logger.debug('synthetic sensor-track NOT projected', {
                tags: { deviceId: r.cameraId ?? r.sourceDeviceId },
                meta: {
                  capName: r.capName,
                  kind: r.kind,
                  reason: r.reason,
                  sourceDeviceId: r.sourceDeviceId,
                },
              })
            },
          },
          data,
          timestamp,
        )
      } catch (err) {
        this.ctx.logger.warn(
          'synthetic sensor-track camera resolution / producing-device name read failed',
          {
            tags: { deviceId: data.deviceId },
            meta: { capName: data.capName, error: errMsg(err) },
          },
        )
      }
    }
    // NC device-event trigger (D-2), now carrying the marker the press just
    // produced as its media owner. The id is passed whether or not the marker
    // got its picture: it is the provenance of this notification either way,
    // and an owner that resolves to no media degrades through the ordinary
    // ladder (which says so) rather than through a second code path. A camera
    // with NO marker at all still notifies — text-only, and the centre names
    // that. Guarded by the centre's own `evaluationActive`.
    // Each hand-off is guarded: this handler runs under `void` on the bus, so
    // a throw here would be an unhandled rejection with no device on it — and
    // would skip every camera after the one that threw.
    if (linkedSet) {
      // ONE evaluation for the change — never one per row, and never the
      // unowned door as well: it is the same event.
      this.handOffLinkedSensorEvent({
        data,
        timestamp,
        mediaCameraIds: cameras.mediaCameraIds,
        persisted,
        markerByCamera,
        ...(linkedStills !== undefined ? { linkedStills } : {}),
      })
      return
    }
    for (const ev of persisted) {
      try {
        this.notificationCenter?.onSensorEventPersisted(
          ev,
          markerByCamera.get(ev.deviceId)?.trackId,
        )
      } catch (err) {
        this.ctx.logger.warn('sensor event hand-off to the notification centre failed', {
          tags: { deviceId: ev.deviceId },
          meta: { kind: ev.kind, sourceDeviceId: ev.sourceDeviceId, error: errMsg(err) },
        })
      }
    }
    // A sensor no camera takes a row for: its own device, no timeline row and
    // no marker — so an unlinked door contact can still fire a rule and reach
    // the alarm. The line says WHICH of the two it is.
    for (const { event: ev, linkedCameraIds } of unowned) {
      this.ctx.logger.debug(
        linkedCameraIds.length === 0
          ? 'sensor event linked to no camera — evaluated without a timeline row'
          : `sensor event linked to ${linkedCameraIds.length} camera(s), none opted into tracked events — evaluated without a timeline row`,
        {
          tags: { deviceId: ev.sourceDeviceId },
          meta: { kind: ev.kind, linkedCameraIds: [...linkedCameraIds] },
        },
      )
      try {
        this.notificationCenter?.onUnownedSensorEvent(ev, linkedCameraIds)
      } catch (err) {
        this.ctx.logger.warn('sensor event hand-off to the notification centre failed', {
          tags: { deviceId: ev.sourceDeviceId },
          meta: { kind: ev.kind, linkedCameraIds: [...linkedCameraIds], error: errMsg(err) },
        })
      }
    }
  }

  /**
   * True when this slice carried a real transition of its sensor.
   *
   * A cap with no boolean level (`doorbell`, `button`, `lock-control`,
   * `presence`, `enum-sensor`, `event-emitter`) always passes — its ARRIVAL is
   * the event, and gating it would re-ship the silence of 2026-08-08. A cap
   * that HAS one passes only when the boolean moved, in either direction — or,
   * for `cover`, whose level is its `state` word, only when the word changed
   * (a position tick or a same-word republish is a drop).
   *
   * A slice that is not an object at all is refused rather than defaulted to
   * `{}`: `evaluateSensorEdge` would read `non-boolean-value` from an empty
   * object, which looks like a sensor reporting nonsense when what happened is
   * that there was nothing to read. Same discipline as the recorder's
   * `parseSensorStateChanged`.
   *
   * The drops are SUMMARISED, never logged one by one: this path carries every
   * camera's native `motion` slice at motion rate.
   */
  private sensorSliceCarriedATransition(data: {
    deviceId: number
    capName: string
    slice?: unknown
  }): boolean {
    const slice = data.slice
    if (typeof slice !== 'object' || slice === null || Array.isArray(slice)) {
      this.ctx.logger.debug('sensor state change carried no slice — dropped', {
        tags: { deviceId: data.deviceId },
        meta: { capName: data.capName },
      })
      return false
    }
    const verdict = this.sensorTransitions.observe(data.deviceId, data.capName, { ...slice })
    this.flushSensorTransitionDrops()
    return verdict.changed
  }

  /**
   * One `info` line per (device, cap, reason) per window, or none.
   *
   * A branch that drops work says so — but this one drops ~0.6 events/s
   * fleet-wide in its steady state (every camera's native `motion`), so what it
   * says is a COUNT. The line an operator greps when a real contact produced no
   * marker is here, with the numeric `deviceId` of the SENSOR, and it says
   * which verdict swallowed it.
   */
  private flushSensorTransitionDrops(): void {
    for (const drop of this.sensorTransitions.takeDropSummary(Date.now())) {
      // First inactive sighting (and steady no-change) are the expected cold
      // seed after every analytics restart — they are not a swallowed contact.
      // Keep those at debug; every other refusal stays info so a real miss is
      // still greppable per deviceId.
      const level =
        drop.reason === 'baseline-seeded-inactive' || drop.reason === 'no-change' ? 'debug' : 'info'
      this.ctx.logger[level]('sensor state changes dropped — no transition', {
        tags: { deviceId: drop.deviceId },
        meta: { capName: drop.capName, reason: drop.reason, count: drop.count },
      })
    }
  }

  /**
   * One `info` line per (device, cap) per window for the evaluations refused
   * because the camera index has not answered, or none. It drops evaluations
   * (a contact that might trigger the alarm), so it is `info`; it is a COUNT
   * so a cold-start outage cannot log at bus rate. `unansweredCameraIds` names
   * the cameras whose links were never read (`cameraListRead: false` = not
   * even the camera list).
   */
  private flushCameraIndexUnknownDrops(): void {
    const summary = this.cameraIndexUnknownDrops.takeSummary(Date.now())
    if (summary.length === 0) return
    const gap = this.linkedCamerasCache?.gap()
    for (const drop of summary) {
      this.ctx.logger.info(
        'sensor events NOT evaluated — the camera index has not answered, so "linked to no camera" is unknown',
        {
          tags: { deviceId: drop.deviceId },
          meta: {
            capName: drop.capName,
            count: drop.count,
            reason: 'camera-index-unknown',
            cameraListRead: gap?.cameraListRead ?? false,
            unansweredCameraIds: [...(gap?.unansweredCameraIds ?? [])],
          },
        },
      )
    }
  }

  /**
   * Say out loud that a MAPPED sensor cap ingested nothing, and why.
   *
   * BOTH branches are `debug`, deliberately. After the self-camera fix neither
   * is a surprise any more — they are the two designed steady states, and both
   * ride at bus rate:
   *
   *  - `camera-native-cap` is EVERY camera's `motion` slice. Every provider
   *    binds a native `motion` cap on the camera device and motion churns
   *    continuously (camera 104 flaps at ~2 Hz), so an `info` here would be a
   *    log flood measured in millions of lines a day — its own outage.
   *  - `no-camera` is every sensor in the fleet that no camera links. Since
   *    D630 §6 it is still EVALUATED by the notification rules (through
   *    `onUnowned`) — this line only says no timeline row was written, and it
   *    fires only when no one took the camera-less event.
   *
   * What must never happen again is the branch being INVISIBLE: a doorbell
   * press that ingested nothing produced not one line for months. A debug line
   * carrying `deviceId`, `capName`, `kind` and `reason` answers "why is 101
   * dark" the moment anyone asks it.
   */
  private logSensorIngestDrop(
    data: { deviceId: number; capName: string },
    reason: SensorIngestDropReason,
    kind: string,
  ): void {
    if (reason === 'camera-index-unknown') {
      // Counted, not logged: on a cold start with the device manager down this
      // is every camera's `motion` at bus rate. The summary line names what
      // the index could not answer — `flushCameraIndexUnknownDrops`.
      this.cameraIndexUnknownDrops.record(data.deviceId, data.capName)
      return
    }
    const message =
      reason === 'camera-native-cap'
        ? 'sensor-event ingest produced NO row — the camera already emits this cap through its own path'
        : 'sensor-event ingest produced NO row — no camera takes a row for this device, and nothing took it for evaluation'
    this.ctx.logger.debug(message, {
      tags: { deviceId: data.deviceId },
      meta: { capName: data.capName, kind, reason },
    })
  }

  /**
   * Resolve the NAME of a device (the linked sensor/control that produced a
   * synthetic event) via the device-manager cap. Best-effort — returns
   * undefined on any lookup failure or an unknown device so the synthetic
   * track still materializes without a label.
   */
  private async resolveProducingDeviceName(deviceId: number): Promise<string | undefined> {
    const api = this.ctx?.api
    if (!api) return undefined
    try {
      const dev = await api.deviceManager.getDevice.query({ deviceId })
      return dev?.name
    } catch (err) {
      this.ctx?.logger?.debug('resolveProducingDeviceName failed', {
        tags: { deviceId },
        meta: { error: errMsg(err) },
      })
      return undefined
    }
  }

  async clearTracks(input: { deviceId: number }): Promise<void> {
    this.trackStore?.clearDevice(input.deviceId)
    // S1 leak fix: close EVERY resident track of the device (was: only the
    // closure-state map — the other per-track containers leaked).
    this.residents.closeDevice(input.deviceId)
    // Operator clear = also forget the device's parked objects (delete rows).
    void this.stationaryRegistry?.clearDevice(input.deviceId)
    // The scene this camera's phantom cells describe is gone with it. A
    // wrapper-off / unregister deliberately does NOT do this: the plant is
    // still there when the camera comes back.
    void this.phantomCells?.clearDevice(input.deviceId)
    // The evidence for this camera's parked objects goes with it.
    void this.stationaryEvidence?.clearDevice(input.deviceId)
    // Same contract for the package background memory.
    void this.packageBackground?.clearDevice(input.deviceId)
    this.overlayState.clearDevice(input.deviceId)
    this.frameState.overlaySynthesisWarnAt.delete(input.deviceId)
    const prefix = `${input.deviceId}:`
    for (const k of this.frameState.lastActiveTrackIds.keys()) {
      if (k.startsWith(prefix)) this.frameState.lastActiveTrackIds.delete(k)
    }
  }

  async getMotionEvents(input: {
    deviceId: number
    since?: number
    until?: number
    limit?: number
    projection?: 'full' | 'slim'
  }): Promise<readonly MotionEvent[]> {
    return this.queryFacade.getMotionEvents(input)
  }

  async getEventDensity(input: {
    deviceId: number
    since: number
    until: number
    bucketMs: number
  }): Promise<readonly EventDensityBucket[]> {
    return this.queryFacade.getEventDensity(input)
  }

  /** The same histogram for a SET of cameras, in one round trip — every
   *  requested id gets a row, and an unreadable camera is MARKED. See
   *  `AnalyticsQueryFacade.getEventDensityBatch`. */
  async getEventDensityBatch(input: {
    deviceIds: readonly number[]
    since: number
    until: number
    bucketMs: number
  }): Promise<readonly EventDensityForDevice[]> {
    return this.queryFacade.getEventDensityBatch(input)
  }

  async getObjectEvents(input: {
    deviceId: number
    since?: number
    until?: number
    classFilter?: string
    limit?: number
    projection?: 'full' | 'slim'
  }): Promise<readonly ObjectEvent[]> {
    return this.queryFacade.getObjectEvents(input)
  }

  async getKeyEvents(input: {
    deviceId: number
    since: number
    until: number
    limit?: number
    minImportance?: number
    classFilter?: string
  }): Promise<readonly KeyEvent[]> {
    const trackStore = this.trackStore
    if (!trackStore) return []
    const eventStore = this.eventStore
    try {
      // Over-fetch candidate tracks in the window; rankKeyEvents ranks by
      // importance (scoring legacy rows on read) and trims to `limit`.
      const candidates = await trackStore.queryHistorical({
        deviceId: input.deviceId,
        since: input.since,
        until: input.until,
        limit: KEY_EVENT_CANDIDATE_CAP,
      })
      const peakLookup: PeakLookup = (trackId) =>
        eventStore
          ? eventStore.peakForTrack(trackId)
          : Promise.resolve({
              peakConfidence: 0,
              peakBboxAreaFrac: 0,
              bestEventId: undefined,
            })
      return await rankKeyEvents(
        candidates,
        {
          limit: input.limit ?? KEY_EVENT_DEFAULT_LIMIT,
          ...(input.minImportance !== undefined ? { minImportance: input.minImportance } : {}),
          ...(input.classFilter !== undefined ? { classFilter: input.classFilter } : {}),
        },
        peakLookup,
      )
    } catch (err) {
      this.ctx.logger.debug('getKeyEvents failed', {
        meta: { error: String(err) },
      })
      return []
    }
  }

  /**
   * `getKeyEvents` for a SET of cameras, in one round trip.
   *
   * The Detection Intelligence events feed asked this of every selected camera
   * on a 30 s timer — N browser → hub → post-analysis round trips for N
   * independent, already-indexed store queries. The queries are unchanged and
   * still run per camera (each is `where deviceId` + a `firstSeen` range
   * against its own index, and `limit` stays PER CAMERA so a busy camera cannot
   * starve a quiet one of its rows); what collapses is the transport.
   *
   * Every requested id gets a row. `getKeyEvents` already degrades to `[]`
   * rather than throwing, so a per-camera failure is reported exactly as it was
   * before this method existed — this does not make it worse, and the row
   * carries the `deviceId` the single method's output never did.
   */
  async getKeyEventsBatch(input: {
    deviceIds: readonly number[]
    since: number
    until: number
    limit?: number
    minImportance?: number
    classFilter?: string
  }): Promise<readonly KeyEventsForDevice[]> {
    return Promise.all(
      input.deviceIds.map(async (deviceId): Promise<KeyEventsForDevice> => {
        const events = await this.getKeyEvents({
          deviceId,
          since: input.since,
          until: input.until,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          ...(input.minImportance !== undefined ? { minImportance: input.minImportance } : {}),
          ...(input.classFilter !== undefined ? { classFilter: input.classFilter } : {}),
        })
        return { deviceId, events }
      }),
    )
  }

  async getAudioEvents(input: {
    deviceId: number
    since?: number
    until?: number
    limit?: number
    projection?: 'full' | 'slim'
  }): Promise<readonly AudioEvent[]> {
    return this.queryFacade.getAudioEvents(input)
  }

  async getEventMedia(input: GetEventMediaInput): Promise<readonly MediaFile[]> {
    return this.queryFacade.getEventMedia(input)
  }

  async getTrackMedia(input: {
    trackId: string
    kinds?: readonly MediaFileKind[]
    deviceId: number
  }): Promise<readonly MediaFile[]> {
    return this.queryFacade.getTrackMedia(input)
  }

  /** What media a track HAS, without any of it — the detail view's manifest. */
  async listTrackMedia(input: {
    trackId: string
    deviceId: number
  }): Promise<readonly MediaFileInfo[]> {
    return this.queryFacade.listTrackMedia(input)
  }

  /** What media an EVENT has, without any of it — the same manifest, for the
   *  half of the detail modal's filmstrip that is event-owned. `ownerType` is
   *  required: an event is a row in one of three tables (D482). */
  async listEventMedia(input: ListEventMediaInput): Promise<readonly MediaFileInfo[]> {
    return this.queryFacade.listEventMedia(input)
  }

  /**
   * Which of `ownerIds` hold at least ONE media row — the media-PRESENCE probe,
   * on the wire because the `videoclips` source lives in the addon that owns
   * the FOOTAGE now (D560).
   *
   * A pass-through to {@link MediaStore.ownersWithMedia}, which batches by
   * `whereIn` and pages: the N+1 this exists to prevent is one query per owner,
   * and a process boundary in front of it would multiply that, not absorb it.
   *
   * It THROWS rather than answering partially, and the empty ask costs no read
   * at all — a caller with nothing to probe must not pay a round trip for it.
   *
   * D683 fix round 2: `ownerIds` is a DISCRIMINATED field — a track id only
   * when `ownerKind === 'track'` (an event id otherwise), which is why this
   * resolution is NOT folded into `resolveInput`'s generic sweep (a key-name
   * heuristic cannot see the sibling `ownerKind`). `videoclips-provider.ts`'s
   * `resolveVouchedEvents` probes with ids read off its own rows
   * (`event.trackId`) and looks the answer up BY THAT SAME id, so the answer
   * is keyed by the id ASKED, not the resolved survivor — see
   * {@link resolveTrackOwnerIds}.
   */
  async ownersWithMedia(input: {
    deviceId: number
    ownerKind: MediaPresenceOwnerKind
    ownerIds: readonly string[]
  }): Promise<readonly string[]> {
    if (input.ownerIds.length === 0) return []
    const store = this.mediaStore
    if (store === null) {
      throw new Error(
        `pipelineAnalytics.ownersWithMedia: the media index is not open on this node — refusing rather than answering "these owners have nothing" (device ${String(input.deviceId)})`,
      )
    }
    if (input.ownerKind !== 'track') {
      const found = await store.ownersWithMedia(input.ownerKind, input.ownerIds, input.deviceId)
      return [...found]
    }
    const resolvedByAskedId = await resolveTrackOwnerIds(
      input.ownerIds,
      (ids) => this.trackAliasStore?.resolveMany(ids) ?? Promise.resolve(new Map()),
      (failure) => this.aliasResolveFailureLogger?.(failure),
    )
    const probeIds = [...new Set(resolvedByAskedId.values())]
    const found = await store.ownersWithMedia('track', probeIds, input.deviceId)
    return input.ownerIds.filter((askedId) => found.has(resolvedByAskedId.get(askedId) ?? askedId))
  }

  // ── CLIP semantic text search ──────────────────────────────────────────

  /**
   * Search object events by text using CLIP cosine similarity.
   *
   * Flow:
   *   1. Call `embedding-encoder.encodeText` to embed `text` → `queryVec`.
   *   2. Resolve the active encoder's modelId (same-model gate).
   *   3. Rank IN THE VECTOR STORE — prefilters pushed into SQL, cosine over
   *      compact rows in the provider.
   *   4. Fetch the corresponding ObjectEvents by trackId (via getObjectEvents
   *      with each winner's deviceId + trackId filter) and join score.
   *   5. Return at most `limit` ScoredObjectEvents sorted descending by score.
   */
  /**
   * The active encoder's model id, cached for {@link ENCODER_INFO_TTL_MS}.
   *
   * Refreshed rather than pinned forever so an operator swapping the encoder
   * does not need a restart to make search gate on the new model — the window
   * where the old id is used is bounded by the TTL, and during it a search
   * simply ranks against the previous model's vectors, which is what it would
   * have done anyway until the new ones exist.
   */
  private async resolveEncoderModelId(api: AnalyticsApi): Promise<string | null> {
    const now = Date.now()
    if (this.encoderInfoCache !== null && now - this.encoderInfoCache.at < ENCODER_INFO_TTL_MS) {
      return this.encoderInfoCache.modelId
    }
    // The CLUSTER ROW, not `embeddingEncoder.getInfo`, and for the same reason
    // the rebuild pin moved: the search gate and the WRITERS must name the same
    // authority or the gate filters out exactly the rows that were just
    // written. Both the live detail plane and the rebuild now resolve
    // `clip-embedding` from `modelScope: 'cluster'`, so the gate reads it too.
    const modelId = await resolveClusterModelPin(api, CLIP_EMBEDDING_STEP_ID, {
      warn: (message, extras) => this.ctx.logger.warn(`searchObjectEvents: ${message}`, extras),
    })
    // A failed read keeps the last row read (D49); with none, `null` — and the
    // search plan then refuses by name rather than guessing a space (D649).
    if (modelId === null) return this.encoderInfoCache?.modelId ?? null
    this.encoderInfoCache = { modelId, at: now }
    return modelId
  }

  /**
   * The candidate nodes a rebuild pass may dispatch to.
   *
   * `pipelineOrchestrator.getAgentLoad` is the cluster's own list of nodes
   * running a pipeline runner, refreshed on read — the same authority the
   * orchestrator's own placement uses, rather than a second inventory that can
   * disagree with it. An operator override collapses the list to one node
   * without checking it: a named node that turns out not to serve the model
   * refuses on the first track and the pass abandons, which is a clearer answer
   * than silently ignoring the override.
   *
   * Capability is NOT probed here. A node's ability to serve (step, model) is
   * decided by the node itself on the first request it gets, and a probe would
   * be a second opinion that can disagree with the executor — the exact split
   * this change exists to close. Nodes therefore leave the rotation as they
   * refuse.
   */
  private async resolveRebuildNodes(
    api: AnalyticsApi,
    executeOnNodeId: string | undefined,
  ): Promise<readonly string[]> {
    if (executeOnNodeId !== undefined) return [executeOnNodeId]
    const loads = await api.pipelineOrchestrator.getAgentLoad.query().catch((err: unknown) => {
      this.ctx.logger.warn(
        'embedding rebuild: could not list cluster nodes — falling back to the hub alone',
        { meta: { error: String(err) } },
      )
      return null
    })
    if (loads === null || loads.length === 0) return [REBUILD_FALLBACK_NODE_ID]
    return loads.filter((l) => l.online).map((l) => l.nodeId)
  }

  /**
   * Run ONE track's embedding step on a NAMED node.
   *
   * `nodePin` is the whole placement mechanism: `classifyCapRoute` gives
   * Priority 1 to `hub-in-process`, so an UNPINNED call always stays on the
   * hub and the fleet never participates. The pin is what distributes.
   */
  private async runRebuildStepOn(
    nodeId: string,
    input: RunStatelessStepInput,
  ): Promise<RunStatelessStepResult> {
    const runner = this.ctx.api?.pipelineRunner
    if (!runner?.runStatelessStep) {
      // Version skew: a cluster whose runners predate this method. Throwing
      // makes the dispatcher retire the node, which is right — and it is far
      // better than falling back to the direct encoder, the second feature
      // space D52 removed.
      throw new Error('pipelineRunner.runStatelessStep is unavailable on this cluster')
    }
    return runner.runStatelessStep.mutate(input, nodePin(nodeId))
  }

  /**
   * The periodic ORPHAN AUDIT — ownership-keyed, wide interval, report-first.
   *
   * This is NOT a fifth age sweep and must never be mistaken for one. It takes
   * no cutoff. It asks one question per row — *does the entity that owns you
   * still exist?* — and in its default mode it only ANSWERS: it counts, logs
   * per collection, and touches nothing. Reclaiming is opt-in
   * (`orphanAuditReclaim`), because this engine's correctness rests entirely on
   * the ownership model, and a wrong ownership model here is a delete loop
   * pointed at the operator's own database.
   *
   * **If this ever reports a non-zero count for a track-owned family, the
   * cascade has a hole.** The cascade handles the future; this handles the past
   * (5,598 measured orphaned `keyFrame` rows) and anything the cascade misses.
   * Once the past is cleaned up, a non-zero number is a BUG DETECTOR, not a
   * cleaner, and it should be read that way.
   *
   * Cost discipline: `better-sqlite3` runs on the hub's main thread, measured at
   * 70–95% with 42 s of synchronous blocks in a 120 s window. So this pages,
   * stops at a per-scope row ceiling, RESUMES from a persisted cursor next run,
   * and refuses to start if the previous run has not finished.
   */
  private async runOrphanAuditPass(
    overrides?: OrphanAuditOverrides,
    alreadyHeld = false,
  ): Promise<OrphanAuditReport | null> {
    if (this.shuttingDown) return null
    if (!alreadyHeld) {
      if (this.orphanAuditRunning) {
        // Skipping a run is correct; overlapping two scans of the whole database
        // on the thread that also serves frames is not.
        this.ctx.logger.info('analytics orphan audit skipped — previous run still in flight')
        return null
      }
      this.orphanAuditRunning = true
    }
    const trackStore = this.trackStore
    const eventStore = this.eventStore
    const mediaStore = this.mediaStore
    const settingsStore = this.settingsStore
    if (!trackStore || !eventStore || !mediaStore || !settingsStore) {
      if (!alreadyHeld) this.orphanAuditRunning = false
      return null
    }
    try {
      const limits = await this.orphanAuditLimits(overrides)
      // Faces, plates and track aliases live in records kinds on a hub, and
      // their legacy tables are dropped: those scopes page, count and delete
      // through the kinds' ledgers.
      const auditLedgers = orphanAuditLedgers(this.eventLedgerWiring())
      const plateLedger = wirePlateLedger(this.eventLedgerWiring())
      const collectionPorts = auditCollectionPorts(settingsStore, auditLedgers)
      const deps: OrphanAuditDeps = {
        pageKeyset: collectionPorts.pageKeyset,
        stop: () => this.shuttingDown,
        page: async (collection, shard, offset, limit) => {
          if (collection === MEDIA_COLLECTION) {
            // The shard IS the reach fix (D480): one cursor per ownerKind over
            // `idx_media_owner`, never one offset across the whole id space.
            //
            // `OrphanRow.key` stays a string because this walks every audited
            // collection and only the media one is rowid-keyed (D482). The
            // conversion happens HERE, at the boundary, and nowhere else.
            const mediaRows = await mediaStore.pageForAudit(shard?.value ?? '', offset, limit)
            return mediaRows.map((row) => ({ key: String(row.mediaId), data: row.data }))
          }
          return collectionPorts.pageByOffset(collection, offset, limit)
        },
        // How much there IS — the denominator a coverage claim needs. A count
        // that cannot be taken is `null`, never 0: an unmeasurable collection
        // is not an empty one (D393).
        size: async (collection, shard) => {
          if (collection === MEDIA_COLLECTION) {
            return mediaStore.countForAudit(shard?.value ?? '')
          }
          return collectionPorts.size(collection)
        },
        // Every probe THROWS on failure by contract — the engine abandons the
        // scope rather than reading a failed answer as "the owner is gone".
        // D683 (review M4): an id with NO row of its own in `existingTrackIds`
        // may still be a LIVE alias — a row still keyed by an absorbed id,
        // whose survivor is the one actually alive. Without this, every such
        // row reads as an orphan one grace period after the fusion.
        liveTrackIds: (ids) => this.liveTrackIdsThroughAliases(ids, trackStore),
        // PER TABLE (D480). The union across the three event tables answered
        // "live" for every object- and audio-owned media row in existence:
        // D474 made an event id a per-table rowid alias and all 100 051 object
        // ids and all 391 984 audio ids on this hub are also motion ids.
        liveEventIds: (table, ids) => eventStore.existingEventIdsIn(table, ids),
        // D694: media whose camera disagrees with the live holder of a reused
        // event id is an orphan even though the id is taken. Timestamp alone
        // is not used to reclaim (D476 migrated stamps unproven).
        eventGenerations: (table, ids) => eventStore.eventGenerationsIn(table, ids),
        // A promoted object's key frame outlives its track (D547): the entry
        // is the owner the audit must ask.
        keptMediaKeys: async (keys) => this.keptStationaryMediaKeys(keys),
        // Through the OWNER's delete, never a raw collection delete: a face
        // row deleted the raw way leaves its ArcFace vector behind, in an index
        // no sweep walks (2 568 of them, 20 MB, measured 2026-09-13).
        reclaim: (() => {
          const reclaimOne = buildOrphanReclaimer({
            deleteFace: async (faceId) => {
              await this.faceStore?.delete(faceId)
            },
            deleteMediaConfirmed: async (mediaId) => {
              const count = await mediaStore.deleteConfirmed(mediaId)
              return { rows: count.rows, bytes: count.bytes }
            },
            deleteTrackAlias: async (aliasId) => {
              const aliasStore = this.trackAliasStore
              if (aliasStore === null) throw new Error('track alias store not bound')
              return await aliasStore.deleteAlias(aliasId)
            },
            deletePlate: plateDeleter(plateLedger, this.ctx.logger),
            deleteRow: settingsRowDeleterOf(() => this.settingsStore),
            logger: this.ctx.logger,
          })
          return (collection, key, row) => reclaimOne(collection, key, row.data)
        })(),
        now: () => Date.now(),
        logger: this.ctx.logger,
        // Give the thread back between pages. `better-sqlite3` is synchronous
        // and shares hub-main with every live frame; a 74,700-row reclaim that
        // never yields is a multi-minute stall, not a background job.
        breathe: () => new Promise<void>((resolve) => setImmediate(resolve)),
      }

      // The cursors come off DISK (D480). The in-RAM mirror is only what this
      // process has learned since; a respawn between two passes used to reset
      // every scope to offset 0, which is why nothing ever reached the tail.
      const persisted = await this.sweepCursors?.load()
      if (persisted !== undefined) {
        this.orphanAuditCursors = new Map(Object.entries(persisted.scopes))
        this.orphanClipIndexCursors = new Map(Object.entries(persisted.clipIndexCursors))
        this.orphanFaceVectorCursor = persisted.faceVectorCursor
      }

      const { report, cursors } = await runOrphanAudit({
        scopes: buildOrphanScopes(),
        deps,
        limits,
        // `restart` walks every scope from the top instead of resuming — what an
        // operator draining a standing backlog wants, and never the default.
        cursors: overrides?.restart === true ? new Map() : this.orphanAuditCursors,
      })
      this.orphanAuditCursors = cursors

      for (const scope of report.scopes) {
        // One line per collection per run — always, including zero. A sweep that
        // silently finds nothing is indistinguishable from one that never ran.
        this.ctx.logger.info('analytics orphan audit', {
          meta: {
            mode: report.mode,
            collection: scope.collection,
            // The shard and the SIZE, on the same line as the ceiling that
            // stopped it. `stoppedBy=row-ceiling nextCursor=20000` on its own
            // reads as pacing; next to `collectionSize=198066` it reads as
            // what it is.
            shard: scope.shard,
            collectionSize: scope.collectionSize,
            coveredWholeShard: scope.coveredWholeShard,
            examined: scope.examined,
            orphans: scope.orphans,
            reclaimed: scope.reclaimed,
            reclaimFailed: scope.reclaimFailed,
            bytesReclaimed: scope.bytesReclaimed,
            exempt: scope.exempt,
            writerBounded: scope.writerBounded,
            withinGrace: scope.withinGrace,
            unresolvable: scope.unresolvable,
            stoppedBy: scope.stoppedBy,
            nextCursor: scope.nextCursor,
          },
        })
        // Device-scoped detail, per camera, so "why does 102 orphan and 101
        // not" is answerable without hand-correlating timestamps.
        for (const deviceId of scope.deviceIds) {
          this.ctx.logger.info('analytics orphan audit (device)', {
            tags: { deviceId },
            meta: { deviceId, collection: scope.collection, mode: report.mode },
          })
        }
      }
      // The CLIP vector index is not a settings-store collection, so it cannot
      // be a derived scope — it gets the same ownership question through its own
      // reconcile. It refuses an empty live-track set rather than reading a
      // failed answer as "delete everything".
      await this.auditEmbeddingOrphans(limits, overrides?.restart === true)
      // The SECOND vector index. Its own scope, its own cursor, and its own
      // idea of who owns a row — a face vector belongs to a FACE row, not to
      // the track its metadata names. See `face-vector-orphans.ts`.
      await this.auditFaceVectorOrphans(limits, overrides?.restart === true)

      // Rows whose owner kind NO shard walks. A sharded sweep covers the kinds
      // this release declares; a row carrying one it does not would be walked
      // by nothing, which is D480's failure with a different cause. Counted
      // rather than walked (the predicate is a NOT IN, which no index serves
      // as a range) and WARNed, because "nothing looked at these" must never
      // be something only a reader of the code can work out.
      try {
        const unwalked = await mediaStore.countOwnerKindsOutside(MEDIA_AUDIT_SHARD_KINDS)
        if (unwalked > 0) {
          this.ctx.logger.warn('analytics orphan audit: media rows no shard walks', {
            meta: {
              collection: MEDIA_COLLECTION,
              rows: unwalked,
              shards: MEDIA_AUDIT_SHARD_KINDS.length,
            },
          })
        }
      } catch (err) {
        this.ctx.logger.warn('analytics orphan audit: could not count unwalked owner kinds', {
          meta: { collection: MEDIA_COLLECTION, error: String(err) },
        })
      }

      // The cursors go back to DISK, after the embedding leg has moved its own,
      // so one write carries the whole pass's progress.
      await this.sweepCursors?.save({
        scopes: this.orphanAuditCursors,
        faceVectorCursor: this.orphanFaceVectorCursor,
        clipIndexCursors: this.orphanClipIndexCursors,
        nowMs: Date.now(),
      })

      if (report.totalOrphans > 0) {
        void this.eventsOpsLog?.append({
          op: 'orphan-audit',
          reason: 'maintenance',
          deviceId: null,
          itemsAffected: report.totalReclaimed,
          bytesReclaimed: report.totalBytesReclaimed,
          detail: `orphan audit (${report.mode}): ${report.totalOrphans} orphaned rows across ${report.scopes.length} scopes, ${report.totalReclaimed} reclaimed (${report.totalReclaimFailed} refused), ${report.scopesNotCovered} scopes not walked to the end, in ${report.durationMs}ms`,
        })
      }
      return report
    } catch (err) {
      this.ctx.logger.warn('analytics orphan audit failed', {
        meta: { error: String(err) },
      })
      return null
    } finally {
      if (!alreadyHeld) this.orphanAuditRunning = false
    }
  }

  /**
   * The vector-index leg of the orphan audit.
   *
   * The CLIP indexes live in the `vector-store` capability, not in a settings-
   * store collection, so they cannot be a DERIVED scope — there is no column
   * declaration to read the ownership off. It gets the same question by the
   * same rule: a vector's row id IS the trackId, so it is orphaned exactly when
   * that track is gone.
   *
   * `pruneOrphans` refuses an EMPTY live-track set outright — a track store
   * that failed to answer must never be read as "no tracks exist", which would
   * wipe the whole index. In report mode nothing is deleted at all.
   */
  private async auditEmbeddingOrphans(limits: OrphanAuditLimits, restart: boolean): Promise<void> {
    const embeddingStore = this.objectEmbeddingStore
    const trackStore = this.trackStore
    if (!embeddingStore || !trackStore) {
      // A leg that does not run is not a leg that found nothing.
      this.ctx.logger.warn('analytics orphan audit: vector-index leg skipped — stores not up', {
        meta: {
          collection: 'vector-index:clip',
          embeddingStore: embeddingStore !== null,
          trackStore: trackStore !== null,
        },
      })
      return
    }
    // EVERY CLIP index (D649), each with its own resume cursor. A track's
    // vector lives once per model that ever embedded it; an index nobody
    // searches today still has to lose the vectors of tracks that are gone.
    for (const space of embeddingStore.indexes()) {
      const scope = `vector-index:${space.index}`
      const cursor = restart ? 0 : (this.orphanClipIndexCursors.get(space.index) ?? 0)
      const report = await scanEmbeddingOrphans(
        {
          scope,
          // The owner of a CLIP row is its TRACK. Mapped here rather than in the
          // scan, which knows only "owner".
          scanPage: async (pageCursor, limit) => {
            const page = await embeddingStore.scanRefs(space, pageCursor, limit)
            return {
              rows: page.rows.map((r) => ({
                id: r.id,
                ownerId: r.trackId,
                deviceId: r.deviceId,
                timestamp: r.timestamp,
              })),
              nextCursor: page.nextCursor,
            }
          },
          // The SAME membership probe every other scope uses, per page. It throws
          // on failure, which is what stops a failed read from reading as "these
          // tracks are gone".
          liveOwnerIds: (ids: readonly string[]) => trackStore.existingTrackIds(ids),
          // Reaches every index, not just this one: the owner is gone everywhere.
          reclaim: async (ids) => {
            const outcome = await embeddingStore.deleteVerified(ids)
            if (outcome.undeclaredIndexes.length > 0) {
              this.ctx.logger.warn(
                'analytics orphan audit: CLIP indexes skipped — refused to declare',
                {
                  meta: { index: space.index, undeclaredIndexes: outcome.undeclaredIndexes },
                },
              )
            }
            return outcome
          },
          now: () => Date.now(),
          logger: this.ctx.logger,
          breathe: () => new Promise<void>((resolve) => setImmediate(resolve)),
        },
        {
          mode: limits.mode,
          graceMs: limits.graceMs,
          pageSize: limits.pageSize,
          // The index is walked to the SAME row ceiling as any other scope, and
          // it is now a real ceiling rather than a number the backend quietly
          // divided by five.
          maxRows: Math.max(limits.maxRowsPerScope, EMBEDDING_ORPHAN_SCAN_LIMIT),
          maxReclaim: limits.maxReclaimPerScope,
        },
        cursor,
      )
      this.orphanClipIndexCursors.set(space.index, report.nextCursor)

      // One line per run per index — always, including zero. `kept` is in it
      // deliberately: `orphans: 956, reclaimed: 0` was reported for weeks and
      // read as "we looked", and only a non-zero `kept` distinguishes a pass
      // that judged the index from one whose liveness probe returned nothing.
      this.ctx.logger.info('analytics orphan audit', {
        meta: {
          mode: limits.mode,
          collection: report.scope,
          index: space.index,
          examined: report.examined,
          orphans: report.orphans,
          reclaimed: report.reclaimed,
          kept: report.kept,
          withinGrace: report.withinGrace,
          unresolvable: report.unresolvable,
          notReclaimed: report.notReclaimed,
          stoppedBy: report.stoppedBy,
          nextCursor: report.nextCursor,
        },
      })
      for (const deviceId of report.deviceIds) {
        this.ctx.logger.info('analytics orphan audit (device)', {
          tags: { deviceId },
          meta: { deviceId, collection: report.scope, mode: limits.mode },
        })
      }
    }
  }

  /**
   * The `face-arcface` leg.
   *
   * Same algorithm as the CLIP leg and deliberately NOT the same owner: a face
   * vector belongs to its FACE ROW, and judging it on the `trackId` its
   * metadata carries would delete the vectors of enrolled identities the moment
   * their track aged out. The reasoning lives in `face-vector-orphans.ts`
   * because it is the kind of thing a future reader will otherwise "simplify".
   */
  private async auditFaceVectorOrphans(limits: OrphanAuditLimits, restart: boolean): Promise<void> {
    const faces = this.faceStore
    if (!faces) {
      // A leg that does not run is not a leg that found nothing.
      this.ctx.logger.warn('analytics orphan audit: face-vector leg skipped — store not up', {
        meta: { collection: FACE_VECTOR_ORPHAN_SCOPE },
      })
      return
    }
    const report = await scanEmbeddingOrphans(
      faceVectorOrphanDeps({
        faces,
        now: () => Date.now(),
        logger: this.ctx.logger,
        breathe: () => new Promise<void>((resolve) => setImmediate(resolve)),
      }),
      {
        mode: limits.mode,
        graceMs: limits.graceMs,
        pageSize: limits.pageSize,
        maxRows: Math.max(limits.maxRowsPerScope, EMBEDDING_ORPHAN_SCAN_LIMIT),
        maxReclaim: limits.maxReclaimPerScope,
      },
      restart ? 0 : this.orphanFaceVectorCursor,
    )
    this.orphanFaceVectorCursor = report.nextCursor
    this.ctx.logger.info('analytics orphan audit', {
      meta: {
        mode: limits.mode,
        collection: report.scope,
        examined: report.examined,
        orphans: report.orphans,
        reclaimed: report.reclaimed,
        kept: report.kept,
        withinGrace: report.withinGrace,
        unresolvable: report.unresolvable,
        notReclaimed: report.notReclaimed,
        stoppedBy: report.stoppedBy,
        nextCursor: report.nextCursor,
      },
    })
  }

  /**
   * Operator-tunable audit limits. `mode` and `pageSize` are SETTINGS because
   * the right numbers depend on the hub's load; the row and reclaim ceilings
   * stay constants because they are safety bounds, not tuning — an operator
   * raising them is raising the blast radius of a bug, and that should take a
   * release.
   */
  private async orphanAuditLimits(overrides?: OrphanAuditOverrides): Promise<OrphanAuditLimits> {
    const mode = await this.orphanAuditModeState.get()
    const pageSize = await this.orphanAuditPageSizeState.get()
    const graceMinutes = overrides?.graceMinutes
    // An OPERATOR pass never inherits the durable mode: `mode` is the only
    // override that can destroy anything, so an absent one is 'report', never
    // "whatever the setting happens to say".
    const resolvedMode =
      overrides !== undefined
        ? (overrides.mode ?? 'report')
        : mode === 'reclaim'
          ? 'reclaim'
          : 'report'
    return {
      mode: resolvedMode,
      graceMs: graceMinutes === undefined ? DEFAULT_ORPHAN_LIMITS.graceMs : graceMinutes * 60_000,
      pageSize: overrides?.pageSize ?? pageSize,
      maxRowsPerScope: overrides?.maxRowsPerScope ?? DEFAULT_ORPHAN_LIMITS.maxRowsPerScope,
      maxReclaimPerScope: overrides?.maxReclaimPerScope ?? DEFAULT_ORPHAN_LIMITS.maxReclaimPerScope,
    }
  }

  /**
   * Start an operator-driven orphan-audit pass — DETACHED.
   *
   * DRY RUN BY DEFAULT. Reclaiming is a word the caller has to type. The pass
   * is tens of minutes on a standing backlog; awaiting it is a UDS timeout,
   * not a verdict. Poll {@link getOrphanAuditStatus}.
   */
  async runOrphanAuditNow(overrides: OrphanAuditOverrides): Promise<OrphanAuditStartResult> {
    if (this.orphanAuditRunning) {
      this.ctx.logger.info('analytics orphan audit already running — request ignored')
      return { started: false, alreadyRunning: true }
    }
    this.orphanAuditRunning = true
    const mode = overrides.mode ?? 'report'
    this.orphanAuditState = {
      ...IDLE_ORPHAN_AUDIT,
      running: true,
      mode,
      startedAtMs: Date.now(),
    }
    this.ctx.logger.info('analytics orphan audit starting', {
      meta: { mode, restart: overrides.restart === true },
    })
    void this.executeOrphanAudit(overrides, mode)
    return { started: true, alreadyRunning: false }
  }

  private async executeOrphanAudit(
    overrides: OrphanAuditOverrides,
    mode: 'report' | 'reclaim',
  ): Promise<void> {
    try {
      const report = await this.runOrphanAuditPass(overrides, true)
      const complete =
        report !== null &&
        report.scopes.every((scope) => scope.stoppedBy === 'exhausted' || scope.nextCursor === 0)
      this.orphanAuditState = {
        running: false,
        mode,
        complete: report === null ? true : complete,
        totalOrphans: report?.totalOrphans ?? 0,
        totalReclaimed: report?.totalReclaimed ?? 0,
        totalBytesReclaimed: report?.totalBytesReclaimed ?? 0,
        startedAtMs: this.orphanAuditState.startedAtMs,
        finishedAtMs: Date.now(),
        error: report === null ? 'orphan audit did not run (stores unavailable)' : null,
      }
      this.ctx.logger.info('analytics orphan audit (operator)', {
        meta: {
          mode,
          orphans: this.orphanAuditState.totalOrphans,
          reclaimed: this.orphanAuditState.totalReclaimed,
          bytesReclaimed: this.orphanAuditState.totalBytesReclaimed,
          complete: this.orphanAuditState.complete,
          restart: overrides.restart === true,
        },
      })
    } catch (err) {
      this.orphanAuditState = {
        ...this.orphanAuditState,
        running: false,
        complete: false,
        finishedAtMs: Date.now(),
        error: err instanceof Error ? err.message : String(err),
      }
      this.ctx.logger.warn('analytics orphan audit (operator) failed', {
        meta: { error: String(err) },
      })
    } finally {
      this.orphanAuditRunning = false
    }
  }

  async getOrphanAuditStatus(): Promise<OrphanAuditStatus> {
    return { ...this.orphanAuditState }
  }

  /**
   * Empty the CLIP index — the clean slate before a crop-policy or encoder
   * change, to be followed by {@link rebuildObjectEmbeddings}.
   */
  async wipeObjectEmbeddings(): Promise<{ deleted: number; failedIndexes: string[] }> {
    const store = this.objectEmbeddingStore
    if (!store) {
      // Not `{ deleted: 0 }`: that reads as "wiped, it was already empty".
      this.ctx.logger.warn('wipeObjectEmbeddings: object embedding store unavailable')
      throw new Error(
        `${WIPE_STORE_UNAVAILABLE}: the object embedding store is not up — nothing was wiped`,
      )
    }
    const { deleted, failedIndexes } = await store.wipeAll()
    if (failedIndexes.length > 0) {
      // Not a clean slate: say which feature spaces kept their vectors.
      this.ctx.logger.warn('wipeObjectEmbeddings: some CLIP indexes were NOT emptied', {
        meta: { deleted, failedIndexes },
      })
    }
    // Returned to the cap caller; the operator's button (`embedding.wipe`)
    // turns a non-empty list into an error via `requireCompleteWipe`.
    return { deleted, failedIndexes: [...failedIndexes] }
  }

  /**
   * Re-embed stored tracks from their key frames — the tool that makes the crop
   * policy tunable.
   *
   * Pixels come from each track's `keyFrame` (the FULL frame at native
   * resolution, captured at the best detection) plus that detection's bbox, so
   * the window can be WIDENED. The tight crop originally embedded cannot be
   * widened after the fact.
   *
   * The frame and the box are shipped to a RUNNER, which cuts and encodes them
   * through `runStatelessStep` — the same crop derivation and the same step
   * catalog the live detail plane uses. This side no longer chooses a
   * rectangle, and there is no `cropMargin` argument to choose one with: see
   * `embedding-rebuild.ts` for what that cost.
   *
   * WHICH runner is a rotation over the online fleet, not the camera's owner:
   * `runStatelessStep` needs no attachment, and requiring one limited a pass to
   * whatever happened to be attached at that second. `executeOnNodeId` pins the
   * whole pass to one node instead.
   *
   * The CLIP model is resolved ONCE here and sent with every request. If it
   * cannot be resolved the pass does not start: writing rows stamped `unknown`
   * makes the search gate compare against a model id nothing ran.
   */
  async rebuildObjectEmbeddings(input: {
    deviceId?: number
    since?: number
    until?: number
    maxTracks?: number
    executeOnNodeId?: string
    pacingMs?: number
    force?: boolean
  }): Promise<EmbeddingRebuildStarted> {
    if (this.rebuildState.running) {
      this.ctx.logger.info('object embedding rebuild already running — request ignored')
      return { started: false, alreadyRunning: true }
    }
    const store = this.objectEmbeddingStore
    const trackStore = this.trackStore
    const mediaStore = this.mediaStore
    const eventStore = this.eventStore
    const api = this.ctx.api
    if (!store || !trackStore || !mediaStore || !eventStore || !api) {
      this.ctx.logger.warn('rebuildObjectEmbeddings: analytics stores unavailable')
      return { started: false, alreadyRunning: false, refusal: 'stores-unavailable' }
    }
    // D664: a forced pass redoes vectors that are already in the space, so it
    // is never open-ended — the operator names how many.
    const force = input.force === true
    if (force && input.maxTracks === undefined) {
      this.ctx.logger.warn('rebuildObjectEmbeddings: refusing a force pass with no maxTracks', {
        meta: { refusal: 'force-requires-max-tracks' },
      })
      return { started: false, alreadyRunning: false, refusal: 'force-requires-max-tracks' }
    }

    // The pass-wide model PIN, from the CLUSTER ROW.
    //
    // It used to come from `embeddingEncoder.getInfo`, which answers a subtly
    // different question — "which model is the encoder addon holding right
    // now", not "which model has the operator chosen for this cluster". Since
    // `clip-embedding` declares `modelScope: 'cluster'` there is exactly one
    // authority for that, and it is a stored row rather than a live process's
    // opinion; the two agree until an encoder is mid-reload or a node missed a
    // change, and when they disagree this pass writes a whole index in the
    // wrong space behind a status line that looks fine.
    //
    // A row that cannot be READ refuses the pass. That beats the old
    // `?? 'unknown'`: rows stamped with an id nothing ran leave the search's
    // same-model gate with nothing to reason about.
    // D651 fix round 2: read from the STORED row, twice, agreeing — a
    // hydrated view of defaults (orchestrator mid-restart) is not a choice.
    // The confirmer's reason is the refusal, verbatim: ONE field, ONE
    // vocabulary (`RebuildObjectEmbeddingsRefusalSchema`).
    const confirmation = await this.getClusterPinConfirmer(api, 'clip-rebuild').confirm()
    if (confirmation.kind === 'refused') {
      this.ctx.logger.warn(
        'rebuildObjectEmbeddings: the cluster CLIP model is not confirmed — refusing to start a pass that cannot pin one',
        { meta: { refusal: confirmation.reason } },
      )
      return { started: false, alreadyRunning: false, refusal: confirmation.reason }
    }
    //
    // The CONFIRMED model must also carry CLIP metadata: it names the index the
    // pass fills and the dimension every vector is checked against (D649).
    // Refused BEFORE a node is asked or a key frame read — the cheap question
    // first (D54).
    const pin = pinClipRebuild(confirmation.modelId, BUILTIN_CLIP_MODELS)
    if (pin.kind === 'refused') {
      this.ctx.logger.warn('rebuildObjectEmbeddings: refusing to start', {
        meta: {
          refusal: pin.refusal,
          modelId: pin.modelId,
          why: 'the pinned model has no CLIP metadata — there is no index to fill (D649)',
        },
      })
      return {
        started: false,
        alreadyRunning: false,
        refusal: pin.refusal,
        modelId: pin.modelId,
      }
    }
    const { modelId, index } = pin

    const nodeIds = await this.resolveRebuildNodes(api, input.executeOnNodeId)
    const dispatcher = new RebuildStepDispatcher(
      {
        runStatelessStep: (nodeId, stepInput) => this.runRebuildStepOn(nodeId, stepInput),
        logger: {
          warn: (message, extras) => this.ctx.logger.warn(message, extras),
        },
      },
      new NodeRotation(nodeIds),
      modelId,
    )
    this.ctx.logger.info('object embedding rebuild starting', {
      meta: {
        modelId,
        index,
        stepId: REBUILD_DETAIL_STEP_ID,
        nodes: [...nodeIds],
        pinnedToOneNode: input.executeOnNodeId !== undefined,
        // The pacing knob, named at start: an operator watching a slow pass
        // must be able to tell "throttled on purpose" from "wedged".
        pacingMs: input.pacingMs ?? DEFAULT_REBUILD_PACING_MS,
      },
    })

    const deviceIds =
      input.deviceId !== undefined ? [input.deviceId] : await trackStore.listDeviceIds()

    // One service per pass: its concurrency bound is what keeps a fleet-wide
    // walk from turning into an unbounded pile of ffmpeg children on a node
    // that is also decoding live streams.
    const recordedStills = new RecordedStillService(
      buildRecordedStillPorts({
        api: this.ctx.api.recordingArchive,
        logger: this.ctx.logger,
        // Never PATH (D540): a rejection throws out of `decodeStill`, and the
        // service logs it per camera as `recorded still failed`.
        resolveFfmpeg: this.pinnedFfmpeg,
      }),
    )

    const deps: RebuildDeps = {
      // Ids only — the name of this dep says so, and until now it read whole
      // tracks to satisfy it. The rebuild fetches each track's media by id
      // afterwards (`loadSource`), so nothing else off this page was ever used.
      // Audio and sensor tracks are not listed at all (D664): they never have
      // an object event, and walking them only inflated the skip counters.
      listTrackIdPage: async (cursor) =>
        trackStore.queryRecentIds(
          rebuildTrackPageQuery({
            deviceIds,
            ...(input.since !== undefined ? { since: input.since } : {}),
            ...(input.until !== undefined ? { until: input.until } : {}),
            ...(cursor !== null ? { cursor } : {}),
            limit: REBUILD_PAGE_SIZE,
          }),
        ),
      // Extracted to `rebuild-source-loader.ts` so its READ COST is assertable.
      // It used to call `listByOwner`, which reads and base64-encodes every blob
      // a track owns to select two — ~10 MB per track, on hub-main's only
      // thread, for a pass that rejected 72% of what it loaded.
      // The box is the one measured on the key frame (D664): its own
      // `subjectBox`, else the track position at exactly its instant.
      loadSource: (trackId) =>
        loadRebuildSource({ media: mediaStore, events: eventStore, tracks: trackStore }, trackId),
      // R3 — the track never got a key frame, so re-decode one from the
      // recording. Reached ONLY from the `keyFrame === null` branch, so a track
      // that has its pixels pays nothing, and only from THIS pass, which is a
      // detached background job: a GOP decode must never sit on a delivery's
      // critical path (see `recorded-still.ts` and its guard).
      recoverKeyFrame: async (source) => {
        const recovered = await recordedStills.recover(
          source.deviceId,
          source.timestamp,
          RECOVERED_KEY_FRAME_MAX_WIDTH,
        )
        return recovered.outcome === 'ok' ? (recovered.jpeg ?? null) : null
      },
      // The cheap gate, asked before any media read. `RebuildStepDispatcher`
      // only ever REMOVES nodes, so once the rotation empties the answer can
      // never become true again and the pass can stop for good.
      canDispatch: () => dispatcher.canDispatch,
      pause: (ms) => sleep(ms),
      // THROUGH THE PIPELINE, not through `embeddingEncoder.encode`.
      //
      // The direct-encode path meant this side chose the crop, and it chose a
      // different one than the live path — 0.2 padding plus squaring against
      // 0.15 unsquared — so every pass wrote a second feature space into the
      // one `object-clip` index. Going through the runner moves the cut to the
      // one shared derivation; the dispatcher additionally holds the model
      // pin, so spreading the work across nodes cannot reintroduce the split.
      embed: (source) => dispatcher.embed(source),
      store: async (source, embeddingBase64) =>
        store.upsertIfBetter({
          trackId: source.trackId,
          deviceId: source.deviceId,
          timestamp: source.timestamp,
          className: source.className,
          // Already the vector store's wire form — see `ObjectEmbeddingWrite`.
          embeddingBase64,
          modelId,
          // The track's REAL confidence, with the gate bypassed rather than
          // out-scored. Writing Infinity to beat it worked once and then
          // poisoned the row: the stored value was Infinity, so every later
          // pass short-circuited and wrote nothing while reporting success.
          confidence: source.confidence,
          force: true,
          ...(source.mediaId !== undefined ? { mediaKey: source.mediaId } : {}),
          ...(source.keyFrameMediaId !== undefined
            ? { keyFrameMediaId: source.keyFrameMediaId }
            : {}),
        }),
      // The cheap question per page: which of these tracks are NOT already in
      // the pinned model's space. One batch lookup, no media touched — see
      // `RebuildDeps.filterOutOfSpace`. This is what makes a re-run after a
      // partial pass cheap, and what makes a pass with an UNCHANGED model a
      // declared no-op rather than a fleet-wide re-embed producing the vectors
      // that were already there.
      filterOutOfSpace: async (trackIds) => {
        const split = await store.countInModelSpace(trackIds, modelId)
        if (split === null) return null
        return {
          outOfSpace: split.outOfSpaceIds,
          alreadyInSpace: split.inSpace,
          inSpace: split.inSpaceIds,
        }
      },
      logger: {
        info: (message, extras) => this.ctx.logger.info(message, extras),
        warn: (message, extras) => this.ctx.logger.warn(message, extras),
      },
    }

    // DETACHED. A pass is ~1s per track — 45 minutes for the fleet — so
    // returning the outcome meant the caller timed out while the work carried
    // on server-side: no result AND no way to know it was still going.
    this.rebuildState = {
      running: true,
      modelId,
      index,
      force,
      startedAtMs: Date.now(),
      progress: {
        scanned: 0,
        rebuilt: 0,
        missingKeyFrame: 0,
        recoveredKeyFrame: 0,
        missingEvent: 0,
        missingBbox: 0,
        boxSource: { subjectBox: 0, positions: 0, event: 0, refused: 0 },
        forcedInSpace: 0,
        skippedOutOfSpace: 0,
        alreadyInSpace: 0,
        notRunnable: 0,
        noCapableNode: 0,
        failed: 0,
      },
    }

    void rebuildObjectEmbeddings(deps, {
      force,
      ...(input.maxTracks !== undefined ? { maxTracks: input.maxTracks } : {}),
      ...(input.pacingMs !== undefined ? { pacingMs: input.pacingMs } : {}),
      onProgress: (progress) => {
        if (this.rebuildState.running) this.rebuildState.progress = progress
        this.ctx.logger.info('object embedding rebuild progress', {
          meta: { ...progress },
        })
      },
    })
      .then((outcome) => {
        this.rebuildState = {
          running: false,
          modelId,
          index,
          force,
          startedAtMs: this.rebuildState.startedAtMs ?? Date.now(),
          finishedAtMs: Date.now(),
          progress: outcome,
          complete: outcome.complete,
        }
        // Node coverage is the half of the outcome the counters cannot show:
        // "rebuilt 121" reads the same whether five nodes shared the work or
        // four of them dropped out on the first track.
        this.ctx.logger.info('object embedding rebuild node coverage', {
          meta: {
            modelId,
            nodesStillEligible: [...dispatcher.liveNodes],
            nodesDropped: dispatcher.droppedNodes.map((d) => `${d.nodeId}: ${d.reason}`),
          },
        })
      })
      .catch((err: unknown) => {
        // A rebuild that dies must not leave `running: true` forever — the
        // guard would then refuse every future request with no way to clear it.
        this.rebuildState = {
          running: false,
          modelId,
          index,
          force,
          startedAtMs: this.rebuildState.startedAtMs ?? Date.now(),
          finishedAtMs: Date.now(),
          error: String(err),
        }
        this.ctx.logger.warn('object embedding rebuild failed', {
          meta: { modelId, index, error: String(err) },
        })
      })

    this.ctx.logger.info('object embedding rebuild started', {
      meta: {
        modelId,
        index,
        deviceId: input.deviceId ?? 'all',
        maxTracks: input.maxTracks ?? 'unbounded',
        force,
      },
    })
    return { started: true, alreadyRunning: false, modelId, index }
  }

  /**
   * Run the REAL detect+align+embed tree over a photograph, on a cluster node.
   *
   * The tree is a `face-detection` ROOT with `face-embedding` nested under it,
   * on the `'full'` plane. That is the executor path the live detail plane
   * runs: SCRFD regresses five landmarks, the warp puts them on the canonical
   * template, and the template comes back verbatim as `faceAlignedCrop`. So the
   * alignment stays a SINGLE implementation (D52) and nothing here cuts a
   * rectangle.
   *
   * NO `modelId` is sent for the embedder, deliberately. `face-embedding`
   * declares `modelScope: 'cluster'`, so `resolveInputSteps` overwrites any id
   * it is handed with the cluster row's (D199) — naming one here would be a
   * second authority, and on the day the operator flips the row this path would
   * keep enrolling into the old space with nothing on screen to say so. The
   * model that RAN is read back off the detection instead.
   *
   * `deviceId` is omitted for the same reason `PHOTO_ENROLL_DEVICE_ID` exists:
   * a photograph has no camera, and a fabricated id in `tags: { deviceId }`
   * would answer a per-camera question with a lie.
   */
  private async runPhotoFacePipeline(
    api: AnalyticsApi,
    photoJpeg: Buffer,
  ): Promise<{
    readonly result: PhotoPipelineResult
    readonly nodeId: string
  }> {
    const nodeIds = await this.resolveRebuildNodes(api, undefined)
    const failures: string[] = []
    for (const nodeId of nodeIds) {
      try {
        const result = await api.pipelineExecutor.runPipeline.mutate(
          {
            steps: [
              {
                addonId: PHOTO_FACE_DETECTION_STEP_ID,
                enabled: true,
                children: [{ addonId: PHOTO_FACE_EMBEDDING_STEP_ID, enabled: true }],
              },
            ],
            image: new Uint8Array(photoJpeg),
            plane: 'full',
          },
          nodePin(nodeId),
        )
        return { result, nodeId }
      } catch (err: unknown) {
        // A node that cannot serve the cluster face model REFUSES (D199), and
        // that refusal is indistinguishable here from any other failure — so
        // the next node is tried and every reason is carried into the throw.
        // Silence would leave the operator with "no faces found" on a photo
        // full of them.
        const reason = errMsg(err)
        failures.push(`${nodeId}: ${reason}`)
        this.ctx.logger.warn('photo enrollment: a node could not analyse the photograph', {
          meta: { nodeId, error: reason },
        })
      }
    }
    throw new Error(
      `photo enrollment: no node could analyse the photograph (${failures.join('; ') || 'no nodes online'})`,
    )
  }

  /**
   * The two gestures behind "enrol from a photo", plus the release.
   *
   * The split is the whole design: analysis finds faces and enrols NOTHING,
   * confirmation enrols exactly the face the operator named. See
   * `photo-enrollment.ts` for why a photograph is the only sample source that
   * survives a model change.
   */

  /**
   * The photo analyze path over a STORED original (D643's re-enrol pass): the
   * same detect+align+embed tree and the same magnitude bound `photo.analyze`
   * uses. No orientation pass — the original was normalised at upload, before
   * it was stored.
   */
  private async analyzeStoredPhoto(photoJpeg: Buffer): Promise<readonly PhotoFace[]> {
    const api = this.ctx.api
    if (!api) throw new Error('face photo re-enrol: the addon API is not available')
    const { result, nodeId } = await this.runPhotoFacePipeline(api, photoJpeg)
    const analysis = await analyzePhotoFaces(
      {
        runFacePipeline: async () => result,
        maxEmbeddingMagnitude: FACE_DEFAULTS.maxEmbeddingMagnitude,
        logger: {
          info: (message, extras) =>
            this.ctx.logger.info(message, { ...extras, meta: { ...extras?.meta, nodeId } }),
          warn: (message, extras) =>
            this.ctx.logger.warn(message, { ...extras, meta: { ...extras?.meta, nodeId } }),
        },
      },
      { photoJpeg },
    )
    return analysis.faces
  }

  /**
   * Bring every re-embeddable gallery sample into the CLUSTER row's
   * `face-embedding` space (`face-reembed-pass.ts` — bounded, resumable,
   * idempotent). This is the other half of a model flip: without it, every
   * sample stamped with the previous model is matchable by nothing.
   */
  private async runFaceReembedPass(
    input: ReembedFacesInput,
    confirmedTargetModelId?: string,
  ): Promise<ReembedFacesResult> {
    const api = this.ctx.api
    if (!api) throw new Error('embedding.reembedFaces: the addon API is not available')
    const identityStore = this.identityStore
    if (!identityStore) throw new Error('embedding.reembedFaces: the identity store is not ready')
    const mediaStore = this.mediaStore
    if (!mediaStore) throw new Error('embedding.reembedFaces: the media store is not ready')
    if (this.faceReembedRunning) {
      throw new Error('embedding.reembedFaces: a face re-embed pass is already running')
    }
    if (this.faceAlignmentJobs?.isPhotoPassRunning === true) {
      throw new Error('embedding.reembedFaces: a photo re-enrol pass is running')
    }
    if (this.faceAlignmentJobs?.isResetRunning === true) {
      throw new Error('embedding.reembedFaces: a face gallery reset is running')
    }
    // Claimed in the SAME synchronous step as the checks above, before the
    // first await: the photo pass checks this flag, and a gap here would let
    // both start (D643).
    this.faceReembedRunning = true
    try {
      // The auto path hands in the target it already confirmed; the operator's
      // path confirms here. Either way: two agreeing reads, never a default
      // standing in for a read that answered nothing (D651 fix round).
      let targetModelId = confirmedTargetModelId
      if (targetModelId === undefined) {
        const confirmation = await this.getClusterPinConfirmer(
          api,
          'face-reembed-operator',
        ).confirm()
        if (confirmation.kind === 'refused') {
          throw new Error(
            `embedding.reembedFaces: the cluster face-embedding model is not confirmed (${confirmation.reason}) — nothing was changed`,
          )
        }
        targetModelId = confirmation.modelId
      }
      const nodeIds = await this.resolveRebuildNodes(api, input.executeOnNodeId)
      const embedder = new FaceReembedEmbedder(
        {
          runStatelessStep: (nodeId, stepInput) => this.runRebuildStepOn(nodeId, stepInput),
          logger: { warn: (m, e) => this.ctx.logger.warn(m, e) },
        },
        nodeIds,
        targetModelId,
      )
      const result: FaceReembedResult = await reembedFaceGallery(
        {
          listSamples: () => identityStore.listSamplesForReembed(),
          loadAlignedCrop: async (sample) => {
            if (sample.mediaId === undefined) return null
            try {
              const file = await mediaStore.getBytesById(sample.mediaId)
              return file === null ? null : file.bytes
            } catch (err: unknown) {
              this.ctx.logger.warn('face re-embed: aligned crop read threw', {
                meta: { sampleId: sample.sampleId, error: String(err) },
              })
              return null
            }
          },
          embed: (sample, crop) => embedder.embed(sample, crop),
          store: (sample, embedding, modelId, dim) =>
            identityStore.restampSample({
              sampleId: sample.sampleId,
              identityId: sample.identityId,
              embedding,
              modelId,
              dim,
            }),
          pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          logger: {
            info: (m, e) => this.ctx.logger.info(m, e),
            warn: (m, e) => this.ctx.logger.warn(m, e),
          },
        },
        {
          targetModelId,
          ...(input.maxSamples !== undefined ? { maxSamples: input.maxSamples } : {}),
        },
      )
      this.faceReembedPixelless = new Set(result.pixellessSampleIds)
      // The matcher's gallery mirror still holds the OLD vectors — reload it so
      // a recognition that happens one second after the pass uses what landed.
      await this.faceRecognizer?.refreshGallery()
      const { pixellessSampleIds: _ignored, ...wire } = result
      return { ...wire, targetModelId }
    } finally {
      this.faceReembedRunning = false
    }
  }

  /**
   * D658: re-embed EXACTLY the named samples with ONE pinned model, forced
   * (`face-sample-reembed.ts`) — the repair for what the audit accuses. Shares
   * the gallery-job exclusion with the re-embed pass, the photo pass and the
   * reset, and reloads the matcher's gallery when anything landed.
   */
  private async reembedFaceGallerySamples(
    input: ReembedSamplesInput,
  ): Promise<ReembedSamplesResult> {
    const api = this.ctx.api
    if (!api) throw new Error('faceGallery.reembedSamples: the addon API is not available')
    const identityStore = this.identityStore
    if (!identityStore) {
      throw new Error('faceGallery.reembedSamples: the identity store is not ready')
    }
    const mediaStore = this.mediaStore
    if (!mediaStore) throw new Error('faceGallery.reembedSamples: the media store is not ready')
    if (this.faceReembedRunning) {
      throw new Error('faceGallery.reembedSamples: a face re-embed pass is already running')
    }
    if (this.faceAlignmentJobs?.isPhotoPassRunning === true) {
      throw new Error('faceGallery.reembedSamples: a photo re-enrol pass is running')
    }
    if (this.faceAlignmentJobs?.isResetRunning === true) {
      throw new Error('faceGallery.reembedSamples: a face gallery reset is running')
    }
    // Claimed in the same synchronous step as the checks (D643).
    this.faceReembedRunning = true
    try {
      const nodeIds = await this.resolveRebuildNodes(api, input.executeOnNodeId)
      const embedder = new FaceReembedEmbedder(
        {
          runStatelessStep: (nodeId, stepInput) => this.runRebuildStepOn(nodeId, stepInput),
          logger: { warn: (m, e) => this.ctx.logger.warn(m, e) },
        },
        nodeIds,
        input.modelId,
      )
      const result = await reembedFaceSamples(
        {
          listSamples: () => identityStore.listSamplesForReembed(),
          loadAlignedCrop: async (sample) => {
            if (sample.mediaId === undefined) return null
            try {
              const file = await mediaStore.getBytesById(sample.mediaId)
              return file === null ? null : file.bytes
            } catch (err: unknown) {
              this.ctx.logger.warn('face sample re-embed: aligned crop read threw', {
                meta: { sampleId: sample.sampleId, error: String(err) },
              })
              return null
            }
          },
          embed: (sample, crop) => embedder.embed(sample, crop),
          store: (sample, embedding, modelId, dim) =>
            identityStore.restampSample({
              sampleId: sample.sampleId,
              identityId: sample.identityId,
              embedding,
              modelId,
              dim,
            }),
          pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          logger: {
            info: (m, e) => this.ctx.logger.info(m, e),
            warn: (m, e) => this.ctx.logger.warn(m, e),
          },
        },
        { sampleIds: input.sampleIds, modelId: input.modelId },
      )
      if (result.reembedded > 0) await this.faceRecognizer?.refreshGallery()
      return { ...result, rows: [...result.rows] }
    } finally {
      this.faceReembedRunning = false
    }
  }

  /**
   * D658: re-embed each sample's stored template with ONE pinned model and
   * compare with its stored vector (`face-embedding-audit.ts`). READ-ONLY —
   * nothing is restamped, re-embedded or removed. The pass pins the model the
   * caller names (default `auraface-r100`), not the cluster row: the question
   * is whether a STAMP is true, whatever the cluster runs today.
   */
  private async auditFaceGalleryEmbeddings(
    input: AuditFaceEmbeddingsInput,
  ): Promise<AuditFaceEmbeddingsResult> {
    const api = this.ctx.api
    if (!api) throw new Error('faceGallery.auditEmbeddings: the addon API is not available')
    const identityStore = this.identityStore
    if (!identityStore) {
      throw new Error('faceGallery.auditEmbeddings: the identity store is not ready')
    }
    const mediaStore = this.mediaStore
    if (!mediaStore) throw new Error('faceGallery.auditEmbeddings: the media store is not ready')
    const auditedModelId = input.modelId ?? DEFAULT_AUDITED_FACE_MODEL
    const nodeIds = await this.resolveRebuildNodes(api, input.executeOnNodeId)
    const embedder = new FaceReembedEmbedder(
      {
        runStatelessStep: (nodeId, stepInput) => this.runRebuildStepOn(nodeId, stepInput),
        logger: { warn: (m, e) => this.ctx.logger.warn(m, e) },
      },
      nodeIds,
      auditedModelId,
    )
    const report = await auditFaceEmbeddings(
      {
        listSamples: () => identityStore.listSamplesForReembed(),
        loadStoredVectors: (ids) => identityStore.loadSampleVectors(ids),
        loadAlignedCrop: async (sample) => {
          if (sample.mediaId === undefined) return null
          try {
            const file = await mediaStore.getBytesById(sample.mediaId)
            return file === null ? null : file.bytes
          } catch (err: unknown) {
            this.ctx.logger.warn('face embedding audit: aligned crop read threw', {
              meta: { sampleId: sample.sampleId, error: String(err) },
            })
            return null
          }
        },
        embed: (sample, crop) => embedder.embed(sample, crop),
      },
      {
        auditedModelId,
        ...(input.identityId !== undefined ? { identityId: input.identityId } : {}),
        ...(input.maxSamples !== undefined ? { maxSamples: input.maxSamples } : {}),
      },
    )
    this.ctx.logger.info('face embedding audit finished', {
      meta: {
        auditedModelId,
        total: report.total,
        ok: report.ok,
        mismatch: report.mismatch,
        inconclusive: report.inconclusive,
        unmeasurable: report.unmeasurable,
        complete: report.complete,
      },
    })
    return {
      ...report,
      okMinCosine: AUDIT_OK_MIN_COSINE,
      mismatchMaxCosine: AUDIT_MISMATCH_MAX_COSINE,
      rows: [...report.rows],
    }
  }

  /**
   * The server-side half of "change the model from any UI and the gallery
   * follows": if a sample sits outside the cluster space and a pass could
   * still bring it in, start one. Runs on a timer; converges and goes quiet.
   */
  private async maybeAutoReembedFaces(): Promise<void> {
    try {
      const api = this.ctx.api
      const identityStore = this.identityStore
      if (!api || !identityStore || this.faceReembedRunning) return
      if (this.faceAlignmentJobs?.isPhotoPassRunning === true) return
      if (this.faceAlignmentJobs?.isResetRunning === true) return
      // The owner's answer, read once; the second read that must agree is
      // paid only when that answer shows work to do (D49, D651).
      const confirmer = this.getClusterPinConfirmer(api, 'face-reembed-auto')
      const first = await confirmer.readFirst()
      if (first.kind === 'refused') return
      const firstTarget =
        first.answer.kind === 'known' ? first.answer.modelId : first.answer.defaultModelId
      const samples = await identityStore.listSamplesForReembed()
      if (
        !shouldAutoReembed(samples, firstTarget, this.faceReembedPixelless, this.faceReembedRunning)
      ) {
        return
      }
      const confirmation = await confirmer.confirmAgainst(first.answer)
      if (confirmation.kind === 'refused') return
      const target = confirmation.modelId
      this.ctx.logger.info(
        'face gallery re-embed: auto-starting — samples outside the cluster space',
        {
          meta: {
            targetModelId: target,
            total: samples.length,
            maxSamples: FACE_AUTO_REEMBED_MAX_SAMPLES,
          },
        },
      )
      await this.runFaceReembedPass({ maxSamples: FACE_AUTO_REEMBED_MAX_SAMPLES }, target)
    } catch (err: unknown) {
      this.ctx.logger.warn('face gallery auto re-embed failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  private getClusterPinConfirmer(
    api: NonNullable<AddonContext['api']>,
    caller: ClusterPinCaller,
  ): ClusterPinConfirmer {
    const existing = this.clusterPinConfirmers.get(caller)
    if (existing !== undefined) return existing
    const stepId = caller === 'clip-rebuild' ? CLIP_EMBEDDING_STEP_ID : FACE_EMBEDDING_STEP_ID
    const confirmer = new ClusterPinConfirmer({
      readPin: () => readClusterModelPinStrict(api, stepId),
      label: caller,
      logger: {
        info: (m, e) => this.ctx.logger.info(m, e),
        warn: (m, e) => this.ctx.logger.warn(m, e),
      },
    })
    this.clusterPinConfirmers.set(caller, confirmer)
    return confirmer
  }

  /** "How much of the gallery is in the cluster space" — per identity, honestly. */
  private async getFaceReembedStatus(): Promise<ReembedFacesStatus> {
    const api = this.ctx.api
    if (!api) throw new Error('embedding.reembedFacesStatus: the addon API is not available')
    const identityStore = this.identityStore
    if (!identityStore) {
      throw new Error('embedding.reembedFacesStatus: the identity store is not ready')
    }
    // The SAME owner answer the pass pins on (D651), so the status and the
    // pass cannot disagree about which space "in space" means. An unreadable
    // answer is reported by name, never counted against a guessed model.
    const pin = await readClusterModelPinStrict(api, FACE_EMBEDDING_STEP_ID)
    const targetModelId =
      pin.kind === 'known' ? pin.modelId : pin.kind === 'not-stored' ? pin.defaultModelId : ''
    const samples = await identityStore.listSamplesForReembed()
    const progress = faceReembedProgress(samples, targetModelId, this.faceReembedPixelless)
    return {
      running: this.faceReembedRunning,
      ...progress,
      byIdentity: [...progress.byIdentity],
      ...(pin.kind === 'unknown' ? { modelUnreadable: pin.reason } : {}),
      ...(pin.kind === 'not-stored' ? { modelByAbsence: true } : {}),
    }
  }

  /**
   * Side of the canonical ArcFace aligned template, in pixels
   * (`ARCFACE_TEMPLATE_112` / `face-align.ts` on the runner). A stored face crop
   * of exactly this size IS the template the embedder was fed; any other size
   * is a padded bbox cut that only looks like one.
   */
  private static readonly ARCFACE_TEMPLATE_PX = 112

  /**
   * Re-embed ONE buffered face from its stored crop, into the cluster's current
   * `face-embedding` space, and persist the result on the face row.
   *
   * Persisting is not optional. `assignFace` enrols `face.embedding` verbatim,
   * so a rescore that computed a fresh vector, showed the operator a convincing
   * percentage and then threw the vector away would enrol the STALE one the
   * moment they acted on it — the gallery would gain a sample in a space the
   * matcher cannot reach, which is precisely the failure the whole re-embed
   * pass exists to undo.
   *
   * The 112×112 check is the load-bearing guard. A face's crop is the ArcFace
   * template only when the detection carried landmarks; otherwise it is a
   * padded bbox cut, and `face-embedding` over THAT as a whole frame returns a
   * vector that passes every gate and means nothing (`face-reembed-pass.ts`
   * documents the mirror-image trap). Refusing beats answering.
   */
  private async reembedBufferedFace(
    face: FaceRecord,
    clusterModelId: string,
  ): Promise<{
    report: FaceReembedReport
    embedding: readonly number[] | null
  }> {
    const api = this.ctx.api
    const faceStore = this.faceStore
    const mediaStore = this.mediaStore
    const refuse = (
      reason: FaceReembedRefusal,
      detail: string,
    ): { report: FaceReembedReport; embedding: null } => {
      this.ctx.logger.warn('face rescore: re-embed refused', {
        tags: { deviceId: face.deviceId },
        meta: {
          faceId: face.id,
          trackId: face.trackId,
          reason,
          detail,
          clusterModelId,
        },
      })
      return {
        report: {
          attempted: true,
          succeeded: false,
          reason,
          detail,
          modelId: clusterModelId,
        },
        embedding: null,
      }
    }
    if (!api || !faceStore || !mediaStore) {
      return refuse('failed', 'the addon API or the face/media stores are not ready')
    }
    if (face.mediaId === undefined) {
      return refuse('no-pixels', 'this face kept no crop — there is nothing to re-embed from')
    }
    const file = await mediaStore.getBytesById(face.mediaId)
    if (file === null) {
      return refuse('no-pixels', `the crop blob ${face.mediaId} is gone`)
    }
    const raster = await decodeJpegToRgb(file.bytes)
    const templatePx = PipelineAnalyticsAddon.ARCFACE_TEMPLATE_PX
    if (raster.width !== templatePx || raster.height !== templatePx) {
      return refuse(
        'not-a-template',
        `the stored crop is ${raster.width}×${raster.height}, not the ${templatePx}² aligned template — this face was captured without landmarks, so re-embedding it would produce a plausible and meaningless vector`,
      )
    }

    const nodeIds = await this.resolveRebuildNodes(api, undefined)
    const embedder = new FaceReembedEmbedder(
      {
        runStatelessStep: (nodeId, stepInput) => this.runRebuildStepOn(nodeId, stepInput),
        logger: { warn: (m, e) => this.ctx.logger.warn(m, e) },
      },
      nodeIds,
      clusterModelId,
    )
    const outcome = await embedder.embed(
      {
        sampleId: face.id,
        identityId: face.recognizedIdentityId ?? '',
        identityName: `track ${face.trackId}`,
        modelId: face.embeddingModelId ?? LEGACY_MODEL_ID,
        dim: face.embedding.length,
        mediaId: face.mediaId,
      },
      file.bytes,
    )
    if (outcome.kind === 'no-capable-node') return refuse('no-capable-node', outcome.reason)
    if (outcome.kind === 'failed') return refuse('failed', outcome.reason)

    // D58: gate on "did it persist", never on "the call returned". The vector
    // and the stamp live in two homes now — the index and the row — so both are
    // written and BOTH are read back: a stamp that moved without its vector is a
    // face the matcher believes is comparable and is not.
    const restamped = await faceStore.restampEmbedding({
      faceId: face.id,
      deviceId: face.deviceId,
      trackId: face.trackId,
      timestamp: face.timestamp,
      embedding: outcome.embedding,
      modelId: clusterModelId,
    })
    if (!restamped) {
      return refuse('not-persisted', 'the re-embedded vector did not land on the face row')
    }
    this.ctx.logger.info('face rescore: re-embedded into the cluster model space', {
      tags: { deviceId: face.deviceId },
      meta: {
        faceId: face.id,
        trackId: face.trackId,
        from: face.embeddingModelId ?? LEGACY_MODEL_ID,
        to: clusterModelId,
        dim: outcome.dim,
      },
    })
    return {
      report: { attempted: true, succeeded: true, modelId: clusterModelId },
      embedding: outcome.embedding,
    }
  }

  /**
   * The matcher parameters in force for one device, as the report echoes them.
   *
   * The suggestion floor is DERIVED here and nowhere else in this class
   * (D222) — and it is reported WITH `suggestionBandFactor`, because a floor
   * that moves whenever the threshold moves reads as a bug unless the rule is
   * on screen beside it. There is no stored `suggestionMinCosine` to report:
   * the one the live hub carried (0.33) decided nothing from the moment this
   * shipped, and the retention pass removes it.
   */
  private faceRescoreParams(settings: FaceSettings): FaceRescoreParams {
    return {
      threshold: settings.similarityThreshold,
      margin: settings.margin,
      minIdentitySamples: settings.minIdentitySamples,
      suggestionMinCosine: deriveSuggestionMinCosine(settings.similarityThreshold),
      suggestionBandFactor: SUGGESTION_BAND_FACTOR,
    }
  }

  /**
   * `face.rescoreTrack` — the operator's "what does the gallery say NOW?".
   *
   * See `face-rescore.ts` for why the number already on the track cannot answer
   * that: it was computed during live detection and persisted at track close,
   * so every enrolment made since is invisible to it.
   *
   * The report's result is PERSISTED (`persistRescoreResult`, below) onto
   * `Face.suggestedIdentityId` / `suggestedMatchScore` — the SAME columns the
   * live recognizer's suggestion band writes, so a reader never has to know
   * whether a suggestion came from track close or from this button. Still
   * never a background job: this write happens once, only because the
   * operator asked THIS question right now.
   */
  private async rescoreFaceForTrack(
    input: FaceRescoreActionInput,
  ): Promise<FaceRescoreActionResult> {
    const api = this.ctx.api
    if (!api) throw new Error('face.rescoreTrack: the addon API is not available')
    const faceStore = this.faceStore
    if (!faceStore) throw new Error('face.rescoreTrack: the face store is not ready')
    const identityStore = this.identityStore
    if (!identityStore) throw new Error('face.rescoreTrack: the identity store is not ready')

    // The buffered-face key invariant (`getFaceByTrack` relies on the same one).
    const faceId = `face-${input.trackId}`
    const face = await faceStore.getWithEmbedding(faceId)
    if (!face) {
      throw new Error(`face.rescoreTrack: no buffered face for track ${input.trackId}`)
    }
    if (face.deviceId !== input.deviceId) {
      throw new Error(
        `face.rescoreTrack: face ${faceId} belongs to device ${face.deviceId}, not ${input.deviceId}`,
      )
    }

    const clusterModelId = await resolveClusterModelPin(api, FACE_EMBEDDING_STEP_ID, {
      warn: (m, e) => this.ctx.logger.warn(m, e),
    })
    if (clusterModelId === null) {
      // Refuse rather than guess: a report that named the wrong space would
      // call a comparable face incomparable, or worse, the reverse.
      throw new Error('face.rescoreTrack: the cluster face-embedding model could not be resolved')
    }

    // The SAME per-device cascade the live recognizer runs on. A report against
    // schema defaults would describe a pipeline nobody is running — the live
    // hub carries a `similarityThreshold` override today.
    const settings = await this.resolveDeviceFaceSettings(input.deviceId)
    const params = this.faceRescoreParams(settings)

    let probeEmbedding: readonly number[] = face.embedding
    let probeModelId = face.embeddingModelId ?? LEGACY_MODEL_ID
    let reembed: FaceReembedReport = {
      attempted: false,
      succeeded: false,
      reason: 'not-requested',
    }
    if (input.reembed) {
      const outcome = await this.reembedBufferedFace(face, clusterModelId)
      reembed = outcome.report
      if (outcome.embedding !== null) {
        probeEmbedding = outcome.embedding
        probeModelId = clusterModelId
      }
    }

    const [gallery, identities] = await Promise.all([
      identityStore.loadGallery(),
      identityStore.listIdentities(),
    ])
    const report = buildFaceRescoreReport({
      probe: { embedding: probeEmbedding, modelId: probeModelId },
      gallery,
      identityNames: new Map(identities.map((i) => [i.id, i.name])),
      clusterModelId,
      params,
    })

    // Persist the result onto the SUGGESTED tier — the ONE write this
    // explicitly-requested action makes. `persistRescoreResult` is what
    // actually refuses to write a `model-mismatch` (`comparable: false`)
    // report; see `face-rescore.ts`. Never an assignment
    // (`recognizedIdentityId` / `assigned` are untouched), never automatic —
    // this call happens only because the operator pressed the button.
    const persisted = await persistRescoreResult(faceId, report, {
      setSuggestion: (id, suggestion) => faceStore.setSuggestion(id, suggestion),
    })

    this.ctx.logger.info('face rescore', {
      tags: { deviceId: input.deviceId },
      meta: {
        trackId: input.trackId,
        faceId,
        verdict: report.verdict,
        probeModelId,
        clusterModelId,
        gallerySamples: gallery.length,
        scored: report.identities.length,
        best: report.identities[0]?.name ?? null,
        bestScore: report.identities[0]?.score ?? null,
        storedSuggestion: face.suggestedMatchScore ?? null,
        reembedded: reembed.succeeded,
        // 'not-comparable' = refused to write (model-mismatch, did not look).
        // 'cleared' = wrote "no suggestion" (looked, gallery has nothing now).
        // 'written' = wrote a fresh candidate.
        persisted,
      },
    })

    return {
      faceId,
      deviceId: face.deviceId,
      trackId: face.trackId,
      assigned: face.assigned,
      ...(face.recognizedIdentityId != null
        ? { assignedIdentityId: face.recognizedIdentityId }
        : {}),
      ...(face.suggestedIdentityId != null
        ? { storedSuggestedIdentityId: face.suggestedIdentityId }
        : {}),
      ...(face.suggestedMatchScore != null
        ? { storedSuggestedMatchScore: face.suggestedMatchScore }
        : {}),
      verdict: report.verdict,
      comparable: report.comparable,
      probeModelId: report.probeModelId,
      clusterModelId: report.clusterModelId,
      params: report.params,
      identities: report.identities,
      ...(report.runnerUpGap !== undefined ? { runnerUpGap: report.runnerUpGap } : {}),
      // Offer the escape hatch only when it could do something: the face must
      // be out of the cluster space AND still have pixels to re-embed from.
      reembedAvailable: probeModelId !== clusterModelId && face.mediaId !== undefined,
      reembed,
    }
  }

  private buildFaceRescoreActionHandlers(): Record<string, (input: never) => Promise<unknown>> {
    return {
      'face.rescoreTrack': (input: FaceRescoreActionInput): Promise<FaceRescoreActionResult> =>
        this.rescoreFaceForTrack(input),
      // Both return at once: the job runs in the background (single-flight).
      'face.rescoreAll': (): Promise<FaceRescoreJobStatus> =>
        Promise.resolve(this.requireFaceRescoreRuntime('face.rescoreAll').job.start()),
      'face.rescoreStatus': (): Promise<FaceRescoreJobStatus> =>
        Promise.resolve(this.requireFaceRescoreRuntime('face.rescoreStatus').job.status()),
    }
  }

  /** The whole-archive rescore runtime, built once the stores exist; else null. */
  private faceRescoreRuntimeOrNull(): FaceRescoreRuntime | null {
    if (this.faceRescoreRuntime) return this.faceRescoreRuntime
    const api = this.ctx.api
    const faceStore = this.faceStore
    const identityStore = this.identityStore
    const state = this.faceRescoreState
    if (!api || !faceStore || !identityStore || !state) return null
    this.faceRescoreRuntime = buildFaceRescoreRuntime(
      {
        api,
        faceStore,
        identityStore,
        state,
        logger: this.ctx.logger.child('FaceRescore'),
        paramsForDevice: async (deviceId) =>
          this.faceRescoreParams(await this.resolveDeviceFaceSettings(deviceId)),
      },
      Date.now(),
    )
    return this.faceRescoreRuntime
  }

  private requireFaceRescoreRuntime(action: string): FaceRescoreRuntime {
    const runtime = this.faceRescoreRuntimeOrNull()
    if (!runtime) throw new Error(`${action}: the face stores are not ready`)
    return runtime
  }

  private buildStillnessCalibrationActionHandlers(): Record<
    string,
    (input: never) => Promise<unknown>
  > {
    return {
      'stillness.calibrate': (input: StillnessCalibrateInput): Promise<StillnessCalibrateResult> =>
        this.calibrateStillnessForDevice(input),
    }
  }

  /**
   * Measure ONE camera's stillness scale from its own recorded tracks.
   *
   * Cost-bounded by construction: one `queryRecent` page of at most
   * `maxTracks` rows over the requested window, `projection: 'full'` because
   * the trajectory IS the measurement, and nothing else is read. The arithmetic
   * is `stillness-scale.ts` and is pure — this method only fetches, reports and
   * (on `apply`) writes.
   *
   * A REFUSAL never writes the bar. It does write the note, because "why is
   * this camera still on the default" has to be answerable from the form
   * rather than from a toast nobody kept.
   */
  private async calibrateStillnessForDevice(
    input: StillnessCalibrateInput,
  ): Promise<StillnessCalibrateResult> {
    const trackStore = this.trackStore
    if (!trackStore) throw new Error('stillness.calibrate: the track store is not ready')

    const until = Date.now()
    const since = until - Math.round(input.sinceHours * 3_600_000)
    const limits = { ...DEFAULT_STILLNESS_CALIBRATION_LIMITS, maxTracks: input.maxTracks }

    const previous = resolveStillSpeedFracPerSec(
      await this.resolveDeviceStillnessSettings(input.deviceId),
    )

    const page = await trackStore.queryRecent({
      deviceIds: [input.deviceId],
      since,
      until,
      limit: limits.maxTracks,
      projection: 'full',
    })
    const tracks: readonly CalibrationTrack[] = page.tracks.map((t) => ({
      trackId: t.trackId,
      className: t.className,
      positions: t.positions.map((pos) => ({
        x: pos.x,
        y: pos.y,
        timestamp: pos.timestamp,
        bbox: { w: pos.bbox.w, h: pos.bbox.h },
      })),
    }))

    const samples = collectStillnessSamples(tracks, limits)
    const outcome = calibrateStillnessSpeed(samples, limits)
    const note = describeStillnessCalibration(outcome)

    // A quantile of an empty list is NaN, and NaN is what "not measured" looks
    // like here. It must never cross the wire as 0 — that reads as a measured
    // stillness of zero (D393).
    const finite = (v: number): number | null => (Number.isFinite(v) ? v : null)
    const measurement = {
      trackCount: outcome.measurement.trackCount,
      tracksRead: samples.tracksRead,
      sampleCount: outcome.measurement.sampleCount,
      p25: finite(outcome.measurement.p25),
      p50: finite(outcome.measurement.p50),
      p90: finite(outcome.measurement.p90),
      medianIntervalSec: finite(outcome.measurement.medianIntervalSec),
      medianSubjectDiagonalPx: finite(outcome.measurement.medianSubjectDiagonalPx),
    }

    let applied = false
    if (input.apply) {
      const patch: Record<string, unknown> = {
        stillnessCalibrationNote: note,
        stillnessCalibratedAt: until,
      }
      if (outcome.ok) patch['stillnessSpeedFracPerSec'] = outcome.bar
      await this.applyDeviceSettingsPatch({ deviceId: input.deviceId, patch })
      applied = outcome.ok
    }

    this.ctx.logger.info('stillness calibration', {
      tags: { deviceId: input.deviceId },
      meta: {
        accepted: outcome.ok,
        ...(outcome.ok ? {} : { reason: outcome.reason }),
        ...(outcome.ok ? { bar: outcome.bar, clampedBy: outcome.clampedBy } : {}),
        previousBar: previous ?? null,
        applied,
        windowHours: input.sinceHours,
        ...measurement,
      },
    })

    return {
      deviceId: input.deviceId,
      since,
      until,
      accepted: outcome.ok,
      ...(outcome.ok ? {} : { reason: outcome.reason }),
      ...(outcome.ok
        ? { bar: outcome.bar, rawBar: outcome.rawBar, clampedBy: outcome.clampedBy }
        : {}),
      measurement,
      previousBar: previous ?? null,
      applied,
      note,
    }
  }

  private buildPhotoEnrollActionHandlers(): Record<string, (input: never) => Promise<unknown>> {
    return {
      'photo.analyze': async (input: PhotoAnalyzeInput): Promise<PhotoAnalyzeResult> => {
        const api = this.ctx.api
        if (!api) throw new Error('photo.analyze: the addon API is not available')
        const uploadedJpeg = Buffer.from(input.photoBase64, 'base64')
        if (uploadedJpeg.length === 0) {
          throw new Error('photo.analyze: the uploaded photograph decoded to zero bytes')
        }
        // Bake the EXIF orientation into the raster BEFORE anything sees the
        // bytes: the pipeline decoder ignores EXIF, so a phone photo would be
        // analysed upside-down — faces missed, crops shown inverted.
        const photoJpeg = await normalizePhotoOrientation(uploadedJpeg)
        const { result, nodeId } = await this.runPhotoFacePipeline(api, photoJpeg)
        const analysis = await analyzePhotoFaces(
          {
            runFacePipeline: async () => result,
            // The bound the LIVE gate uses for a camera whose operator never
            // set one — which is the same number, from the same schema. A
            // photo-only default would be a second knob disagreeing with the
            // first, and the per-camera knob cannot apply to a photograph
            // because a photograph has no camera.
            maxEmbeddingMagnitude: FACE_DEFAULTS.maxEmbeddingMagnitude,
            // The node and the file name are folded into every line this
            // analysis emits: "no faces found" is unanswerable without knowing
            // WHICH photo went to WHICH node.
            logger: {
              info: (message, extras) =>
                this.ctx.logger.info(message, {
                  ...extras,
                  meta: {
                    ...extras?.meta,
                    nodeId,
                    file: input.filename ?? null,
                  },
                }),
              warn: (message, extras) =>
                this.ctx.logger.warn(message, {
                  ...extras,
                  meta: {
                    ...extras?.meta,
                    nodeId,
                    file: input.filename ?? null,
                  },
                }),
            },
          },
          { photoJpeg },
        )
        const sessionId = this.photoSessions.put({
          photoJpeg,
          faces: analysis.faces,
        })
        return {
          sessionId,
          // The vectors stay here. `toWireFace` is what drops them.
          faces: analysis.faces.map(toWireFace),
          ranOnNodeId: nodeId,
        }
      },

      'photo.enroll': async (input: PhotoEnrollActionInput): Promise<PhotoEnrollActionResult> => {
        const identityStore = this.identityStore
        const mediaStore = this.mediaStore
        if (!identityStore || !mediaStore) {
          throw new Error('photo.enroll: the gallery stores are not available on this node')
        }
        const session = this.photoSessions.get(input.sessionId)
        if (session === null) {
          throw new Error('photo.enroll: that analysis has expired — upload the photograph again')
        }
        const face = session.faces.find((f) => f.faceIndex === input.faceIndex)
        if (face === undefined) {
          throw new Error(`photo.enroll: face ${input.faceIndex} is not in that analysis`)
        }
        const result = await enrollPhotoFace(
          {
            loadGallery: () => identityStore.loadGallery(),
            putIdentityMedia: (media) =>
              mediaStore.put({
                // Not a camera — the absence of one. See PHOTO_ENROLL_DEVICE_ID.
                deviceId: PHOTO_ENROLL_DEVICE_ID,
                // `identity` is what routes both blobs to `galleryMedia`, the
                // location a footage wipe cannot reach (D197).
                ownerKind: 'identity',
                ownerId: media.identityId,
                kind: media.kind,
                timestamp: Date.now(),
                data: media.data,
              }),
            deleteMedia: (key) => mediaStore.deleteById(key),
            addSample: (sample) => identityStore.addSample(sample),
            refreshGallery: () => this.faceRecognizer?.refreshGallery(),
            logger: this.ctx.logger,
          },
          { identityId: input.identityId, photoJpeg: session.photoJpeg, face },
        )
        return {
          sampleId: result.sampleId,
          identityId: result.identityId,
          modelId: result.modelId,
        }
      },

      'photo.discard': async (input: PhotoDiscardInput): Promise<PhotoDiscardResult> => {
        const existed = this.photoSessions.get(input.sessionId) !== null
        this.photoSessions.delete(input.sessionId)
        return { discarded: existed }
      },
    }
  }

  /**
   * Handlers behind the embedding buttons in the settings form.
   *
   * They are thin wrappers over the cap methods on purpose: the button and the
   * API must not be able to drift into two behaviours.
   */
  private buildEmbeddingActionHandlers(): Record<string, (input: never) => Promise<unknown>> {
    return {
      'embedding.rebuild': async (input: EmbeddingRebuildInput) =>
        this.rebuildObjectEmbeddings(input),
      'embedding.rebuildStatus': async () => {
        const status = await this.getObjectEmbeddingRebuildStatus()
        // Fold in the index sizes: they are the numbers an operator actually
        // watches while a rebuild runs, and asking them to open a second surface
        // for them would make the button useless on its own. EVERY CLIP index
        // (D649) — the one the pass fills and the one it replaces, side by side.
        // An index whose count could not be read is `null` — UNKNOWN, never 0
        // (D393): a 0 there reads as "the pass wrote nothing".
        const indexedByIndex: Record<string, number | null> = {}
        const api = this.ctx.api
        for (const space of this.objectEmbeddingStore?.indexes() ?? []) {
          if (!api) {
            indexedByIndex[space.index] = null
            continue
          }
          try {
            const stats = await api.vectorStore.stats.query({ index: space.index })
            indexedByIndex[space.index] = stats.count
            if (this.unreadableClipIndexes.delete(space.index)) {
              this.ctx.logger.info('embedding.rebuildStatus: index size readable again', {
                meta: { index: space.index, count: stats.count },
              })
            }
          } catch (err: unknown) {
            // Once per index per state change — the operator polls this.
            if (!this.unreadableClipIndexes.has(space.index)) {
              this.unreadableClipIndexes.add(space.index)
              this.ctx.logger.warn(
                'embedding.rebuildStatus: index size unreadable — reported as unknown',
                { meta: { index: space.index, error: errMsg(err) } },
              )
            }
            indexedByIndex[space.index] = null
          }
        }
        const rebuildIndex =
          status.modelId !== null
            ? (this.objectEmbeddingStore?.indexFor(status.modelId) ?? null)
            : null
        const indexed = rebuildIndex !== null ? (indexedByIndex[rebuildIndex] ?? null) : null
        return { ...status, indexed, indexedByIndex }
      },
      // A wipe that left an index untouched is an ERROR on the button, not
      // "Removed N vectors" (D649).
      'embedding.wipe': async () => requireCompleteWipe(await this.wipeObjectEmbeddings()),
      'embedding.reembedFaces': async (input: ReembedFacesInput) => this.runFaceReembedPass(input),
      'embedding.reembedFacesStatus': async () => this.getFaceReembedStatus(),
      'embedding.reenrolPhotos': async (
        input: ReenrolPhotosInput,
      ): Promise<ReenrolPhotosResult> => {
        const jobs = this.faceAlignmentJobs
        if (jobs === null) throw new Error('embedding.reenrolPhotos: the face gallery is not ready')
        const result = await jobs.runPhotoPass(input)
        return { ...result, refusals: [...result.refusals], outcomes: [...result.outcomes] }
      },
      'embedding.backfillPhotoSources': async (
        input: BackfillPhotoSourcesInput,
      ): Promise<BackfillPhotoSourcesResult> => {
        const jobs = this.faceAlignmentJobs
        if (jobs === null) {
          throw new Error('embedding.backfillPhotoSources: the face gallery is not ready')
        }
        const result = await jobs.backfillPhotoSources(input)
        return { ...result, samples: [...result.samples] }
      },
      'faceGallery.reembedSamples': async (
        input: ReembedSamplesInput,
      ): Promise<ReembedSamplesResult> => this.reembedFaceGallerySamples(input),
      'faceGallery.auditEmbeddings': async (
        input: AuditFaceEmbeddingsInput,
      ): Promise<AuditFaceEmbeddingsResult> => this.auditFaceGalleryEmbeddings(input),
      'faceGallery.sourceFrameStats': async (): Promise<SourceFrameStatsResult> => ({
        devices: this.faceSourceStats.snapshot().map((d) => ({ ...d, dropped: { ...d.dropped } })),
      }),
      'faceGallery.resetToCore': async (input: ResetToCoreInput): Promise<ResetToCoreResult> => {
        const jobs = this.faceAlignmentJobs
        if (jobs === null) throw new Error('faceGallery.resetToCore: the face gallery is not ready')
        const result = await jobs.resetToCore(input)
        return {
          ...result,
          identities: result.identities.map((i) => ({ ...i, kept: [...i.kept] })),
        }
      },
      'embedding.faceAlignmentStatus': async (): Promise<FaceAlignmentStatusWire> => {
        const jobs = this.faceAlignmentJobs
        if (jobs === null) {
          throw new Error('embedding.faceAlignmentStatus: the face gallery is not ready')
        }
        const status = await jobs.status()
        return {
          ...status,
          lastPhotoPass:
            status.lastPhotoPass === null
              ? null
              : {
                  ...status.lastPhotoPass,
                  refusals: [...status.lastPhotoPass.refusals],
                  outcomes: [...status.lastPhotoPass.outcomes],
                },
          byIdentity: [...status.byIdentity],
        }
      },
      // Draining the standing orphan backlog is an operator ACT, not a setting
      // left switched on — and it reports rows AND bytes, per collection.
      'retention.orphanAudit': async (input: OrphanAuditActionInput) =>
        this.runOrphanAuditNow(input),
      'retention.orphanAuditStatus': async () => this.getOrphanAuditStatus(),
      // Same door as the cap: start, don't wait. The walk is tens of minutes.
      'retention.mediaReclaim': async (input: MediaReclaimActionInput) =>
        this.reclaimDebugMedia(input),
      'retention.mediaReclaimStatus': async () => this.getMediaReclaimStatus(),
      'storage.discardLocation': async (input: DiscardStartInput) =>
        this.discardJob?.start(input) ?? {
          started: false,
          alreadyRunning: false,
          jobId: null,
        },
      'storage.discardLocationStatus': async () => this.discardJob?.status() ?? IDLE_DISCARD,
      'storage.discardLocationCancel': async () =>
        this.discardJob?.cancel() ?? { requested: false },
      // Narrow: media rows of ONE location whose file is ENOENT. No cascade.
      'storage.forgetMissingMedia': async (input: MediaForgetInput): Promise<MediaForgetResult> => {
        const deps = this.mediaForgetDeps
        if (deps === null) throw new Error('storage.forgetMissingMedia: not initialised')
        return forgetMissingMediaRows(deps, input)
      },
    }
  }

  /**
   * Start a debug-media reclaim pass. DETACHED.
   *
   * Returns `{ started }` immediately. The walk is tens of minutes at 2 MB/s;
   * awaiting it is a timeout, not a verdict. Poll {@link getMediaReclaimStatus}.
   * Dry-run unless `mode: 'reclaim'`. A second call while one is in flight is
   * `alreadyRunning`, not a second walk on the same spindle.
   */
  async reclaimDebugMedia(
    rawInput: MediaReclaimActionInput,
  ): Promise<{ started: boolean; alreadyRunning: boolean }> {
    const input = MediaReclaimActionInputSchema.parse(rawInput)
    if (this.mediaReclaimState.running) {
      this.ctx.logger.info('debug-media reclaim already running — request ignored')
      return { started: false, alreadyRunning: true }
    }
    const mediaStore = this.mediaStore
    const eventStore = this.eventStore
    const trackStore = this.trackStore
    if (!mediaStore || !eventStore || !trackStore) {
      this.ctx.logger.warn('reclaimDebugMedia: analytics stores unavailable')
      return { started: false, alreadyRunning: false }
    }

    this.mediaReclaimState = {
      ...IDLE_MEDIA_RECLAIM,
      running: true,
      mode: input.mode,
      startedAtMs: Date.now(),
    }
    this.ctx.logger.info('debug-media reclaim starting', {
      meta: { mode: input.mode, restart: input.restart === true },
    })
    void this.executeMediaReclaim(input, mediaStore, eventStore, trackStore)
    return { started: true, alreadyRunning: false }
  }

  /**
   * The walk itself. Called DETACHED from {@link reclaimDebugMedia}; never
   * await this from an RPC.
   */
  private async executeMediaReclaim(
    input: MediaReclaimActionInput,
    mediaStore: MediaStore,
    eventStore: EventStore,
    trackStore: TrackStore,
  ): Promise<void> {
    try {
      const limits: MediaReclaimLimits = {
        mode: input.mode,
        pageSize: input.pageSize ?? DEFAULT_MEDIA_RECLAIM_LIMITS.pageSize,
        maxRowsPerDevice: input.maxRowsPerDevice ?? DEFAULT_MEDIA_RECLAIM_LIMITS.maxRowsPerDevice,
        maxReclaimPerDevice:
          input.maxReclaimPerDevice ?? DEFAULT_MEDIA_RECLAIM_LIMITS.maxReclaimPerDevice,
        maxBytesPerRun: input.maxBytesPerRun ?? DEFAULT_MEDIA_RECLAIM_LIMITS.maxBytesPerRun,
        budgetMs:
          input.budgetMinutes !== undefined
            ? input.budgetMinutes * 60_000
            : DEFAULT_MEDIA_RECLAIM_LIMITS.budgetMs,
        graceMs:
          input.graceMinutes !== undefined
            ? input.graceMinutes * 60_000
            : DEFAULT_MEDIA_RECLAIM_LIMITS.graceMs,
        throttleBytesPerSec:
          input.throttleBytesPerSec ?? DEFAULT_MEDIA_RECLAIM_LIMITS.throttleBytesPerSec,
      }
      const scopes: readonly MediaReclaimScope[] = input.scopes ?? MEDIA_RECLAIM_SCOPES
      const deviceIds = input.deviceIds ?? (await this.retention.retentionDeviceIds())
      const { report, cursors } = await runMediaReclaim({
        deviceIds,
        scopes,
        limits,
        cursors: input.restart === true ? new Map() : this.mediaReclaimCursors,
        onDevice: (device) => {
          const s = this.mediaReclaimState
          if (!s.running) return
          this.mediaReclaimState = {
            ...s,
            totalExamined: s.totalExamined + device.examined,
            totalEligible: s.totalEligible + device.eligible,
            totalReclaimed: s.totalReclaimed + device.reclaimed,
            totalBytesReclaimed: s.totalBytesReclaimed + device.bytesReclaimed,
            totalRefused: s.totalRefused + device.refused,
            devicesDone: s.devicesDone + 1,
          }
        },
        deps: {
          page: ({ deviceId, scope, afterMs, limit }) =>
            mediaStore.pageByKindForDevice({
              deviceId,
              // D476: a motion still is owned by 'motion', not 'event'.
              ownerKind: scope === 'motion-still' ? 'motion' : 'track',
              kind: 'snapshot',
              afterMs,
              limit,
            }),
          motionEventIds: (ids) => eventStore.existingMotionEventIds(ids),
          pinnedTrackIds: (ids) => trackStore.pinnedTrackIds(ids),
          reclaim: (key) => mediaStore.deleteConfirmed(key),
          now: () => Date.now(),
          logger: this.ctx.logger,
          breathe: () => new Promise<void>((resolve) => setImmediate(resolve)),
          pace: (ms) =>
            ms <= 0 ? Promise.resolve() : new Promise<void>((resolve) => setTimeout(resolve, ms)),
        },
      })
      this.mediaReclaimCursors = cursors
      if (limits.mode === 'reclaim' && report.totalReclaimed > 0) {
        await this.eventsOpsLog?.append({
          op: 'prune',
          reason: 'operator',
          deviceId: null,
          itemsAffected: report.totalReclaimed,
          bytesReclaimed: report.totalBytesReclaimed,
          detail: `debug-media reclaim (${scopes.join('+')}): ${report.totalReclaimed} rows, ${report.totalRefused} refused, complete=${report.complete}`,
        })
      }
      this.mediaReclaimState = {
        ...this.mediaReclaimState,
        running: false,
        totalExamined: report.totalExamined,
        totalEligible: report.totalEligible,
        totalReclaimed: report.totalReclaimed,
        totalBytesReclaimed: report.totalBytesReclaimed,
        totalRefused: report.totalRefused,
        complete: report.complete,
        finishedAtMs: Date.now(),
      }
      this.ctx.logger.info('debug-media reclaim finished', {
        meta: {
          mode: report.mode,
          examined: report.totalExamined,
          reclaimed: report.totalReclaimed,
          bytesReclaimed: report.totalBytesReclaimed,
          complete: report.complete,
        },
      })
    } catch (err) {
      this.mediaReclaimState = {
        ...this.mediaReclaimState,
        running: false,
        finishedAtMs: Date.now(),
        error: err instanceof Error ? err.message : String(err),
        complete: false,
      }
      this.ctx.logger.warn('debug-media reclaim failed', {
        meta: { error: String(err) },
      })
    }
  }

  /** Progress of the detached reclaim — the only way to observe a long pass. */
  async getMediaReclaimStatus(): Promise<MediaReclaimJobState> {
    return { ...this.mediaReclaimState }
  }

  /** Progress of the detached rebuild — the only way to observe a long pass. */
  async getObjectEmbeddingRebuildStatus(): Promise<RebuildStatusOut> {
    const state = this.rebuildState
    const p = state.progress
    return {
      running: state.running,
      scanned: p?.scanned ?? 0,
      rebuilt: p?.rebuilt ?? 0,
      // Pixels genuinely gone — and ONLY that (D664). `missingEvent` used to
      // be added in here; with audio/sensor tracks listed that made a
      // media-coverage number of thousands out of tracks that never had media.
      missingKeyFrame: p?.missingKeyFrame ?? 0,
      missingEvent: p?.missingEvent ?? 0,
      missingBbox: p?.missingBbox ?? 0,
      boxSource: p?.boxSource ?? { subjectBox: 0, positions: 0, event: 0, refused: 0 },
      alreadyInSpace: p?.alreadyInSpace ?? 0,
      force: state.force ?? null,
      forcedInSpace: p?.forcedInSpace ?? 0,
      notRunnable: p?.notRunnable ?? 0,
      noCapableNode: p?.noCapableNode ?? 0,
      failed: p?.failed ?? 0,
      complete: state.complete ?? null,
      startedAtMs: state.startedAtMs ?? null,
      finishedAtMs: state.finishedAtMs ?? null,
      error: state.error ?? null,
      modelId: state.modelId ?? null,
      index: state.index ?? null,
    }
  }

  async searchObjectEvents(input: {
    text: string
    deviceId?: number
    since?: number
    until?: number
    classFilter?: string
    limit: number
    minScore?: number
    strictness?: ClipSearchStrictness
    modelId?: string
    /** Server-injected (`caller: 'required'`); absent on an in-process call ⇒ non-admin. */
    caller?: CapCaller
  }): Promise<readonly ScoredObjectEvent[]> {
    const store = this.objectEmbeddingStore
    if (!store) return []

    const api = this.ctx.api
    if (!api) return []

    // Step 1: WHICH feature space. The caller's `modelId` when it names one
    // (every model's index stays searchable until it is wiped — D649), else
    // the cluster row, the space every writer is in.
    //
    // CACHED. The row read is a cross-process call; paying it on EVERY search
    // made it the single largest cost in a search whose ranking takes 0.25s.
    //
    // The plan THROWS when it cannot name a space: an empty list would read as
    // "nothing matched" (D315), and this is "could not search".
    const plan = resolveClipSearchPlan(
      input,
      // Read even when a model is named: a non-admin may only name THIS one.
      input.modelId !== undefined && input.caller?.isAdmin === true
        ? null
        : await this.resolveEncoderModelId(api),
      BUILTIN_CLIP_MODELS,
      input.caller ?? null,
    )
    const { modelId, minScore } = plan

    // Step 2: encode the query IN THAT SPACE. The model is named explicitly so
    // the encoder cannot answer from a different one mid-switch (its own row
    // cache and ours are two TTLs).
    // A failed encode THROWS with its cause — see `encodeClipQuery` (D315).
    const queryVec = await encodeClipQuery(
      (q) => api.embeddingEncoder.encodeText.query(q),
      input.text,
      modelId,
      (message, extras) => this.ctx.logger.warn(message, extras),
    )

    // Step 3: rank IN THE VECTOR STORE, in the model's own index. The
    // prefilters go into SQL and the cosine runs over compact rows in the
    // provider; this used to load the candidate pool into this process and
    // rank it in JS behind a 5,000-row cap, which is what made a default
    // search take 18s.
    const search = await store.searchByVector({
      vector: queryVec,
      limit: input.limit,
      minScore,
      modelId,
      ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
      ...(input.since !== undefined ? { since: input.since } : {}),
      ...(input.until !== undefined ? { until: input.until } : {}),
      ...(input.classFilter !== undefined ? { className: input.classFilter } : {}),
    })

    if (search.truncated) {
      // A branch that drops work says so. Silence would read as "nothing older
      // matched" when the truth is "older rows were never considered".
      this.ctx.logger.warn('searchObjectEvents: candidate pool truncated', {
        meta: {
          scanned: search.scanned,
          since: input.since,
          until: input.until,
          className: input.classFilter,
        },
        ...(input.deviceId !== undefined ? { tags: { deviceId: input.deviceId } } : {}),
      })
    }

    const ranked = search.hits
    if (ranked.length === 0) {
      if (input.classFilter !== undefined) {
        // `classFilter` is pushed onto the index's `className` column, and that
        // column holds the CLIP STEP's output class — the literal string
        // `embedding` on 22,122 of 22,124 live rows — not the track's class.
        // That is CORRECT for the writer (it is what keeps a face detail from
        // landing in the CLIP store) and it means a filter for `person` or
        // `vehicle` can only ever match zero rows. An empty result that looks
        // exactly like "nothing matched your text" is the whole problem, so the
        // parameter says what it really did.
        this.ctx.logger.warn('searchObjectEvents: classFilter matched nothing', {
          ...(input.deviceId !== undefined ? { tags: { deviceId: input.deviceId } } : {}),
          meta: {
            classFilter: input.classFilter,
            why: "the index's className column carries the CLIP step's output class, not the track's class — only that value can match",
          },
        })
      }
      return []
    }

    // The embedding row's own crop key per track — the search hit's thumbnail is
    // pointed at THIS crop (the crop captured on the embedding's peak frame), so
    // the hit thumbnail IS the embedded crop. Falls back to the event crop below.
    const embeddingMediaIdByTrackId = new Map<string, number>()
    // Design B: the track's native key frame (best-detection full frame) — a
    // search-detail view draws the event bbox over this native frame, falling
    // back to the tight crop (`mediaId`) when absent.
    const keyFrameMediaIdByTrackId = new Map<string, number>()
    for (const { row } of ranked) {
      if (row.mediaId !== undefined) embeddingMediaIdByTrackId.set(row.trackId, row.mediaId)
      if (row.keyFrameMediaId !== undefined)
        keyFrameMediaIdByTrackId.set(row.trackId, row.keyFrameMediaId)
    }

    // Step 4: join winners to ObjectEvents by trackId, in ONE indexed query.
    //
    // This used to loop over the winners' DEVICES, pulling up to 5,000 events
    // per device and filtering client-side, because a comment claimed the event
    // store had no trackId WHERE. It has: `trackId` is indexed
    // (`idx_object_track`) and `QueryFilter.whereIn` takes a set. Measured on
    // the live hub the old shape cost ~0.5s per additional result — a
    // 20-result search spent ~10s here alone.
    const scoreByTrackId = new Map<string, number>()
    for (const { row, score } of ranked) {
      scoreByTrackId.set(row.trackId, score)
    }

    const events = await (this.eventStore?.queryObjectByTrackIds([...scoreByTrackId.keys()]) ??
      Promise.resolve<readonly ObjectEvent[]>([]))

    // Deduplicate: keep the highest-confidence event per trackId (one
    // representative event per track; the CLIP score comes from the
    // embedding, not the event).
    const bestEventByTrackId = new Map<string, { event: ObjectEvent; score: number }>()
    for (const ev of events) {
      if (!ev.trackId) continue
      const score = scoreByTrackId.get(ev.trackId)
      if (score === undefined) continue
      const existing = bestEventByTrackId.get(ev.trackId)
      const newConf = ev.confidence ?? 0
      const prevConf = existing?.event.confidence ?? 0
      if (existing === undefined || newConf > prevConf) {
        bestEventByTrackId.set(ev.trackId, { event: ev, score })
      }
    }

    // A ranked winner whose events have already been pruned yields nothing.
    // Say so — silence here reads as "the search found less", when the truth is
    // "the embedding outlived its events".
    if (bestEventByTrackId.size < scoreByTrackId.size) {
      this.ctx.logger.warn('searchObjectEvents: ranked tracks without events', {
        meta: {
          ranked: scoreByTrackId.size,
          resolved: bestEventByTrackId.size,
        },
        ...(input.deviceId !== undefined ? { tags: { deviceId: input.deviceId } } : {}),
      })
    }

    const scored: ScoredObjectEvent[] = []
    for (const { event, score } of bestEventByTrackId.values()) {
      const embeddingMediaId =
        event.trackId !== undefined ? embeddingMediaIdByTrackId.get(event.trackId) : undefined
      const mediaUrl = resolveSearchThumbnailUrl({
        baseUrl: this.eventMediaBaseUrl,
        eventId: String(event.id),
        deviceId: event.deviceId,
        recordAt: event.timestamp,
        ...(embeddingMediaId !== undefined ? { embeddingMediaId } : {}),
      })
      const keyFrameMediaId =
        event.trackId !== undefined ? keyFrameMediaIdByTrackId.get(event.trackId) : undefined
      scored.push({
        ...event,
        score,
        ...(mediaUrl !== undefined ? { mediaUrl } : {}),
        ...(keyFrameMediaId !== undefined ? { keyFrameMediaId } : {}),
      })
    }

    // Sort descending by score, then trim to limit.
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, input.limit)
  }

  async pruneEventsBefore(input: {
    deviceId: number
    cutoffMs: number
  }): Promise<{ motion: number; object: number; audio: number }> {
    return this.queryFacade.pruneEventsBefore(input)
  }

  /**
   * The widened, extensible track-deletion cascade registry (design §3): every
   * leaf store that holds track-scoped rows, ORDERED leaves-first (the track
   * root is deleted internally, last, by `cascadeDeleteTracks`). eventStore
   * folds in its event-owned media; mediaStore removes track/face/plate crops
   * (never identity); faceStore removes unassigned (non-enrolled) reads;
   * objectEmbeddingStore removes the per-track CLIP vector. The plate leg is
   * deferred until the plate `assigned` enrollment model lands (design §11.3).
   * Returns null when the required stores aren't ready.
   */
  private buildTrackCascadeRegistry(): {
    registry: readonly TrackScopedStore[]
    trackStore: TrackStore
    /** The registry's media leg: never deletes a row a live stationary entry vouches for (M2). */
    mediaLeg: SparingMediaLeaf
    /**
     * D683 (review H2): the alias leg, surfaced on its own (like `mediaLeg`)
     * so a caller that must keep it LAST relative to some other re-ordering
     * (the stationary disposal's media-sparing swap) can do so without
     * reaching back into `this`.
     */
    aliasLeg: TrackLeafStore | null
    /**
     * D683 (review H2): widens a cascade's `trackIds` to also reach rows a
     * late fusion left under an absorbed id of one of them — a PROPERTY of
     * the registry, not something each caller re-derives, so no caller can
     * forget it (H3). Absent ⇒ no alias collection bound. For a SINGLE
     * track (or a small related set, e.g. one entity's own source tracks).
     */
    expandLeafIds?: (ids: readonly string[]) => Promise<readonly string[]>
    /**
     * D683 (review N6): the same widening, GROUPED by survivor, for
     * `runTrackCascadeBatch`'s batches of otherwise-UNRELATED tracks — one
     * query for the whole batch, but each track's cascade sees only its OWN
     * aliases, never a sibling's.
     */
    expandLeafIdsGrouped?: (
      ids: readonly string[],
    ) => Promise<ReadonlyMap<string, readonly string[]>>
  } | null {
    const trackStore = this.trackStore
    const leafStores = this.trackLeafStores()
    if (!trackStore || leafStores === null) return null
    const { stores, mediaLeg } = leafStores
    const absent = absentCascadeLegs(stores)
    if (absent.length > 0) {
      // Never silent. A cascade missing a leg still deletes the track ROOT, so
      // every row that leg owned becomes unreachable by ownership one statement
      // later — and the only previous evidence was a boot-time warn that had
      // scrolled away. Logged per registry build (once per sweep, not per
      // track), so a run of these is a rate, not a flood.
      this.ctx.logger.warn('track cascade is missing a leg — its rows will be left behind', {
        meta: {
          absent,
          why: 'an optional store was not bound at boot; the track root is still deleted, so these families can only be reclaimed by the orphan audit',
        },
      })
    }
    // The registry itself is assembled by `buildAnalyticsCascadeRegistry`, not
    // here, so the cascade-completeness test can exercise the SHIPPED order over
    // real stores instead of a copy of it that agrees with it today.
    const registry = buildAnalyticsCascadeRegistry(stores)
    const aliasLeg = this.trackAliasStore
    return {
      registry,
      trackStore,
      mediaLeg,
      aliasLeg,
      ...(aliasLeg
        ? {
            expandLeafIds: (ids: readonly string[]) => aliasLeg.aliasesOf(ids),
            expandLeafIdsGrouped: (ids: readonly string[]) => aliasLeg.aliasesOfGrouped(ids),
          }
        : {}),
    }
  }

  /**
   * The track-leaf stores, composed ONCE for both the cascade and the fusion
   * (D683 §6.1 invariant 4): the same stores, the same order. EVERY track
   * cascade — retention, discard, operator delete, the promotion disposal —
   * spares what a live stationary entry vouches for: a promoted track that
   * MOVED is kept and owns its entry's key frame (D683 round 4, review M2),
   * and an entry pointing at deleted bytes is D400 in reverse. `null` until
   * the required stores are bound.
   */
  private trackLeafStores(): TrackLeafStoreSet | null {
    const eventStore = this.eventStore
    const mediaStore = this.mediaStore
    if (!eventStore || !mediaStore) return null
    const mediaLeg = sparingEntryHeldMedia(mediaStore, () => this.stationaryHeldMediaIds())
    return {
      stores: {
        eventStore,
        mediaStore: mediaLeg,
        faceStore: this.faceStore,
        plateStore: this.plateStore,
        objectEmbeddingStore: this.objectEmbeddingStore,
        aliasStore: this.trackAliasStore,
      },
      mediaLeg,
    }
  }

  /**
   * The fusion leaves (D683 Task 18), built per fusion from the live stores —
   * the cascade's own registry seen as fusible. A leg that is not bound is
   * named on every fusion it misses; no leaves at all is a WARN.
   */
  private buildTrackFusionLeaves(): readonly TrackFusibleStore[] {
    const leafStores = this.trackLeafStores()
    if (leafStores === null) {
      this.ctx.logger.warn(
        'track fusion leaves not ready — the event or media store is not bound',
        {
          meta: { why: 'the fusion is merged in RAM; rows keyed by the absorbed id stay under it' },
        },
      )
      return []
    }
    const absent = absentCascadeLegs(leafStores.stores)
    if (absent.length > 0) {
      this.ctx.logger.warn('track fusion is missing a leg — its rows stay under the absorbed id', {
        meta: { absent },
      })
    }
    return buildAnalyticsFusionRegistry(leafStores.stores)
  }

  /**
   * Clear the addon-level per-track in-memory scheduler/overlay state that a
   * natural track-end (see `sweepExpiredTracks`) clears — otherwise a pruned
   * track keeps drawing overlay boxes and the dispatcher keeps scheduling detail
   * work until it ends on its own. Fired per successfully-cascaded track by all
   * three retention entry points (design §5). S1 leak fix: `close` now runs the
   * FULL per-track litany (was: only the closure-state entry — the best
   * trackers, keyFrame key, clocks, in-flight + pending flags and lifecycle
   * memory all leaked on prune).
   */
  private clearLiveTrackState(deviceId: number, trackId: string): void {
    this.detailDispatcher?.onTrackEnded(deviceId, trackId)
    this.overlayState.onTrackEnded(deviceId, trackId)
    this.residents.close(trackId, 'prune')
  }

  async deleteTracks(input: {
    deviceId: number
    trackIds: readonly string[]
  }): Promise<DeleteTracksResult> {
    const cascade = this.buildTrackCascadeRegistry()
    if (!cascade) return { deleted: 0, failed: [...input.trackIds], sparedMediaIds: [] }
    // Rows a live stationary entry vouches for survive the cascade (M2) —
    // named BEFORE it runs, so the operator is told which and why (R6).
    const mediaStore = this.mediaStore
    const sparedMediaIds =
      mediaStore === null
        ? []
        : await entryHeldMediaOf(input.trackIds, this.stationaryHeldMediaIds(), (id) =>
            mediaStore.ownerOf(id),
          )
    const { deleted, failed } = await runTrackCascadeBatch(
      {
        registry: cascade.registry,
        trackStore: cascade.trackStore,
        deviceId: input.deviceId,
        onTrackCleanup: (deviceId, trackId) => this.clearLiveTrackState(deviceId, trackId),
        // D683 (review H4/N6): reach rows a late fusion left under an
        // absorbed id, not only the surviving ids the operator named —
        // grouped per track so one named id's widening never reaches a
        // sibling's rows.
        ...(cascade.expandLeafIdsGrouped !== undefined
          ? { expandLeafIdsGrouped: cascade.expandLeafIdsGrouped }
          : {}),
        onExpandBatchFailure: (failedIds, err) =>
          this.logExpandBatchFailure(input.deviceId, failedIds, err),
        onFailure: (trackId, err) => {
          this.ctx.logger.debug('deleteTracks failed', {
            meta: { trackId, error: String(err) },
          })
        },
      },
      input.trackIds,
    )
    if (deleted > 0 || sparedMediaIds.length > 0) {
      this.ctx.logger.info('analytics tracks deleted', {
        tags: { deviceId: input.deviceId },
        meta: {
          deviceId: input.deviceId,
          deleted,
          failed: failed.length,
          // Left in place: a live stationary entry's key frame (D683 R6).
          sparedMediaIds,
        },
      })
    }
    return { deleted, failed, sparedMediaIds }
  }

  /**
   * Set the per-track operator flags (`markForTrain`, `debug`). Partial patch —
   * see `applyTrackFlags`. `markForTrain` moves the retrain LIFECYCLE
   * (`none ↔ staging`, D81), and `staging` is what PINS the track against the
   * retention sweep — which is why the body enforces a per-device staging budget
   * and refuses any move on an already-`trained` track. `debug` is attention
   * only. This is the write surface the three UI toggles share.
   */
  async setTrackFlags(input: {
    deviceId: number
    trackId: string
    flags: TrackFlagsPatch
  }): Promise<TrackFlags> {
    const trackStore = this.trackStore
    if (!trackStore) throw new Error('setTrackFlags: track store unavailable')
    const out = await applyTrackFlags(
      {
        store: {
          readFlags: (trackId) => trackStore.readFlags(trackId),
          setFlags: (trackId, patch) => trackStore.setFlags(trackId, patch),
          countStaging: (query) => trackStore.countStaging(query),
        },
        logger: this.ctx.logger,
        ...(this.debugNoteArchive !== null ? { noteArchive: this.debugNoteArchive } : {}),
      },
      input,
    )
    // Push the resolved flag into the LIVE track, once, here — the only place
    // it can change. The frame path then reads it as a map lookup and never
    // asks the store, which is what keeps a fleet with no marked track free.
    // `out.debug` (not `input.flags.debug`): the mutation is the authority on
    // what the flag ENDED as, and a patch that omitted it must not clear it.
    this.residents.setDebugMarked(input.deviceId, input.trackId, out.debug)
    this.ctx.logger.info('track operator flags set', {
      tags: { deviceId: input.deviceId },
      meta: {
        deviceId: input.deviceId,
        trackId: input.trackId,
        markForTrain: out.markForTrain,
        retrainStatus: out.retrainStatus,
        debug: out.debug,
      },
    })
    return out
  }

  /** The ground-truth body's deps (D681) — hub only, like the flags body. */
  private trackRelationsDeps(): TrackRelationsDeps {
    const store = this.trackRelations
    const trackStore = this.trackStore
    if (store === null || trackStore === null) throw new Error('track relations: store unavailable')
    const fromTrack = (t: TrackFactsLike | null | undefined): TrackFacts | null =>
      t === null || t === undefined
        ? null
        : { trackId: t.trackId, deviceId: t.deviceId, firstSeen: t.firstSeen, lastSeen: t.lastSeen }
    return {
      store,
      resolveTrack: (trackId) =>
        firstTrackFacts(trackId, [
          async (id) => fromTrack(trackStore.getActiveByTrack(id)),
          async (id) => fromTrack(await trackStore.getPersistedByTrackId(id)),
          (id) => this.tapeTrackFacts(id),
        ]),
      markDebug: async (deviceId, trackId) => {
        try {
          await this.setTrackFlags({ deviceId, trackId, flags: { debug: true } })
        } catch (err) {
          // A track only a promoted tape still knows has no row to flag.
          this.ctx.logger.info('ground-truth mark on a track without a row — debug flag skipped', {
            tags: { deviceId },
            meta: { trackId, reason: err instanceof Error ? err.message : String(err) },
          })
        }
      },
      now: () => Date.now(),
      author: null,
    }
  }

  /** A track only a promoted tape still knows (spec §4.4). */
  private async tapeTrackFacts(trackId: string): Promise<TrackFacts | null> {
    const index = this.tapeIndex
    const shelf = this.tapeShelf
    if (index === null || shelf === null) return null
    for (const row of await index.list()) {
      if (!row.trackIds.includes(trackId)) continue
      try {
        const tape = await readTapeFile(shelf.promotedFile(row.deviceId, row.id), {
          logger: this.ctx.logger,
          deviceId: row.deviceId,
        })
        return tapeTrackFacts(tape, row.fromMs, row.deviceId, trackId)
      } catch (err) {
        this.ctx.logger.warn('promoted tape unreadable while resolving a track', {
          tags: { deviceId: row.deviceId },
          meta: {
            tapeId: row.id,
            trackId,
            error: err instanceof Error ? err.message : String(err),
          },
        })
      }
    }
    return null
  }

  /**
   * Tracking-bench ground truth (D681): "this track and that one are the same
   * subject" / "different subjects". One row per unordered pair — re-marking
   * replaces it — and a mark that contradicts an existing chain is REFUSED
   * with the chain named. Writing a mark also sets `debug` on both tracks.
   */
  async setTrackRelation(input: SetTrackRelationInput): Promise<TrackRelation> {
    return setTrackRelation(this.trackRelationsDeps(), input)
  }

  /** Remove the mark between two tracks. */
  async clearTrackRelation(input: ClearTrackRelationInput): Promise<ClearTrackRelationResult> {
    return clearTrackRelation(this.trackRelationsDeps(), input)
  }

  /**
   * A track that is not ONE subject: `mixed` (two subjects, optionally
   * switching at `switchAtMs`) or `not-a-subject`. `pure` clears the mark and
   * answers `{ purity: null }` (D681).
   */
  async setTrackPurity(input: SetTrackPurityInput): Promise<SetTrackPurityResult> {
    return setTrackPurity(this.trackRelationsDeps(), input)
  }

  /** A camera's marks, optionally one track's, windowed by track start. */
  async listTrackRelations(input: ListTrackRelationsInput): Promise<ListTrackRelationsResult> {
    return listTrackRelations(this.trackRelationsDeps(), input)
  }

  /**
   * One camera's long-term series — the history surface that replaces the RAM
   * rings. Bounds are inclusive on the BUCKET START, so a range ending
   * mid-bucket still returns the bucket it lands in; the alternative is a chart
   * whose newest column vanishes for five minutes out of every five.
   *
   * An absent store answers with NOTHING, not with an empty series: the addon
   * is still booting, and "no history" is a different claim from "not ready".
   * The caller distinguishes them by asking again.
   */
  async readLongTermSeries(input: {
    deviceId: number
    series: AnalyticsLtsSeries
    scope?: string
    from: number
    to: number
    limit?: number
  }): Promise<readonly LtsBucket[]> {
    const lts = this.lts
    if (!lts) throw new Error('pipeline-analytics: the long-term store is not ready yet')
    return lts.readLongTermBuckets(input)
  }

  // ── Events management (footprint + prune + ops-log) — bodies in S8 facade ──

  async getEventStoreFootprint(): Promise<EventStoreFootprint> {
    return this.queryFacade.getEventStoreFootprint()
  }

  async getEventMediaFootprintByKind(input: {
    deviceId?: number
  }): Promise<EventMediaKindBreakdown> {
    return this.queryFacade.getEventMediaFootprintByKind(input)
  }

  async pruneEvents(input: {
    olderThanMs: number
    reason?: OpsLogReason
  }): Promise<EventPruneCounts> {
    return this.queryFacade.pruneEvents(input)
  }

  async deleteDeviceEvents(input: {
    deviceId: number
    reason?: OpsLogReason
  }): Promise<EventPruneCounts> {
    return this.queryFacade.deleteDeviceEvents(input)
  }

  /** The events ops-log rows (newest-first), optionally scoped to one camera. */
  async pauseForStorageMigration(input: { leaseId: string }): Promise<{ paused: true }> {
    if (this.storageMigrationLeaseId !== null && this.storageMigrationLeaseId !== input.leaseId) {
      throw new Error('event-media writes are already paused by another storage migration')
    }
    this.storageMigrationLeaseId = input.leaseId
    try {
      await this.mediaWriteGate.pause()
      return { paused: true }
    } catch (err) {
      this.storageMigrationLeaseId = null
      throw err
    }
  }

  async resumeForStorageMigration(input: { leaseId: string }): Promise<{ resumed: true }> {
    if (this.storageMigrationLeaseId === null) return { resumed: true }
    if (this.storageMigrationLeaseId !== input.leaseId) {
      throw new Error('event-media storage migration lease does not match')
    }
    this.mediaWriteGate.resume()
    this.storageMigrationLeaseId = null
    return { resumed: true }
  }

  async refreshStorageLocationsForMigration(input: {
    leaseId: string
  }): Promise<{ refreshed: true }> {
    if (this.storageMigrationLeaseId !== input.leaseId) {
      throw new Error('event-media storage migration lease does not match')
    }
    this.mediaLocationStorage?.invalidateRoots()
    this.eventMediaWriteLocator?.invalidate()
    return { refreshed: true }
  }

  /**
   * The absolute root the NC artifact shelf lives under: the ONE
   * `artifacts` location, resolved through the storage cap. The class
   * is a declared SINGLETON, so there is no writable-location picker here —
   * no drain-aware choice exists for a plurality of one. Never a path under
   * `ctx.dataDir` and never a hardcoded mount — the root differs per node and
   * per deployment shape (Unraid template, docker-compose, Electron). A
   * resolve failure propagates: the caller refuses the plane rather than
   * inventing a root (D341).
   */
  private async resolveNcArtifactRoot(): Promise<string> {
    return this.ctx.api.storage.resolve.query({
      location: ARTIFACTS_MEDIA_LOCATION,
      relativePath: '',
    })
  }

  /**
   * Start the tracking-tape shelf and recorder (D681). Same locality rule as
   * the notification shelf: only the node whose disk the `artifacts` location
   * names writes to it, and only the post-processing node sees frames — and
   * that node must be the HUB: an agent persists nothing (spec §3.1).
   *
   * Never throws — it is its own boot `step` (fix round, L1), after the frame
   * subscriptions, so a failed start cannot take another plane down with it
   * and a processor built while it awaits its storage reads is seeded into
   * the next header.
   */
  private async startTrackingTapes(isPostProcessingNode: boolean): Promise<void> {
    const rawNodeId = this.ctx.kernel.localNodeId ?? this.ctx.id
    const nodeId = rawNodeId.includes('/') ? (rawNodeId.split('/')[0] ?? '') : rawNodeId
    const nodeRefusal = tapeNodeRefusal({ nodeId, isPostProcessingNode })
    if (nodeRefusal !== null) {
      this.tapeRefusal = nodeRefusal
      this.ctx.logger.info('tracking tapes not recorded on this node', {
        meta: { reason: nodeRefusal, nodeId, isPostProcessingNode },
      })
      return
    }
    try {
      const refusal = artifactShelfRefusal(
        await this.ctx.api.storage.listLocations.query({}),
        this.ctx.kernel.localNodeId ?? null,
      )
      if (refusal !== null) {
        this.tapeRefusal = 'artifacts-elsewhere'
        this.ctx.logger.info('tracking tapes not recorded on this node', {
          meta: { reason: refusal },
        })
        return
      }
      const logger = this.ctx.logger.child('tracking-tapes')
      const shelf = new TapeShelf({ rootDir: await this.resolveNcArtifactRoot(), logger })
      const sweep = (deviceId: number | null): void => {
        // Consume the report: rootUnreadable / per-camera `failed` never
        // reject the promise, so a bare `.catch` would drop them (D391).
        shelf
          .sweep()
          .then((report) => {
            logTapeSweepReport(report, logger)
          })
          .catch((err: unknown) => {
            logger.warn('tracking tape sweep failed', {
              ...(deviceId !== null ? { tags: { deviceId } } : {}),
              meta: { error: errMsg(err) },
            })
          })
      }
      this.tapeShelf = shelf
      this.tapeRecorder = new TapeRecorder({
        segmentFile: (deviceId, originMs) => shelf.segmentFile(deviceId, originMs),
        openSink: openGzipFileSink,
        lighting: async (deviceId, atMs) =>
          lightingFromCondition(
            resolveCondition({
              ...(await this.sceneConditionContext(deviceId)),
              now: new Date(atMs),
            }),
          ),
        stationaryEntries: (deviceId) => this.stationaryRegistry?.list(deviceId) ?? [],
        faces: hubFacePseudonymizer(randomBytes(32)),
        // One session per recorder start — per boot — beside the face key it
        // scopes: a promotion reads a session change as a `restart` gap (H1).
        session: randomBytes(8).toString('hex'),
        logger,
        mintTapeId: () => randomUUID(),
        onSegmentClosed: (deviceId) => sweep(deviceId),
        now: () => Date.now(),
      })
      // Processors built before the recorder existed must still reach the next
      // segment's header, or a replay of it would build no processor at all.
      for (const [key, inputs] of this.frameState.processorInputs) {
        const [deviceIdText, plane] = key.split(':')
        const deviceId = Number(deviceIdText)
        const parsed = TapePlaneSchema.safeParse(plane)
        if (Number.isInteger(deviceId) && parsed.success) {
          this.tapeRecorder.noteProcessor(deviceId, parsed.data, inputs)
        }
      }
      sweep(null)
      this.tapeSweepTimer = setInterval(() => sweep(null), TAPE_SWEEP_INTERVAL_MS)
      this.tapeSweepTimer.unref?.()
      this.tapeFlushTimer = setInterval(() => {
        void this.tapeRecorder?.flushOpenSegments()
      }, TAPE_FLUSH_INTERVAL_MS)
      this.tapeFlushTimer.unref?.()
      this.ctx.logger.info('tracking tapes ready', {
        meta: { seededProcessors: this.frameState.processorInputs.size },
      })
    } catch (err: unknown) {
      this.tapeStartFailure = errMsg(err)
      this.ctx.logger.warn('tracking tapes could not start', {
        meta: { error: this.tapeStartFailure },
      })
    }
  }

  /**
   * Hand one observed frame to the tape recorder. Observational only: every
   * value is built from what `process` already consumed, and a throw is
   * logged here, never let into `processFrame` (D681).
   */
  private recordTapeFrame(input: TapeFrameWiring): void {
    try {
      this.tapeRecorder?.onFrame({
        deviceId: input.deviceId,
        plane: input.source,
        frame: input.trackerFrame,
        injectedIds: new Set(
          input.trackerFrame.detections.slice(input.frame.detections.length).map((d) => d.id),
        ),
        observation: input.observation,
        scene: tapeSceneOf(
          input.liveZones,
          input.liveRules,
          input.zoneMembershipMinOverlap,
          input.lowScoreFloor,
        ),
      })
    } catch (err: unknown) {
      this.ctx.logger.warn('tracking tape frame not recorded', {
        tags: { deviceId: input.deviceId },
        meta: { source: input.source, error: errMsg(err) },
      })
    }
  }

  /**
   * What this node's shelf holds for one camera, or why that is unknown. A
   * refusing node holds nothing BY CONSTRUCTION (it never writes) — a measured
   * empty. A node allowed to record but with no shelf could not look: that is
   * not an empty shelf, and never reads as 0 bytes (M3, D393).
   */
  private async tapeListingOf(
    shelf: TapeShelf | null,
    deviceId: number,
  ): Promise<TapeSegmentListing> {
    if (shelf === null) {
      return this.tapeRefusal !== null
        ? { ok: true, segments: [], unstatted: [] }
        : { ok: false, reason: 'tracking tapes not started' }
    }
    try {
      return await shelf.readSegments(deviceId)
    } catch (err: unknown) {
      return { ok: false, reason: errMsg(err) }
    }
  }

  private tapeOps(): TapeOperationQueue {
    if (this.tapeOpsQueue !== null) return this.tapeOpsQueue
    const queue = new TapeOperationQueue({
      logger: this.ctx.logger.child('tracking-tapes'),
      // An op abandoned at its deadline may still land a write after the
      // next op ran; the reconcile re-applies every row's pins (N1).
      afterAbandoned: async (signal) => {
        const deps = this.tapePinDeps()
        if (typeof deps !== 'string') await reconcileTapePins(deps, signal)
      },
    })
    this.tapeOpsQueue = queue
    return queue
  }

  /** What the tape-operation deps are built from (tape-operations.ts). */
  private tapeDepsSources(): TapeDepsSources {
    return {
      index: this.tapeIndex,
      trackStore: this.trackStore,
      shelf: this.tapeShelf,
      shelfAbsence: () => this.tapeShelfAbsence(),
      removeFile: async (file) => {
        await fs.rm(file, { force: true })
      },
      logger: this.ctx.logger.child('tracking-tapes'),
      now: () => Date.now(),
    }
  }

  /** Release/reconcile deps: the index and the pins only (M2). */
  private tapePinDeps(): TapePinDeps | string {
    return buildTapePinDeps(this.tapeDepsSources())
  }

  /** Why the shelf is not here: this node's refusal, or a recorder that has
   *  not started — never borrowed from one another (spec §3.1). */
  private tapeShelfAbsence(): string {
    if (this.tapeRefusal !== null) return this.tapeRefusal
    return this.tapeStartFailure === null
      ? 'tapes-not-started'
      : `tapes-not-started (${this.tapeStartFailure})`
  }

  /** Why promotion deps cannot be built: the pins' reason, else the shelf's. */
  private tapeUnavailableReason(): string {
    const deps = buildTapeDeleteDeps(this.tapeDepsSources())
    return typeof deps === 'string' ? deps : this.tapeShelfAbsence()
  }

  /** Promotion deps, or null when this node records no tapes. */
  private tapePromotionDeps(): TapePromotionDeps | null {
    const base = buildTapeDeleteDeps(this.tapeDepsSources())
    const shelf = this.tapeShelf
    const index = this.tapeIndex
    if (typeof base === 'string' || shelf === null || index === null) return null
    return {
      ...base,
      index,
      readSegments: (deviceId) => shelf.readSegments(deviceId),
      rotate: async (deviceId, toMs) => {
        await this.tapeRecorder?.rotateCovering(deviceId, toMs)
      },
      readTape: (file, deviceId) => readTapeFile(file, { logger: this.ctx.logger, deviceId }),
      writeFile: async (file, bytes) => {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, bytes)
      },
      mintTapeId: () => randomUUID(),
      currentSession: () => this.tapeRecorder?.sessionId() ?? null,
    }
  }

  /**
   * Re-apply every promotion's pins and finish any left owed by a crash or a
   * failed write (tape-pin-ledger.ts). Runs once at hub start, recorder or
   * not; every later tape operation reconciles first on its own. Never throws.
   */
  private reconcileTapePinsInBackground(): void {
    reconcileOrUnavailable(this.tapePinDeps(), this.tapeOps())
      .then((report) => {
        if ('status' in report) {
          this.ctx.logger.warn('tracking tape pin reconcile skipped at start', {
            meta: { reason: report.reason },
          })
          return
        }
        if (report.settled === 0 && report.unsettled === 0) return
        this.ctx.logger.info('tracking tape pins reconciled at start', {
          meta: { settled: report.settled, unsettled: report.unsettled },
        })
      })
      .catch((err: unknown) => {
        this.ctx.logger.warn('tracking tape pin reconcile failed at start', {
          meta: { error: errMsg(err) },
        })
      })
  }

  /** `debug.tape.list` rows, each with how many of its tracks are still held. */
  private async listPromotedTapes(input: DebugTapeListInput): Promise<DebugTapeListOutput> {
    const rows = (await this.tapeIndex?.list(input.deviceId)) ?? []
    const tapes: DebugTapeListItem[] = []
    for (const r of rows) {
      const stored = (await this.trackStore?.existingTrackIds(r.trackIds)) ?? new Set<string>()
      tapes.push({
        id: r.id,
        deviceId: r.deviceId,
        scenario: r.scenario,
        note: r.note,
        lighting: r.lighting,
        fromMs: r.fromMs,
        toMs: r.toMs,
        state: r.state,
        frames: r.frames,
        skips: r.skips,
        gaps: r.gaps,
        bytes: r.bytes,
        reviewed: r.reviewed,
        released: r.releasedAt !== null,
        tracks: r.trackIds,
        tracksStillStored: stored.size,
      })
    }
    return { tapes }
  }

  /** `debug.tape.*` handlers (D681). Hub-only like `debug.*`. */
  private buildTapeActionHandlers(): Record<string, (input: never) => Promise<unknown>> {
    return {
      'debug.tape.status': async (input: DebugTapeStatusInput): Promise<DebugTapeStatusOutput> => {
        const known = new Set<number>()
        for (const key of this.frameState.processors.keys()) known.add(Number(key.split(':')[0]))
        const deviceIds = [...(input.deviceIds ?? []), ...known]
          .filter((id, i, all) => Number.isInteger(id) && all.indexOf(id) === i)
          .toSorted((a, b) => a - b)
        const switchOn = new Map<number, boolean>()
        const switchUnreadable = new Map<number, string>()
        const segments = new Map<number, TapeSegmentListing>()
        const shelf = this.tapeShelf
        for (const deviceId of deviceIds) {
          // One camera's failed read answers `unknown` for THAT camera (L4).
          try {
            switchOn.set(
              deviceId,
              (await this.resolveDeviceTrackingSettings(deviceId)).trackingTape,
            )
          } catch (err: unknown) {
            switchUnreadable.set(deviceId, errMsg(err))
            this.ctx.logger.warn('tracking tape switch could not be read', {
              tags: { deviceId },
              meta: { error: errMsg(err) },
            })
          }
          segments.set(deviceId, await this.tapeListingOf(shelf, deviceId))
        }
        const recorder = this.tapeRecorder
        const cameras = describeTapeStatus({
          deviceIds,
          switchOn,
          switchUnreadable,
          recorder: (deviceId) => recorder?.status(deviceId) ?? null,
          refusal: this.tapeRefusal,
          startFailure: this.tapeStartFailure,
          segments,
          now: Date.now(),
        })
        return {
          cameras: input.deviceIds === undefined ? defaultTapeStatusCameras(cameras) : cameras,
        }
      },
      'debug.tape.promote': async (
        input: DebugTapePromoteInput,
      ): Promise<DebugTapePromoteOutput> => {
        const deps = this.tapePromotionDeps()
        if (deps === null) {
          // A refusing node names its own reason; a node allowed to record
          // whose recorder is not up must not borrow one (spec §3.1).
          if (this.tapeRefusal !== null) {
            return {
              ok: false,
              reason: this.tapeRefusal,
              detail: `tracking tapes are not recorded on this node (${this.tapeRefusal})`,
            }
          }
          return {
            ok: false,
            reason: 'tapes-not-started',
            detail: `tracking tapes cannot promote on this node: ${this.tapeUnavailableReason()}`,
          }
        }
        return this.tapeOps().run((signal) => promoteTapeWindow(deps, input, signal), {
          name: 'promote',
          deviceId: input.deviceId,
        })
      },
      'debug.tape.list': (input: DebugTapeListInput): Promise<DebugTapeListOutput> =>
        this.listPromotedTapes(input),
      'debug.tape.review': (input: DebugTapeReviewInput): Promise<DebugTapeReviewOutput> => {
        const index = this.tapeIndex
        if (index === null) return Promise.resolve({ status: 'not-found' })
        return reviewOrNotFound(index, input.tapeId, input.reviewed)
      },
      'debug.tape.release': (input: DebugTapeIdInput): Promise<DebugTapeReleaseOutput> =>
        releaseOrUnavailable(this.tapePinDeps(), input.tapeId, this.tapeOps()),
      'debug.tape.delete': (input: DebugTapeIdInput): Promise<DebugTapeDeleteOutput> =>
        deleteOrUnavailable(
          buildTapeDeleteDeps(this.tapeDepsSources()),
          input.tapeId,
          this.tapeOps(),
        ),
      'debug.tape.tracks': async (input: DebugTapeIdInput): Promise<DebugTapeTracksOutput> => {
        const row = await this.tapeIndex?.get(input.tapeId)
        const shelf = this.tapeShelf
        if (row === null || row === undefined || shelf === null)
          throw new Error(`unknown tape ${input.tapeId}`)
        const tape = await readTapeFile(shelf.promotedFile(row.deviceId, row.id), {
          logger: this.ctx.logger,
          deviceId: row.deviceId,
        })
        const lanes = tapeLanes(tape)
        const stored =
          (await this.trackStore?.existingTrackIds(lanes.map((l) => l.trackId))) ??
          new Set<string>()
        return {
          tapeId: row.id,
          deviceId: row.deviceId,
          fromMs: row.fromMs,
          toMs: row.toMs,
          reviewed: row.reviewed,
          lanes: lanes.map((l) => ({ ...l, stillStored: stored.has(l.trackId) })),
        }
      },
    }
  }

  /** `debug.gt.*` handlers (D681) — same body/store as the four cap methods. */
  private buildGtActionHandlers(): Record<string, (input: never) => Promise<unknown>> {
    return {
      'debug.gt.setRelation': async (input: SetTrackRelationInput) =>
        setTrackRelation(this.trackRelationsDeps(), input),
      'debug.gt.clearRelation': async (input: ClearTrackRelationInput) =>
        clearTrackRelation(this.trackRelationsDeps(), input),
      'debug.gt.setPurity': async (input: SetTrackPurityInput) =>
        setTrackPurity(this.trackRelationsDeps(), input),
      'debug.gt.list': async (input: ListTrackRelationsInput) =>
        listTrackRelations(this.trackRelationsDeps(), input),
    }
  }

  async startStorageMigrationMove(
    input: StorageMigrationMediaMoveInput,
  ): Promise<{ jobId: string }> {
    if (!this.mediaRelocate) throw new Error('media relocation unavailable')
    if (this.storageMigrationLeaseId !== input.leaseId) {
      throw new Error('event-media storage migration lease does not match')
    }
    return { jobId: await this.startMediaMover(input) }
  }

  /**
   * Start a media move only while no single-location repoint holds an overlapping
   * physical root (the storage orchestrator owns that claim). A shared recordings
   * root is the case: a repoint of another class there must not run beside us.
   */
  private startMediaMover(input: RelocateMediaInput): Promise<string> {
    const engine = this.mediaRelocate
    if (!engine) throw new Error('media relocation unavailable')
    return startMoverUnderClearance({
      clearance: (locationIds) =>
        this.ctx.api.storageMigration.moverClearance.query({ locationIds }),
      start: () => engine.start(input),
      cancel: (jobId) => {
        engine.cancel(jobId)
      },
      locationIds: [input.fromLocationId ?? '*', input.toLocationId],
    })
  }

  async getStorageMigrationMoveStatus(input: { jobId: string }): Promise<RelocateJob | null> {
    return this.mediaRelocate?.list().find((job) => job.jobId === input.jobId) ?? null
  }

  async cancelStorageMigrationMove(input: { jobId: string }): Promise<{ cancelled: boolean }> {
    return { cancelled: this.mediaRelocate?.cancel(input.jobId) ?? false }
  }

  /**
   * Move event media between locations — the OPERATOR's mover, no lease.
   * Twin of `recording.relocateFootage`: same engine (`this.mediaRelocate`)
   * the lease-gated coordinator move uses, runnable in the background
   * without pausing anything. `startStorageMigrationMove` above stays
   * lease-gated for the orchestrated migration; this method must never touch
   * `storageMigrationLeaseId`.
   */
  async relocateMedia(input: RelocateMediaInput): Promise<{ jobId: string }> {
    if (!this.mediaRelocate) throw new Error('media relocation unavailable')
    const jobId = await this.startMediaMover(input)
    this.ctx.logger.info('pipeline-analytics: media relocate job enqueued', {
      meta: { jobId, mode: input.mode ?? 'move', to: input.toLocationId },
    })
    return { jobId }
  }

  /**
   * How many media / retrain rows still carry no `locationId`.
   *
   * Counted against the rows, never inferred from a seal job's terminal state:
   * the migration planner refuses a non-blocking `eventMedia` cutover on this
   * number, and a seal that failed some rows still finishes.
   */
  async countUnstampedEventMedia(): Promise<UnstampedEventMediaCount> {
    if (!this.mediaRelocate) throw new Error('media relocation unavailable')
    return this.mediaRelocate.countUnstamped()
  }

  /**
   * How many rows a pass would still act on against `toLocationId`.
   *
   * The media lane's denominator AND its residue, from the one predicate the
   * pass itself uses. `null` means the count could not be taken — never `0`,
   * which would read as "there is nothing left to move".
   */
  async countRelocatableMedia(input: RelocatableMediaCountInput): Promise<RelocatableMediaCount> {
    if (!this.mediaRelocate) throw new Error('media relocation unavailable')
    return this.mediaRelocate.countSelectable(input)
  }

  /** Every relocate job this addon knows about, newest first (in RAM: the
   *  move is resumable, so a lost list costs nothing but the display). */
  async listRelocateMediaJobs(): Promise<readonly RelocateJob[]> {
    return this.mediaRelocate?.list() ?? []
  }

  /** Cancel a running or queued relocate job. */
  async cancelRelocateMedia(input: { jobId: string }): Promise<{ cancelled: boolean }> {
    return { cancelled: this.mediaRelocate?.cancel(input.jobId) ?? false }
  }

  async listOpsLog(input: { deviceId?: number; limit?: number }): Promise<readonly OpsLogEntry[]> {
    return this.queryFacade.listOpsLog(input)
  }

  /**
   * The archived debug notes, newest first (D405).
   *
   * Answers from the archive alone — never from the track rows. The point of
   * the table is that the tracks these notes were written on are gone, so a
   * read that joined them would return exactly the rows the archive exists to
   * replace. An archive that has not been built yet answers EMPTY, which is
   * true: nothing has been archived on this runner.
   */
  async listArchivedDebugNotes(input: {
    deviceId?: number
    limit?: number
  }): Promise<readonly ArchivedDebugNote[]> {
    return (await this.debugNoteArchive?.list(input)) ?? []
  }

  /**
   * The birth-decision ledger, newest first (D409).
   *
   * A READ of a measurement table and nothing else — no join back to the
   * tracks, deliberately: a SUPPRESSED birth never had a track row and a
   * confirmed one is expected to have aged out, so a join would return exactly
   * the rows the ledger exists to preserve. A runner with no ledger answers
   * EMPTY, which is true: nothing has been measured here.
   */
  async listBirthDecisions(
    input: BirthDecisionQueryInput,
  ): Promise<readonly BirthDecisionRecord[]> {
    return (await this.birthDecisionLedger?.list(input)) ?? []
  }

  /**
   * Track-centric time-based retention (design §5.1) — `retention/track-prune-runner.ts`.
   */
  async pruneTracksBefore(input: {
    deviceId: number
    cutoffMs: number
  }): Promise<TrackCascadeCounts> {
    return this.trackPrune.pruneTracksBefore(input)
  }

  /** Operator "clean slate" for a device (design §5.3) — `retention/track-prune-runner.ts`. */
  async wipeAllAnalytics(input: { deviceId: number }): Promise<TrackCascadeCounts> {
    return this.trackPrune.wipeAllAnalytics(input)
  }

  /** Disk-wins reconcile — `retention/track-prune-runner.ts`. */
  async reconcileFromDisk(input: { deviceId: number }): Promise<{
    mediaDropped: number
    tracks: number
    events: number
  }> {
    return this.trackPrune.reconcileFromDisk(input)
  }

  // ── Data-plane helpers ────────────────────────────────────────────────

  /**
   * Decode a stored event image into `EventMedia` for the data-plane handler.
   * Preference order: `crop` (square-safe 16:9 preview) → `fullFrameBoxed`
   * (native-res boxed frame) → any available file. Returns `null` if the
   * event has no media at all.
   */
  /**
   * Data-plane resolver — two addresses, two different questions (D482).
   *
   * `row` is an ADDRESS: media row `<mediaId>`, served verbatim. Nothing is
   * guessed and nothing is probed, which is the whole reason the surrogate id
   * exists — the old bare-id form could not tell a media row from an event,
   * and could not tell one of three event tables from another.
   *
   * `owner` is a QUESTION: "the best media of this owner", the ladder the list
   * and reel surfaces need because they hold no media row at all. It NAMES its
   * owner table, so the motion/object coin-flip is gone from here too.
   */
  private async readMediaByAddress(
    address: MediaAddress,
    variant?: EventMediaVariant,
    preferKind?: string,
  ): Promise<EventMedia | null> {
    const base =
      address.kind === 'row'
        ? await this.readMediaById(address.mediaId)
        : await this.readOwnerThumbnail(
            address.ownerType,
            address.ownerId,
            preferKind,
            address.generation,
          )
    if (base === null || variant === undefined) return base
    return this.applyThumbVariant(base, variant)
  }

  private async readMediaById(mediaId: number): Promise<EventMedia | null> {
    const file = await (this.mediaStore?.getBytesById(mediaId) ?? Promise.resolve(null))
    if (!file) return null
    return {
      bytes: file.bytes,
      mediaId: file.mediaId,
      kind: file.kind,
      deviceId: file.deviceId,
    }
  }

  /**
   * Render a small center-cropped square from a resolved event media blob for
   * the reel / list surfaces. The returned `key` is variant-distinct so the
   * data-plane ETag never collides with the full-size blob's. On any encode
   * failure the full blob is served (a thumb must never 500 / blank a tile).
   */
  private async applyThumbVariant(
    media: EventMedia,
    variant: EventMediaVariant,
  ): Promise<EventMedia> {
    // `thumbnailSmall` is the ready-to-serve Events variant generated from the
    // native crop (or derived from the keyframe at track close). Its central
    // square contains the subject, so CSS `object-fit: cover` may crop it
    // without another Sharp encode. Byte size must not turn a pre-generated
    // variant back into request-time work.
    //
    // The test used to be `media.key.includes(':thumbnailSmall')` — the row's
    // KIND read out of its composite key. A surrogate id spells nothing
    // (D482), so `EventMedia` carries the kind as a field. Without that the
    // short-circuit would silently stop firing and every pre-generated reel
    // tile would take a Sharp encode per request.
    if (media.kind === 'thumbnailSmall') return media
    try {
      const bytes = await makeSquareThumb(media.bytes, variant.size)
      return { ...media, bytes, variant }
    } catch (err: unknown) {
      this.ctx.logger.debug('event media: thumb variant failed — serving full', {
        meta: { mediaId: media.mediaId, size: variant.size, error: errMsg(err) },
      })
      return media
    }
  }

  /**
   * Resolve an OWNER to ONE tile's bytes — the `/o/<ownerType>/<ownerId>`
   * ladder.
   *
   * `ownerType` is a PARAMETER now, and that is the correction (D482). This
   * method used to take a bare id and probe `EVENT_OWNER_TYPES` in order,
   * stopping at the first table that owned anything. On the live hub that
   * probe was a coin flip with a known answer: 299 883 of 300 559 event-owned
   * media rows are `motion`, so every object event resolved to its motion
   * namesake and served that camera's snapshot from a different night.
   *
   * Every ladder below ranks rows by `kind` alone, so this walks the INDEX
   * (`listInfoByOwner`, no blob opened) and opens only the winner. It used to
   * walk `listByOwner`, which reads and base64-encodes every blob an owner
   * holds before the first comparison is made: measured on the live hub
   * 2026-08-30, a track's six kinds are 3 597 219 bytes and the tile serves
   * `thumbnailSmall` — 31 155 of them. An Events page of forty tiles read
   * ~144 MB and allocated ~190 MB of base64 to deliver ~1.2 MB, all of it on
   * the single-threaded post-analysis runner.
   */
  private async readOwnerThumbnail(
    ownerType: MediaOwnerType,
    rawOwnerId: string,
    preferKind?: string,
    /**
     * Generation carried on the plane address (D694). When set, media is
     * filtered to that camera + timestamp and the live-row lookup is skipped —
     * the URL already named which holder it wants. When absent, bare
     * `/o/<eventType>/<id>` still means "current holder of this id".
     */
    addressGeneration?: { readonly deviceId: number; readonly recordAt: number },
  ): Promise<EventMedia | null> {
    // D683: an `/o/track/<id>` request may name an absorbed provisional id —
    // resolve it to its survivor before any lookup below. The only other
    // owner kind a fusion ever touches is `track` itself (`resolveMediaOwnerId`
    // also covers the OTHER in-process media read, the NC dispatcher's
    // `getMediaForOwner`, with the same helper).
    const ownerId =
      ownerType === 'track'
        ? await resolveMediaOwnerId(
            ownerType,
            rawOwnerId,
            (id) => this.trackAliasStore?.resolve(id) ?? Promise.resolve(null),
            // Review H2: a failed lookup falls back to `rawOwnerId` as asked,
            // reported once via the shared sampled WARN, never thrown.
            (failure) => this.aliasResolveFailureLogger?.(failure),
            'readOwnerThumbnail',
          )
        : rawOwnerId
    // `MediaFileRef`, not the wire `MediaFileInfo`: these rows are RANKED
    // in-process and never leave it — only the winner's bytes do. The wire
    // shape carries a `url` the store has no business minting here.
    // Typed to the full owner-type union (not just `CropForcedOwnerKind`) so
    // this same closure can also list the NAMED event table — a broader
    // parameter type is still assignable where `CropForcedOwnerKind` is
    // expected (`collectCropForcedMedia`'s `listByOwner`).
    const listInfo = (
      ownerKind: MediaOwnerType,
      id: string,
      deviceId?: number,
    ): Promise<readonly MediaFileRef[]> =>
      this.mediaStore?.listInfoByOwner(ownerKind, id, deviceId) ?? Promise.resolve([])
    // The owner type is KNOWN here, so it is passed through: only an object
    // event has a `trackId` column, and D476 gave this method the parameter
    // that lets it answer `null` without querying for the other two kinds.
    // Only an object event has a `trackId` column. An owner that is not an
    // event table at all (`track`, `face`, `summary`, …) is answered `null`
    // WITHOUT a query: asking the object-events table for a track id is a read
    // whose answer is known, and D476 gave this method the parameter that lets
    // a caller say so.
    const getTrackIdForEvent = (eventId: string): Promise<string | null> =>
      isEventOwnerType(ownerType)
        ? (this.eventStore?.getTrackIdForEvent(eventId, ownerType) ?? Promise.resolve(null))
        : Promise.resolve(null)
    const readBlob = async (mediaId: number): Promise<ResolvedMediaBytes | null> => {
      const file = await (this.mediaStore?.getBytesById(mediaId) ?? Promise.resolve(null))
      return file === null
        ? null
        : {
            bytes: file.bytes,
            mediaId: file.mediaId,
            kind: file.kind,
            deviceId: file.deviceId,
          }
    }

    // ONE list, of the table the caller NAMED. No probe, no first-hit guess.
    // An owner that is not an event table (`track`, `face`, `summary`, …) is
    // listed the same way: the ladders treat "the owner's own media"
    // identically whatever the owner is.
    //
    // D694: an event owner id is a reusable rowid. Prefer the generation the
    // URL named (`/g/<deviceId>/<recordAt>`); otherwise look up the live
    // event's generation. Bare `/o/<eventType>/<id>` still means "current
    // holder". Without a live event and without a URL scope the bare id lists
    // what is on disk (deleted-event URLs / leftovers).
    let ownFiles = await listInfo(ownerType, ownerId)
    if (isEventOwnerType(ownerType)) {
      const gen =
        addressGeneration !== undefined
          ? { deviceId: addressGeneration.deviceId, timestamp: addressGeneration.recordAt }
          : this.eventStore !== null
            ? await this.eventStore.eventGenerationOf(ownerType, ownerId)
            : null
      if (gen !== null) {
        const onCamera = await listInfo(ownerType, ownerId, gen.deviceId)
        const kept = onCamera.filter((f) => f.timestamp === gen.timestamp)
        if (kept.length < onCamera.length) {
          this.ctx.logger.warn('event media of another record on a reused event id — not used', {
            tags: { deviceId: gen.deviceId },
            meta: {
              ownerId,
              ownerType,
              recordAt: gen.timestamp,
              refused: onCamera.length - kept.length,
              kept: kept.length,
              via: 'readOwnerThumbnail',
              scopedBy: addressGeneration !== undefined ? 'url' : 'live-row',
            },
          })
        }
        ownFiles = kept
      }
    }

    // Crop-forced path (viewer `?kind=crop` / `thumbnailSmall`): body crop,
    // then a tight face/plate crop, then any remaining image. The class icon
    // is only for a total miss.
    if (preferKind !== undefined && preferKind.length > 0) {
      const layers = await collectCropForcedMedia(
        { listByOwner: listInfo, getTrackIdForEvent },
        ownerId,
        ownFiles,
      )
      // The ladder reads the two layers separately, so a re-rank after a
      // missing blob has to keep telling them apart — by media id, since the
      // survivors are a subset of the union handed to `readWinningBlob`.
      const bodyIds = new Set(layers.bodyFiles.map((f) => f.mediaId))
      return await readWinningBlob(
        [...layers.bodyFiles, ...layers.detailFiles],
        (rows) =>
          resolveCropForcedMedia(
            rows.filter((r) => bodyIds.has(r.mediaId)),
            (files) => pickCleanMedia(files, preferKind),
            rows.filter((r) => !bodyIds.has(r.mediaId)),
          ),
        readBlob,
      )
    }
    // Default path (event detail / plain mediaUrl): the owner's OWN
    // crop/detail media (`ownFiles`, above) when present, else the OWNING
    // TRACK's cadence media. `crop`/`fullFrameBoxed` are retired for new
    // tracks, so a common object event owns nothing and resolves via its
    // `trackId` (the event row carries it) — old stored events still resolve
    // by their own crop. An owner that IS a track resolves on the first branch
    // and `getTrackIdForEvent` is never asked.
    const { candidates, pick } = await collectDefaultEventMedia({
      ownerType,
      ownerId,
      ownFiles,
      listTrackMedia: (trackId) => listInfo('track', trackId),
      getTrackIdForEvent,
    })
    return await readWinningBlob(candidates, pick, readBlob)
  }

  // ── Global + per-device settings (P8) ─────────────────────────────
  //
  // Cascade: global defaults live on this addon's global settings
  // (getGlobalSettings); per-device overrides live on the device
  // settings aggregator (getDeviceSettingsContribution → BindingsTab's
  // device panel). A missing device override falls back to the global
  // default — same pattern pipeline-orchestrator uses.

  protected globalSettingsSchema(cap?: string) {
    // S5 (refactor spec 2026-07-22): the ~950-line settings-form literal moved
    // VERBATIM to `settings-schema.ts` — pure move, byte-identical schema.
    // `cap` scopes the form: Pipeline Cluster Settings asks for `face-gallery`
    // and gets only Face recognition; omitting it (System → Settings) is the
    // full schema.
    return this.schema(buildGlobalSettingsSchema(cap))
  }

  /**
   * The only reason this is overridden: the face suggestion floor is DERIVED
   * (D222), so the form has to be able to SHOW it without storing it.
   *
   * The schema is a static declaration and cannot interpolate a live value, so
   * the readout's value is injected into the hydrate blob here — the same
   * mechanism `detection-pipeline` uses for its model-substitution readout.
   * It is a `readonlyField`, so it renders display-only, never enters a patch,
   * and never reaches the store: the operator sees what their threshold
   * implies and has nothing to contradict it with. Everything else about this
   * call is `BaseAddon`'s.
   *
   * (Fix round, L3.) `globalSettingsSchema()` is reused, untouched, by
   * `getDeviceSettingsContribution` below to build the PER-DEVICE form —
   * `trackingTape` must stay there. So the strip happens here, on the result
   * THIS method actually hands to the global settings page, never inside
   * `globalSettingsSchema()` itself, which would also remove it from the
   * per-device form that shares the same base sections.
   */
  override async getGlobalSettings(
    overlay?: Record<string, unknown>,
    cap?: string,
    nodeId?: string,
  ): Promise<ConfigUISchemaWithValues | null> {
    const stored = await this.resolveGlobalStore(nodeId, cap)
    const merged = overlay ? { ...stored, ...overlay } : stored
    const readout = formatSuggestionThresholdReadout(
      resolveFaceSettings(merged).similarityThreshold,
    )
    const schema = await super.getGlobalSettings(
      { ...merged, [SUGGESTION_THRESHOLD_READOUT_KEY]: readout },
      cap,
      nodeId,
    )
    if (schema === null) return null
    return { ...schema, sections: stripDeviceOnlyFields(schema.sections) }
  }

  async getDeviceSettingsContribution(input: {
    deviceId: number
  }): Promise<ConfigUISchemaWithValues | null> {
    // Camera-only — analytics knobs (tracking, retention, media policy)
    // are meaningless on Lights / Switches / Sensors / Buttons. Source-
    // side gate keeps the policy with the addon owning the cap; the
    // admin-ui no longer needs the `device-section-policy` allow-list.
    if (!(await this.isCameraDevice(input.deviceId))) return null
    const schema = this.globalSettingsSchema()
    const raw = await this.readDeviceBlob(input.deviceId)
    // Re-home every section into the `Analytics` top-tab (see
    // `toAnalyticsDeviceSections`) so the analytics knobs surface as their
    // own device-detail tab instead of nesting under Config.
    // Hydrated with the EFFECTIVE value — the cluster store under the camera's
    // own blob, the exact merge `readDeviceSettings` resolves from — so a field
    // this camera never saved shows what the runtime uses, not the schema
    // default (see `inherited-device-values.ts`).
    const globalRaw = await this.rawGlobalStoreMirror.resolve()
    const baseSections = schema
      ? hydrateWithInheritedGlobals(
          {
            ...schema,
            // Detection knobs (tracking incl. FP knobs, detection sensitivity,
            // stationary) re-home onto `detection-pipeline` so they surface in
            // the consolidated Detection pipeline → Settings sub-tab; the rest
            // stay on the Analytics top-tab.
            sections: retagRetentionSection(
              retagDetectionSections(
                stripGlobalOnlyFields(toAnalyticsDeviceSections(schema.sections)),
              ),
            ),
          },
          raw,
          globalRaw,
        )
      : []
    // Live Stats top-tab — a single-column section whose only field is
    // a `type:'widget'` resolving the MF widget `pipeline-analytics/
    // live-stats`. The shared `WidgetSlot` runtime mounts the widget
    // from this addon's own bundle; the widget owns its `deviceId`
    // wiring and React code. Mirrors how `pipeline-orchestrator`
    // declares the Detection (Zones) tab via the `zone-editor` widget.
    const liveStatsSection: ConfigSectionWithValues = {
      id: 'live-stats',
      title: 'Live Stats',
      tab: 'live-stats',
      location: 'top-tab',
      columns: 1,
      order: 0,
      fields: [
        {
          type: 'widget',
          key: 'liveStats',
          label: 'Live Stats',
          widgetId: 'pipeline-analytics/live-stats',
          span: 1,
        },
      ],
    }
    return { sections: [...baseSections, liveStatsSection] }
  }

  async getDeviceLiveContribution(_input: {
    deviceId: number
  }): Promise<ConfigUISchemaWithValues | null> {
    return null
  }

  async applyDeviceSettingsPatch(input: {
    deviceId: number
    patch: Record<string, unknown>
  }): Promise<{ success: true }> {
    await this.updateDeviceSettings(input.deviceId, input.patch)
    // The shared raw blob every kind's cold-miss loader reads from — drop it
    // FIRST, unconditionally. Every one of the four targeted deletes below
    // re-fills from this mirror on its next read; leaving it warm would
    // silently re-serve the pre-patch blob and defeat the targeted deletes
    // entirely (D224 — the write and the mirror live in this one process).
    this.rawDeviceBlobMirror.invalidate(input.deviceId)
    // Targeted invalidation — legacy parity (A2): the patch path only ever
    // cleared these four kinds, NOT the full per-device litany.
    this.audioSettingsCache.delete(input.deviceId)
    this.sensitivitySettingsCache.delete(input.deviceId)
    this.trackingSettingsCache.delete(input.deviceId)
    this.confirmationGateSettingsCache.delete(input.deviceId)
    // …plus media: `debugMediaEnabled` is the switch an operator flips to SEE
    // something, and a knob that appears to do nothing for a TTL reads as
    // broken. It was absent from the legacy four because the retired
    // `saveThumbnails` was never worth a round trip.
    this.mediaSettingsCache.delete(input.deviceId)
    // …and stillness: `stillness.calibrate --apply` and a hand-pinned bar both
    // land through this patch, and a threshold that appears to do nothing until
    // the TTL expires reads as broken.
    this.stillnessSettingsCache.delete(input.deviceId)
    // Rebuild the device's processors so tracker/sensitivity changes apply on
    // the next frame instead of waiting for a rebind/restart.
    this.forgetDeviceProcessors(input.deviceId)
    return { success: true as const }
  }

  /**
   * Best-effort camera-type check. Used to short-circuit the settings
   * contribution on non-camera devices. Returns `true` on lookup
   * failure so a transient device-manager hiccup never silently hides
   * legitimate camera sections.
   */
  private async isCameraDevice(deviceId: number): Promise<boolean> {
    const api = this.ctx?.api
    if (!api) return true
    try {
      const dev = await api.deviceManager.getDevice.query({ deviceId })
      if (!dev) return true
      return (dev as { type?: string }).type === DeviceType.Camera
    } catch {
      return true
    }
  }
}

// Re-export the FrameProcessor types so TrackedDetection consumers can
// import from the addon root if needed.
export type {
  FrameProcessorResult,
  TrackedDetectionOut,
} from './pipeline/frame-processor.js'

// Appease eslint "unused import" — TrackedDetection type is referenced
// through the FrameProcessorResult below.
export type _TrackedDetectionBridge = TrackedDetection

/**
 * Add the DERIVED mean to an LTS row for the read surface. Never stored — a
 * persisted mean is a field that can disagree with the `sum`/`samples` it comes
 * from, and one that cannot be merged if two rows are ever combined.
 */
function withMean<T extends { readonly samples: number; readonly sum: number }>(
  row: T,
): T & { readonly mean: number } {
  return { ...row, mean: row.samples > 0 ? row.sum / row.samples : 0 }
}
