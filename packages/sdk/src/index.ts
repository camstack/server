// ─── Client ──────────────────────────────────────────────────────────
export { System, createSystem, raceFastestEndpoint } from './system.js'
export type { LoginOptions, LoginOutcome, RefreshedSession } from './system.js'
export {
  isSessionRefusal,
  jwtExpiresAt,
  SessionKeeper,
  type SessionKeeperOptions,
  type SessionTokens,
} from './session-keeper.js'
export type {
  SystemConfig,
  CredentialRefreshReason,
  UserInfo,
  SystemLiveEvent,
  SystemLiveEventListener,
  SecondFactorKind,
} from './system.js'
// Client-facing device identity snapshot (name/type/online) — surfaced by
// System.getDeviceInfo / listDeviceInfos so consumers don't derive it.
export type { DeviceInfo } from '@camstack/types'
// Settings-redesign cleanup: `SettingsSection` type deleted together
// with the legacy `settings.*` tRPC namespace. Hub yml sections now
// flow through the `system-config` built-in addon via
// `addons.getGlobalSettings / updateGlobalSettings`.

// ─── tRPC AppRouter type (for advanced typed access) ─────────────────
export type { BackendAppRouter } from './backend-router.js'
export type { BackendAppRouter as AppRouter } from './backend-router.js'

// ─── Client config types ────────────────────────────────────────────
export type { BackendConnectionState } from './types.js'

// ─── Detection classes ──────────────────────────────────────────────
export {
  DetectionClass,
  animalClasses,
  personClasses,
  vehicleClasses,
  faceClasses,
  licensePlateClasses,
  motionClasses,
  packageClasses,
  audioClasses,
  audioLabelClasses,
  doorbellClasses,
  sensorLabelClasses,
  detectionClassesDefaultMap,
  isFaceClassname,
  isPlateClassname,
  isAnimalClassname,
  isPersonClassname,
  isVehicleClassname,
  isMotionClassname,
  isDoorbellClassname,
  isPackageClassname,
  isAudioClassname,
  isSensorLabelClassname,
  isLabelDetection,
  getParentClass,
  getParentDetectionClass,
  defaultDetectionClasses,
  DEFAULT_ENABLED_CLASSES,
  TIMELINE_PRESET_CRITICAL,
  TIMELINE_PRESET_IMPORTANT,
  TIMELINE_PRESET_ALL,
  getClassesForTimelinePreset,
} from './detection.js'
export type { TimelineEventPreset } from './detection.js'

// ─── Timeline & events ─────────────────────────────────────────────
export type {
  TimelineEventSeverity,
  MotionFragmentType,
  DetectionEvent,
  MotionItem,
  TimelineArtifact,
  AudioLevelSegment,
  TimelineRecordingSegment,
  CameraDayDataResponse,
  ClusteredDayDataResponse,
  TimelineCluster,
  DetectionGroup,
  ClusteredDayDataQuery,
  GroupedEventsQuery,
  GroupedEventsResult,
  ClusterEventsQuery,
  ClusterEventsResult,
  ReelEvent,
  ReelEventsQuery,
  ReelEventsResult,
} from './timeline.js'

// ─── Camera & PTZ ───────────────────────────────────────────────────
export type {
  StreamMethod,
  PanTiltZoomCommand,
  PanTiltZoomCapabilities,
  CameraAccessorySwitchKind,
  CameraStatusEntry,
  CamerasStatusResult,
} from './camera.js'

// ─── NVR types ──────────────────────────────────────────────────────
export type {
  StreamSourceEntry,
  NvrCamera,
  CameraAccessory,
  StreamInfo,
  NormalizedBoundingBox,
  DetectionData,
  EventSnapshotData,
  NvrEvent,
  RecordingSegment,
  MotionBucket,
  LiveDetection,
  LiveMotionData,
  LiveDetectionData,
  LiveAudioData,
  LiveMotionEvent,
  LiveDetectionEvent,
  LiveAudioEvent,
  LiveGenericEvent,
  LiveReviewEvent,
  LiveEvent,
  LiveEventType,
  VideoClipsQuery,
  NvrVideoClip,
  VideoClipsResult,
  VideoClipUrlResult,
  CameraDayData,
  CameraStatus,
  EventsQuery,
  MotionQuery,
  RecordingsQuery,
  NvrConfig,
  ProviderConfigs,
} from './nvr.js'
