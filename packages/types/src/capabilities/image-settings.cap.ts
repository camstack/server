import { z } from 'zod'
import {
  method,
  type CapabilityDefinition,
  type InferNativeProvider,
} from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Vendor-neutral image / picture-adjustment cap — the per-camera config
 * cap shared by reolink / hikvision / amcrest. Models the common ISP
 * surface: the four picture sliders (brightness / contrast / saturation /
 * sharpness), orientation (mirror / flip / rotate), white-balance,
 * exposure and backlight-compensation modes.
 *
 * NORMALIZATION: every slider is a normalized int 0–100. Vendors expose
 * these natively as 0–100 or 0–255 (or other ranges); each provider maps
 * its native range to/from this normalized 0–100 space so the cap surface
 * (and the derived form) is identical across cameras. `warmth` (manual
 * white-balance) is likewise normalized 0–100.
 *
 * Follows the D14 `deviceConfig` archetype (see `stream-params.cap.ts`):
 * `getOptions` advertises per-camera availability, `getStatus` (auto-
 * injected from `status`) reports the live values, and a single
 * `setSettings` mutation applies a partial change. No hand-written
 * settings-contribution methods — the framework derives the UI + save
 * routing from this surface.
 */

/** Sensor/image rotation, degrees clockwise. */
export const ImageRotateSchema = z.enum(['0', '90', '180', '270'])

/** White-balance mode. `manual` unlocks the normalized `warmth` knob. */
export const WhiteBalanceModeSchema = z.enum(['auto', 'manual'])

/** Exposure mode. */
export const ExposureModeSchema = z.enum(['auto', 'manual'])

/**
 * Backlight-compensation mode:
 *   - `off` — disabled
 *   - `blc` — backlight compensation
 *   - `wdr` — wide dynamic range
 *   - `hlc` — highlight compensation
 */
export const BacklightModeSchema = z.enum(['off', 'blc', 'wdr', 'hlc'])

/** Normalized numeric range descriptor — `{ min, max, step }` per the
 *  getOptions availability convention. Slider values are normalized 0–100. */
const NormalizedRangeSchema = z.object({
  min: z.number(),
  max: z.number(),
  step: z.number(),
})

/**
 * Current image-adjustment state. Every field optional — absent when the
 * camera does not expose that control. Slider values are NORMALIZED 0–100.
 * `lastFetchedAt` feeds the runtime-state bridge.
 */
export const ImageSettingsStatusSchema = z.object({
  /** Normalized 0–100. */
  brightness: z.number().optional(),
  /** Normalized 0–100. */
  contrast: z.number().optional(),
  /** Normalized 0–100. */
  saturation: z.number().optional(),
  /** Normalized 0–100. */
  sharpness: z.number().optional(),
  mirror: z.boolean().optional(),
  flip: z.boolean().optional(),
  rotate: ImageRotateSchema.optional(),
  whiteBalance: WhiteBalanceModeSchema.optional(),
  /** Manual white-balance warmth, NORMALIZED 0–100. Meaningful only when `whiteBalance === 'manual'`. */
  warmth: z.number().optional(),
  exposureMode: ExposureModeSchema.optional(),
  backlightMode: BacklightModeSchema.optional(),
  lastFetchedAt: z.number(),
})

/**
 * Per-camera availability descriptor — drives which controls the admin UI
 * renders. Booleans as `supportsX`; numeric ranges as `{ min, max, step }`
 * (the normalized 0–100 range); enums as arrays of supported values (empty
 * array → control hidden). A provider returns honest, camera-probed values
 * — never hardcoded.
 */
export const ImageSettingsOptionsSchema = z.object({
  supportsBrightness: z.boolean(),
  brightness: NormalizedRangeSchema.optional(),
  supportsContrast: z.boolean(),
  contrast: NormalizedRangeSchema.optional(),
  supportsSaturation: z.boolean(),
  saturation: NormalizedRangeSchema.optional(),
  supportsSharpness: z.boolean(),
  sharpness: NormalizedRangeSchema.optional(),
  supportsMirror: z.boolean(),
  supportsFlip: z.boolean(),
  /** Supported rotation values. Empty → rotation not configurable. */
  rotateOptions: z.array(ImageRotateSchema),
  /** Supported white-balance modes. Empty → white-balance not configurable. */
  whiteBalanceModes: z.array(WhiteBalanceModeSchema),
  supportsWarmth: z.boolean(),
  /** Present when `supportsWarmth` — the normalized 0–100 range. */
  warmth: NormalizedRangeSchema.optional(),
  /** Supported exposure modes. Empty → exposure not configurable. */
  exposureModes: z.array(ExposureModeSchema),
  /** Supported backlight modes. Empty → backlight-compensation not configurable. */
  backlightModes: z.array(BacklightModeSchema),
})

/**
 * Partial change to the image config — every field optional. Slider values
 * are normalized 0–100. A provider ignores fields it does not support.
 */
export const ImageSettingsPatchSchema = z.object({
  brightness: z.number().optional(),
  contrast: z.number().optional(),
  saturation: z.number().optional(),
  sharpness: z.number().optional(),
  mirror: z.boolean().optional(),
  flip: z.boolean().optional(),
  rotate: ImageRotateSchema.optional(),
  whiteBalance: WhiteBalanceModeSchema.optional(),
  warmth: z.number().optional(),
  exposureMode: ExposureModeSchema.optional(),
  backlightMode: BacklightModeSchema.optional(),
})

export type ImageRotate = z.infer<typeof ImageRotateSchema>
export type WhiteBalanceMode = z.infer<typeof WhiteBalanceModeSchema>
export type ExposureMode = z.infer<typeof ExposureModeSchema>
export type BacklightMode = z.infer<typeof BacklightModeSchema>
export type ImageSettingsStatus = z.infer<typeof ImageSettingsStatusSchema>
export type ImageSettingsOptions = z.infer<typeof ImageSettingsOptionsSchema>
export type ImageSettingsPatch = z.infer<typeof ImageSettingsPatchSchema>

export const imageSettingsCapability = {
  name: 'image-settings',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Camera],
  deviceConfig: {
    ui: { kind: 'derived-form', builderId: 'image-settings', tab: 'image' },
  },
  methods: {
    getOptions: method(z.object({ deviceId: z.number() }), ImageSettingsOptionsSchema),
    setSettings: method(
      z.object({ deviceId: z.number(), settings: ImageSettingsPatchSchema }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),
  },
  status: {
    schema: ImageSettingsStatusSchema,
    kind: 'poll',
  },
  runtimeState: ImageSettingsStatusSchema,

  /**
   * Runtime-state durability: **restored** — operator-set camera imaging; mutation-driven.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'restored',
  /**
   * History (D850): none — camera image configuration (operator intent), not a trend.
   */
  history: 'none',
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastFetchedAt'],
} as const satisfies CapabilityDefinition

export type IImageSettingsProvider = InferNativeProvider<typeof imageSettingsCapability>
