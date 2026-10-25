/** Shared Zod schemas for the runtime pipeline orchestrator metrics. */

import { z } from 'zod'

export const OrchestratorMetricsSchema = z.object({
  activeCameras: z.number(),
  throttledCameras: z.number(),
  avgInferenceTimeMs: z.number(),
  queueDepth: z.number(),
})

export const CameraMetricsSchema = z.object({
  detectionMode: z.enum(['disabled', 'always-on', 'on-motion']),
  configuredFps: z.number(),
  actualFps: z.number(),
  queueDepth: z.number(),
  avgInferenceTimeMs: z.number(),
  droppedFrames: z.number(),
  phase: z.enum(['idle', 'watching', 'active']),
})

export const CameraMetricsWithDeviceIdSchema = CameraMetricsSchema.extend({
  deviceId: z.number(),
})
