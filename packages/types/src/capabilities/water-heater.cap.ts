import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'

/**
 * Water heater / boiler cap. Models HA `water_heater.*` entities — a
 * climate-family actuator with a target temperature, an operation-mode
 * selector (`eco` / `electric` / `gas` / `heat_pump` / `high_demand` /
 * `performance` / `off`), and an optional away-mode toggle.
 *
 * The slice carries the current + target temperature, the active
 * operation mode (HA's `state`) and its available set (HA's
 * `operation_list`), the away flag (HA `away_mode` 'on'/'off' → bool,
 * null when unsupported), plus the `min_temp` / `max_temp` bounds.
 *
 * Providers populate only what the hardware reports — temperature and
 * away fields stay null when the device has no such surface.
 */

export const WaterHeaterStatusSchema = z.object({
  /** Current measured temperature. Null when not reported. */
  currentTemp: z.number().nullable().meta(readingMeta('temperature')),
  /** Target temperature setpoint. Null when no setpoint surface. */
  targetTemp: z.number().nullable().meta(readingMeta('temperature')),
  /** Active operation mode = HA `state` (`eco` / `electric` / `gas` /
   *  `heat_pump` / `high_demand` / `performance` / `off`). Null when the
   *  device reports an unknown state. */
  operationMode: z.string().nullable(),
  /** Available operation modes = HA `operation_list`. */
  availableModes: z.array(z.string()),
  /** Away mode (HA `away_mode` 'on'/'off' → bool). Null when the device
   *  has no away surface. */
  away: z.boolean().nullable(),
  /** HA `min_temp` attribute. Null when not reported. */
  minTemp: z.number().nullable().meta(readingMeta('temperature')),
  /** HA `max_temp` attribute. Null when not reported. */
  maxTemp: z.number().nullable().meta(readingMeta('temperature')),
  /** Ms epoch when the slice was last updated. */
  lastChangedAt: z.number(),
})

export type WaterHeaterStatus = z.infer<typeof WaterHeaterStatusSchema>

export const waterHeaterCapability = {
  name: 'water-heater',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.WaterHeater],
  methods: {
    setTargetTemp: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        temp: z.number().finite(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
    setOperationMode: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        mode: z.string().min(1),
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
    setAway: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        on: z.boolean(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
  },
  status: {
    schema: WaterHeaterStatusSchema,
    kind: 'push',
  },
  /**
   * Runtime-state slice — mirrored by the kernel. UI controls watch the
   * slice for live temperature / mode / away changes.
   */
  runtimeState: WaterHeaterStatusSchema,

  /**
   * Runtime-state durability: **session** — as `climate-control`.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /**
   * History (D850): recorded series. The schema carries no unit; providers publish Celsius. Setpoint keeps every change.
   */
  history: {
    fields: {
      currentTemp: { kind: 'gauge', unit: '°C', deadband: 0.5 },
      targetTemp: { kind: 'gauge', unit: '°C', minIntervalMs: 0 },
    },
  },
} as const satisfies CapabilityDefinition

export type IWaterHeaterProvider = InferProvider<typeof waterHeaterCapability>
