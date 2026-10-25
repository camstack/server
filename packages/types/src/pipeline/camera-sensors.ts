import { z } from 'zod'

/**
 * What started a camera's onboard motion (D672). `camera` is the camera's own
 * firmware; `sensor` is a device the operator ATTACHED to it. Absent on the
 * wire means the camera: only the camera-sensors bridge ever says `sensor`.
 */
export const MotionTriggeredBySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('camera') }),
  z.object({ kind: z.literal('sensor'), deviceId: z.number().int().positive() }),
])
export type MotionTriggeredBy = z.infer<typeof MotionTriggeredBySchema>

export const CAMERA_TRIGGER: MotionTriggeredBy = Object.freeze({ kind: 'camera' })

export interface MotionTriggeredByReading {
  readonly triggeredBy: MotionTriggeredBy
  /** True when a value was PRESENT and did not parse — the caller logs it. */
  readonly malformed: boolean
}

export function readMotionTriggeredBy(value: unknown): MotionTriggeredByReading {
  if (value === undefined) return { triggeredBy: CAMERA_TRIGGER, malformed: false }
  const parsed = MotionTriggeredBySchema.safeParse(value)
  return parsed.success
    ? { triggeredBy: parsed.data, malformed: false }
    : { triggeredBy: CAMERA_TRIGGER, malformed: true }
}

/** The orchestrator device-store key, beside `motionSources`. */
export const CAMERA_SENSORS_SETTINGS_KEY = 'cameraSensors'
/** More than this is a configuration error, not a camera. */
export const MAX_CAMERA_SENSORS = 8

export const CameraSensorRefSchema = z.object({
  addonId: z.string().min(1),
  stableId: z.string().min(1),
})
export type CameraSensorRef = z.infer<typeof CameraSensorRefSchema>

export function cameraSensorRefKey(ref: CameraSensorRef): string {
  return `${ref.addonId}/${ref.stableId}`
}

/**
 * A sensor's mode (D673). `in-addition`: its motion is the camera's motion too.
 * `replace`: its motion is the camera's, and while one is READY the camera's
 * own motion no longer counts on its own. `confirm`: while one is READY the
 * camera's own motion counts only while a confirm sensor is active — with or
 * without a replace sensor (spec C2, the controller's ruling on Q1).
 */
export const CameraSensorModeSchema = z.enum(['in-addition', 'confirm', 'replace'])
export type CameraSensorMode = z.infer<typeof CameraSensorModeSchema>
/** A stored sensor with no mode — every CS-1 row — is in addition. */
export const DEFAULT_CAMERA_SENSOR_MODE: CameraSensorMode = 'in-addition'

export const CameraSensorEntrySchema = CameraSensorRefSchema.extend({
  mode: CameraSensorModeSchema.default(DEFAULT_CAMERA_SENSOR_MODE),
})
export type CameraSensorEntry = z.infer<typeof CameraSensorEntrySchema>

/**
 * A camera's attached sensors. A CS-1 row carried an envelope
 * `mode: 'in-addition'`: `z.object` drops it on parse, and the PARSED value is
 * what the write stores (D672 rule 3), so it is never written again.
 */
export const CameraSensorsConfigSchema = z
  .object({
    sensors: z.array(CameraSensorEntrySchema).min(1).max(MAX_CAMERA_SENSORS),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>()
    value.sensors.forEach((ref, index) => {
      const key = cameraSensorRefKey(ref)
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['sensors', index],
          message: `duplicate camera sensor ${key}`,
        })
      }
      seen.add(key)
    })
  })
export type CameraSensorsConfig = z.infer<typeof CameraSensorsConfigSchema>

/** Every attachment names its mode; an older orchestrator that does not is in addition. */
const AttachmentFields = {
  addonId: z.string(),
  stableId: z.string(),
  mode: CameraSensorModeSchema.default(DEFAULT_CAMERA_SENSOR_MODE),
}

export const CameraSensorAttachmentSchema = z.discriminatedUnion('state', [
  z.object({
    ...AttachmentFields,
    state: z.literal('ready'),
    deviceId: z.number(),
    name: z.string(),
    caps: z.array(z.string()).readonly(),
  }),
  z.object({
    ...AttachmentFields,
    state: z.literal('offline'),
    deviceId: z.number(),
    name: z.string(),
    reason: z.enum(['offline', 'disabled']),
  }),
  z.object({ ...AttachmentFields, state: z.literal('missing'), reason: z.string() }),
  z.object({
    ...AttachmentFields,
    state: z.literal('unsupported'),
    deviceId: z.number(),
    name: z.string(),
    reason: z.string(),
  }),
  z.object({ ...AttachmentFields, state: z.literal('unreadable'), reason: z.string() }),
])
export type CameraSensorAttachment = z.infer<typeof CameraSensorAttachmentSchema>

/**
 * Why a configured camera forwards NOTHING from its sensors, however ready they
 * are (D672): it does not list `onboard` in `motionSources` (attaching a sensor
 * does not add it), or it has no active detection config at all (the bridge
 * reads the active config). Absent = forwarded, or an older node that does not
 * say.
 */
export const CameraSensorsNotForwardedSchema = z.enum(['onboard-not-listed', 'no-active-detection'])
export type CameraSensorsNotForwarded = z.infer<typeof CameraSensorsNotForwardedSchema>

/** Whether the camera's OWN motion counts on its own (D673 C2), from its READY sensors (C3). */
export const CameraOwnMotionSchema = z.enum(['always', 'when-confirmed', 'never'])
export type CameraOwnMotion = z.infer<typeof CameraOwnMotionSchema>

/** Confirm / Replace cannot suppress this camera's motion: its provider still emits it directly (D673 C13). */
export const CameraSensorsNotEnforcedSchema = z.enum(['provider-not-split'])
export type CameraSensorsNotEnforced = z.infer<typeof CameraSensorsNotEnforcedSchema>

/**
 * The camera's OWN onboard motion (D696): the raw input the bridge combines,
 * never the effective value. The camera's `motion` slice is the effective one,
 * so a view of the camera's own row reads this.
 * - `atMs`: when the bridge received the camera's last own edge.
 * - `detected`: evaluated WHEN THE STATUS IS ASKED — the last edge said `true`
 *   AND it is younger than the window the bridge counts the camera's own motion
 *   for (`motionCooldownMs`, floored at two sustain ticks). A camera that never
 *   sends a clear (heartbeats only) therefore reads `false` once no push came
 *   within the window; a status read is a snapshot, so a live view re-asks.
 * Absent = this orchestrator has not received the camera's own motion since it
 * started (unknown, never "quiet"), or an orchestrator older than D696.
 */
export const CameraRawLevelSchema = z.object({
  detected: z.boolean(),
  atMs: z.number(),
})
export type CameraRawLevel = z.infer<typeof CameraRawLevelSchema>

export const CameraSensorsStatusSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('not-configured'),
    cameraLevel: CameraRawLevelSchema.optional(),
  }),
  z.object({
    state: z.literal('unreadable'),
    reason: z.string(),
    cameraLevel: CameraRawLevelSchema.optional(),
  }),
  z.object({
    state: z.literal('configured'),
    cameraLevel: CameraRawLevelSchema.optional(),
    sensors: z.array(CameraSensorAttachmentSchema).readonly(),
    /** Absent = an orchestrator older than CS-2: it does not say (D315). */
    cameraMotion: CameraOwnMotionSchema.optional(),
    notForwarded: CameraSensorsNotForwardedSchema.optional(),
    notEnforced: CameraSensorsNotEnforcedSchema.optional(),
  }),
])
export type CameraSensorsStatus = z.infer<typeof CameraSensorsStatusSchema>

/** What a camera reads before its first settings read ANSWERED (D315). */
export const CAMERA_SENSORS_NOT_LOADED: CameraSensorsStatus = Object.freeze({
  state: 'unreadable',
  reason: 'camera sensor mappings not loaded',
})
