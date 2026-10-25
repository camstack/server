import { DeviceActivityPanel } from '@camstack/ui-library'
import { EventCategory } from '@camstack/types'

/**
 * Default event categories the device-detail panel pre-tracks. The user
 * can mutate this set through the EventStream's multiselect popover at
 * runtime; a Reset button restores this baseline.
 *
 * Coverage rationale (excludes per-frame inference noise like
 * `DetectionResult` / `PipelineAudioInferenceResult` which live at
 * frame rate and are anyway dropped from the recent-buffer ring by
 * the kernel's deny-list):
 *  - `ProviderMotion` / `ProviderDetection` — raw signals from the
 *    camera (hardware AI / motion sensor).
 *  - `DetectionCameraNative` — hardware-AI classifications (people /
 *    vehicle / animal / face / package).
 *  - `MotionOnMotionChanged` — unified motion event from any source
 *    (`onboard` Reolink firmware, `analyzer` motion-wasm).
 *  - `DetectionPhaseTransition` — runner phase ACTIVE ↔ WATCHING.
 *  - `DetectionEvent` — aggregated detection (post-tracking, not
 *    per-frame).
 *  - `PipelineCameraAssigned` / `Unassigned` / `Updated` — orchestrator
 *    routing decisions for this camera (which node runs detection).
 *  - Lifecycle: `DeviceOnline` / `DeviceOffline` /
 *    `DeviceStreamsRegistered`.
 *  - `RecordingStarted` / `Stopped` / `Error` — recording lifecycle.
 */
const DEFAULT_EVENT_CATEGORIES = [
  EventCategory.ProviderMotion,
  EventCategory.ProviderDetection,
  EventCategory.DetectionCameraNative,
  EventCategory.MotionOnMotionChanged,
  EventCategory.DetectionPhaseTransition,
  EventCategory.DetectionEvent,
  EventCategory.PipelineCameraAssigned,
  EventCategory.PipelineCameraUnassigned,
  EventCategory.PipelineCameraUpdated,
  EventCategory.DeviceOnline,
  EventCategory.DeviceOffline,
  EventCategory.DeviceStreamsRegistered,
  EventCategory.RecordingStarted,
  EventCategory.RecordingStopped,
  EventCategory.RecordingError,
] as const

interface CameraEventsTabProps {
  readonly deviceId: number
}

export function CameraEventsTab({ deviceId }: CameraEventsTabProps) {
  return (
    <DeviceActivityPanel
      deviceId={deviceId}
      defaultEventCategories={DEFAULT_EVENT_CATEGORIES}
      maxHeight="max-h-full"
    />
  )
}
