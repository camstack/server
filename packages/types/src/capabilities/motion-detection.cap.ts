import { z } from 'zod'
import { DeviceType } from '../device/device-type.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'
import { BoundingBoxSchema, FrameInputSchema } from './schemas/detection-shared.js'
import { FrameHandleSchema } from './schemas/streaming-shared.js'

const MotionRegionSchema = z.object({
  bbox: BoundingBoxSchema,
  pixelCount: z.number(),
  intensity: z.number(),
})

const MotionAnalysisResultSchema = z.object({
  detected: z.boolean(),
  regionCount: z.number(),
  /** Regions passing minArea filter — used for pipeline triggering. */
  regions: z.array(MotionRegionSchema).readonly(),
  /** All raw regions from CCL before minArea filter — used for UI debug overlay. */
  rawRegions: z.array(MotionRegionSchema).readonly(),
  frameWidth: z.number(),
  frameHeight: z.number(),
  analysisMs: z.number(),
})

export const motionDetectionCapability = {
  name: 'motion-detection',
  scope: 'device',
  mode: 'singleton',
  kind: 'wrapper',
  defaultActive: true,
  /** Frame-differencing motion analysis over a video stream — only a camera
   *  produces the frames. Read by the `defaultActive` auto-bind in
   *  `device-manager.getBindings` to decide which devices it may claim. */
  deviceTypes: [DeviceType.Camera],
  exposesDeviceSettings: true,
  methods: {
    // Exactly one of `frame` / `frameHandle` carries the pixels. `frame`
    // ships gray pixels inline (today's path). `frameHandle` (CB5) names
    // the same shm ring slot so a hub-local motion provider reads pixels
    // back zero-copy instead of re-serialising them over UDS. A recycled
    // slot / foreign handle yields a null read → empty result (the runner
    // ships `frame` as the fallback, queue-depth gated).
    // The pipeline's own frame analysis: never a viewer's call (D921).
    analyze: method(
      z.object({
        deviceId: z.number(),
        frame: FrameInputSchema.optional(),
        frameHandle: FrameHandleSchema.optional(),
      }),
      MotionAnalysisResultSchema,
      { role: 'admin', kind: 'mutation' },
    ),
    removeCamera: method(z.object({ deviceId: z.number() }), z.void(), {
      role: 'admin',
      kind: 'mutation',
    }),
    reset: method(z.void(), z.void(), { role: 'admin', kind: 'mutation' }),
  },
  events: {
    onMotion: {
      data: z.object({
        deviceId: z.number(),
        detected: z.boolean(),
        regionCount: z.number(),
      }),
    },
  },
} as const satisfies CapabilityDefinition

export type IMotionDetectionProvider = InferProvider<typeof motionDetectionCapability>
export type MotionRegion = z.infer<typeof MotionRegionSchema>
export type MotionAnalysisResult = z.infer<typeof MotionAnalysisResultSchema>

export { MotionAnalysisResultSchema, MotionRegionSchema }
