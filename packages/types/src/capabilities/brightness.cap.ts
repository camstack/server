import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'

/**
 * Dimmable-light brightness control. Co-exists with `switch` on the
 * same device — the switch toggles on/off, this cap sets the level
 * applied when the light is on. Drivers map their per-vendor dim
 * controls to this single-method surface.
 *
 * The cap is intentionally minimal: a single `setBrightness({deviceId,
 * level})` mutation plus the auto-injected `getStatus`. Drivers
 * that expose richer controls (color temperature, scenes, schedules)
 * should surface those via the device's `getSettingsUISchema()`
 * instead of bloating this cap.
 */
export const BrightnessStatusSchema = z.object({
  /** Current level as 0..100 inclusive. Firmware-reported. */
  level: z.number().min(0).max(100).meta(readingMeta('percentage')),
  /** Ms epoch of the last operator-driven change. Useful for UI freshness. */
  lastChangedAt: z.number(),
})

export type BrightnessStatus = z.infer<typeof BrightnessStatusSchema>

export const brightnessCapability = {
  name: 'brightness',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Light],
  methods: {
    setBrightness: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        level: z.number().min(0).max(100),
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
  },
  events: {
    /**
     * Emitted whenever the brightness changes — operator action OR
     * firmware push. Subscribers (UI sliders, automation engines) react
     * without polling.
     */
    onBrightnessChanged: {
      data: z.object({
        deviceId: z.number(),
        level: z.number().min(0).max(100),
        lastChangedAt: z.number(),
      }),
    },
  },
  status: {
    schema: BrightnessStatusSchema,
    kind: 'command-driven',
  },
  /**
   * Runtime-state slice — the last applied brightness level, mirrored
   * by the kernel. Read via `device.state.brightness.value` so UI
   * sliders surface the current level without polling the provider.
   */
  runtimeState: BrightnessStatusSchema,

  /**
   * Runtime-state durability: **session** — live lamp state, re-published by the provider on connect.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /**
   * History (D850): recorded series. Actuator tier: level keeps every change.
   */
  history: {
    fields: {
      level: { kind: 'gauge', unit: '%', minIntervalMs: 0 },
    },
  },
} as const satisfies CapabilityDefinition

export type IBrightnessProvider = InferProvider<typeof brightnessCapability>
