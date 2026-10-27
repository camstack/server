import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'

/**
 * Fan-control cap. Models HA `fan.*` entity-specific surfaces:
 * speed percentage, preset modes, ceiling-fan direction, and
 * oscillation. The on/off state lives on the existing `switch` cap
 * (Fan devices register `switch + fan-control`, mirroring the
 * Light pattern of `switch + brightness + color`).
 *
 * `availablePresets` mirrors HA's `preset_modes` attribute so the
 * UI renders a closed-list picker without a separate `getOptions`
 * round-trip. `direction` and `oscillating` are nullable — most
 * fans don't expose them.
 *
 * Sub-surface gating paired with `DeviceFeature` flags:
 *   - `FanSpeed` — speed-percentage slider
 *   - `FanPreset` — preset selector
 *   - `FanDirection` — direction toggle (ceiling fans)
 *   - `FanOscillating` — oscillation toggle
 */

export const FanDirectionSchema = z.enum(['forward', 'reverse'])
export type FanDirection = z.infer<typeof FanDirectionSchema>

export const FanControlStatusSchema = z.object({
  /** Active speed as 0..100 inclusive. Null when the device has no
   *  speed surface (single-speed fan). */
  speed: z.number().min(0).max(100).nullable().meta(readingMeta('percentage')),
  /** Speed granularity the device accepts (HA `percentage_step`, e.g. 25 for
   *  a 4-speed fan). Absent when unknown — the UI then falls back to step 1. */
  percentageStep: z.number().positive().optional().meta(readingMeta('percentage')),
  /** Active preset mode (`auto` / `quiet` / `turbo` / vendor-specific)
   *  — empty string when no preset is active or supported. */
  preset: z.string(),
  /** Available preset modes the device accepts. */
  availablePresets: z.array(z.string()),
  /** Ceiling-fan blade direction. Null when the device has no
   *  direction surface. */
  direction: FanDirectionSchema.nullable(),
  /** Oscillation toggle. Null when the device has no oscillation
   *  surface. */
  oscillating: z.boolean().nullable(),
  /** Ms epoch when the slice was last updated. */
  lastChangedAt: z.number(),
})

export type FanControlStatus = z.infer<typeof FanControlStatusSchema>

export const fanControlCapability = {
  name: 'fan-control',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Fan],
  methods: {
    setPercentage: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        speed: z.number().min(0).max(100),
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
    setPreset: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        preset: z.string().min(1),
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
    setDirection: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        direction: FanDirectionSchema,
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
    setOscillating: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        oscillating: z.boolean(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
  },
  status: {
    schema: FanControlStatusSchema,
    kind: 'push',
  },
  /**
   * Runtime-state slice — mirrored by the kernel. UI fan speed
   * sliders read `speed` for live updates.
   */
  runtimeState: FanControlStatusSchema,

  /**
   * Runtime-state durability: **session** — as `brightness`.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /**
   * History (D850): recorded series. Actuator tier: speed keeps every change.
   */
  history: {
    fields: {
      speed: { kind: 'gauge', unit: '%', minIntervalMs: 0 },
      oscillating: { kind: 'boolean' },
    },
  },
} as const satisfies CapabilityDefinition

export type IFanControlProvider = InferProvider<typeof fanControlCapability>
