/**
 * Camera & PTZ types — shared between CamStack app and proxy.
 */

// ---------------------------------------------------------------------------
// Source & stream types
// ---------------------------------------------------------------------------

/** Streaming method. */
export type StreamMethod = 'webrtc' | 'mjpeg'

// ---------------------------------------------------------------------------
// PTZ (Pan-Tilt-Zoom)
// ---------------------------------------------------------------------------

/** PTZ command. */
export interface PanTiltZoomCommand {
  movement?: 'Relative' | 'Absolute' | 'Continuous' | 'Home' | 'Preset'
  pan?: number
  tilt?: number
  zoom?: number
  preset?: string
  timeout?: number
}

/** PTZ capabilities reported by the device. */
export interface PanTiltZoomCapabilities {
  pan?: boolean
  tilt?: boolean
  zoom?: boolean
  presets?: Record<string, string>
}

// ---------------------------------------------------------------------------
// Camera accessory switches (Advanced Notifier plugin)
// ---------------------------------------------------------------------------

/** Accessory switch kinds exposed by the Advanced Notifier plugin. */
export type CameraAccessorySwitchKind =
  | 'siren_on_motion'
  | 'siren'
  | 'light_on_motion'
  | 'light'
  | 'pir'
  | 'autotracking'

// ---------------------------------------------------------------------------
// Extended camera status (batch, with accessories)
// ---------------------------------------------------------------------------

/** Extended camera status with accessory switches (from AN plugin). */
export interface CameraStatusEntry {
  notificationsEnabled: boolean
  isRecording: boolean
  isSnapshotsEnabled: boolean
  isRebroadcastEnabled: boolean
  accessorySwitchStates: Partial<Record<CameraAccessorySwitchKind, boolean>>
}

/** Batch camera status response. */
export interface CamerasStatusResult {
  cameras: Record<string, CameraStatusEntry>
}
