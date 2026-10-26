import { z } from 'zod'
import {
  method,
  type CapabilityDefinition,
  type InferNativeProvider,
} from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'

/**
 * Vendor-neutral day/night (IR-cut) control — the per-camera config cap
 * shared by reolink / hikvision / amcrest. Models the common firmware
 * surface: the IR-cut switching MODE plus the two knobs that gate it
 * (photocell `sensitivity` + `switchDelaySec`). Each vendor maps these
 * onto its own ISAPI / Baichuan / Dahua-CGI fields; the cap standardises
 * the shape so ONE derived-form renders every camera.
 *
 * Follows the D14 `deviceConfig` archetype (see `stream-params.cap.ts`):
 * `getOptions` advertises per-camera availability, `getStatus` (auto-
 * injected from `status`) reports the live values, and a single
 * `setSettings` mutation applies a partial change. No hand-written
 * settings-contribution methods — the framework derives the UI + save
 * routing from this surface.
 */

/** IR-cut switching mode. `schedule` = time-of-day table configured on the camera. */
export const DayNightModeSchema = z.enum(['auto', 'day', 'night', 'schedule'])

/** Normalized numeric range descriptor — `{ min, max, step }` per the
 *  getOptions availability convention. Normalized values are 0–100. */
const NormalizedRangeSchema = z.object({
  min: z.number(),
  max: z.number(),
  step: z.number(),
})

/**
 * Current day/night state. Optional fields are absent when the camera
 * does not expose that knob (a photocell-less model reports no
 * `sensitivity`). `lastFetchedAt` feeds the runtime-state bridge.
 */
export const DayNightStatusSchema = z.object({
  mode: DayNightModeSchema,
  /** IR-cut trigger sensitivity, NORMALIZED 0–100 (higher = switches to night sooner). */
  sensitivity: z.number().optional().meta(readingMeta('none')),
  /** Delay before the IR-cut filter flips, in seconds. */
  switchDelaySec: z.number().optional().meta(readingMeta('duration')),
  lastFetchedAt: z.number(),
})

/**
 * Per-camera availability descriptor — drives which controls the admin UI
 * renders. Booleans as `supportsX`; numeric ranges as `{ min, max, step }`
 * (normalized 0–100); the mode choice-set as an array. A provider returns
 * honest, camera-probed values — never hardcoded.
 */
export const DayNightOptionsSchema = z.object({
  /** Modes this camera accepts. Empty → the camera has no configurable day/night mode. */
  modes: z.array(DayNightModeSchema),
  supportsSensitivity: z.boolean(),
  /** Present when `supportsSensitivity` — the normalized 0–100 range. */
  sensitivity: NormalizedRangeSchema.optional(),
  supportsSwitchDelay: z.boolean(),
  /** Present when `supportsSwitchDelay` — the allowed delay range in seconds. */
  switchDelaySec: NormalizedRangeSchema.optional(),
})

/**
 * Partial change to the day/night config — every field optional. A
 * provider ignores fields it does not support.
 */
export const DayNightSettingsPatchSchema = z.object({
  mode: DayNightModeSchema.optional(),
  sensitivity: z.number().optional(),
  switchDelaySec: z.number().optional(),
})

export type DayNightMode = z.infer<typeof DayNightModeSchema>
export type DayNightStatus = z.infer<typeof DayNightStatusSchema>
export type DayNightOptions = z.infer<typeof DayNightOptionsSchema>
export type DayNightSettingsPatch = z.infer<typeof DayNightSettingsPatchSchema>

export const dayNightCapability = {
  name: 'day-night',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Camera],
  deviceConfig: {
    ui: { kind: 'derived-form', builderId: 'day-night', tab: 'image' },
  },
  methods: {
    getOptions: method(z.object({ deviceId: z.number() }), DayNightOptionsSchema),
    setSettings: method(
      z.object({ deviceId: z.number(), settings: DayNightSettingsPatchSchema }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),
  },
  status: {
    schema: DayNightStatusSchema,
    kind: 'poll',
  },
  runtimeState: DayNightStatusSchema,

  /**
   * Runtime-state durability: **restored** — operator-set IR-cut behaviour; mutation-driven.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'restored',
  /**
   * History (D850): none — firmware configuration, not a measurement.
   */
  history: 'none',
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastFetchedAt'],
} as const satisfies CapabilityDefinition

export type IDayNightProvider = InferNativeProvider<typeof dayNightCapability>
