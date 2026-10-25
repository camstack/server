// packages/types/src/types/camera-detection.ts

/**
 * Motion detection configuration per camera.
 * Motion is a pipeline TRIGGER, not a pipeline step.
 */
export interface CameraMotionConfig {
  /** 'stream' = frame-diff analysis on decoded frames (default)
   *  'onboarded' = use camera's native motion signal via IMotionSensor capability
   *  'smart' = AI-based motion detection */
  readonly source: 'stream' | 'onboarded' | 'smart'
  /** Frame-diff settings (only used when source='stream') */
  readonly threshold?: number // pixel intensity diff, default 25
  readonly minArea?: number // minimum changed pixels, default 500
}

/**
 * Camera native AI detection configuration.
 * These events are emitted for recording/notifications, NOT for inference pipeline.
 * Uses the IObjectDetector device capability to receive detection events.
 */
export interface CameraNativeDetectionConfig {
  /** Whether to listen for the camera's native AI events */
  readonly enabled: boolean
  /** Source identifier for attribution */
  readonly source: string // 'onvif', 'reolink-ai', 'onvif'
  /** Classes the camera reports natively */
  readonly classes: readonly string[] // ['person', 'vehicle']
}

/**
 * Combined camera detection capabilities config.
 */
export interface CameraDetectionCapabilities {
  readonly motion: CameraMotionConfig
  readonly nativeDetection?: CameraNativeDetectionConfig
}
