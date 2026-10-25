import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * HVAC / climate control cap. Models the full surface of a HA
 * `climate.*` entity (thermostat, A/C, heat pump, dehumidifier)
 * with a single coherent slice — mode + fan + preset + target +
 * dual-setpoint range + humidity + read-only current readings.
 *
 * Operation modes (`HvacMode`) follow HA's canonical set; not every
 * device supports every mode — the provider rejects unsupported
 * values at runtime. Min/max/step bounds for the setpoint are surfaced
 * via `getOptions` on the provider — they are static per-device hardware
 * properties persisted in the device config blob.
 *
 * `fanMode` / `preset` are free-form strings because device vendors
 * use vastly different vocabularies (`auto`/`low`/`high` vs
 * `quiet`/`normal`/`turbo`; `eco`/`away`/`sleep` vs `home`/`night`).
 * The provider populates `availableFanModes` / `availablePresets`
 * on the slice so the UI renders a closed-list picker.
 *
 * Sub-surface gating paired with `DeviceFeature` flags:
 *   - `ClimateDualSetpoint` — heat_cool dual-target range support
 *   - `ClimateHumidity` — currentHumidity / targetHumidity surfaces
 *   - `ClimateFanMode` — fan-mode selector
 *   - `ClimatePreset` — preset selector
 *   - `ClimateSwingVertical` — vertical louver swing toggle
 *   - `ClimateSwingHorizontal` — horizontal louver swing toggle
 *
 * Swing is modelled as two INDEPENDENT booleans (vertical / horizontal),
 * each actionable on its own and each gated by its own `DeviceFeature`
 * so the UI shows only the axes a given device supports. This is generic
 * — any climate device (not just Gree) can advertise either / both axes.
 */

export const HvacModeSchema = z.enum([
  'off',
  'heat',
  'cool',
  'auto',
  'heat_cool',
  'fan_only',
  'dry',
])
export type HvacMode = z.infer<typeof HvacModeSchema>

export const ClimateControlStatusSchema = z.object({
  /** Active HVAC mode. */
  mode: HvacModeSchema,
  /** Available HVAC modes the device accepts. Subset of HvacMode. */
  availableModes: z.array(HvacModeSchema),
  /** Active fan mode (`auto` / `low` / `medium` / `high` / `on` / `off`
   *  / vendor-specific) — empty string when the device has no fan
   *  surface. */
  fanMode: z.string(),
  /** Available fan modes the device accepts. */
  availableFanModes: z.array(z.string()),
  /** Active preset (`eco` / `away` / `sleep` / vendor-specific) —
   *  empty string when no preset is active or the device has no
   *  preset surface. */
  preset: z.string(),
  /** Available presets the device accepts. */
  availablePresets: z.array(z.string()),
  /** Single setpoint in Celsius. Used by single-target modes
   *  (heat / cool / dry). Null when the device is in a range mode
   *  (`heat_cool`) or has no setpoint at all (`fan_only`/`off`). */
  target: z.number().nullable(),
  /** Upper bound of the dual setpoint in Celsius. Populated only
   *  in `heat_cool` mode. */
  targetHigh: z.number().nullable(),
  /** Lower bound of the dual setpoint in Celsius. Populated only
   *  in `heat_cool` mode. */
  targetLow: z.number().nullable(),
  /** Target relative humidity (0..100). Null when the device has no
   *  humidity control. */
  targetHumidity: z.number().min(0).max(100).nullable(),
  /** Current measured temperature in Celsius. Read-only — pushed by
   *  the device's internal sensor. */
  currentTemp: z.number().nullable(),
  /** Current measured relative humidity (0..100). Read-only. */
  currentHumidity: z.number().min(0).max(100).nullable(),
  /** Vertical louver swing on/off. Null when the device has no vertical
   *  swing surface (gate with `DeviceFeature.ClimateSwingVertical`). */
  swingVertical: z.boolean().nullable(),
  /** Horizontal louver swing on/off. Null when the device has no
   *  horizontal swing surface (gate with `DeviceFeature.ClimateSwingHorizontal`). */
  swingHorizontal: z.boolean().nullable(),
  /** Lowest setpoint the device accepts, Celsius. Absent / null = not reported. */
  minTemp: z.number().nullable().optional(),
  /** Highest setpoint the device accepts, Celsius. Absent / null = not reported. */
  maxTemp: z.number().nullable().optional(),
  /** Setpoint granularity, Celsius (0.5, 1). Absent / null = not reported. */
  tempStep: z.number().positive().nullable().optional(),
  /** Ms epoch when the slice was last updated (push or command). */
  lastFetchedAt: z.number(),
})

export type ClimateControlStatus = z.infer<typeof ClimateControlStatusSchema>

export const climateControlCapability = {
  name: 'climate-control',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Thermostat, DeviceType.Climate],
  methods: {
    setMode: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        mode: HvacModeSchema,
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
    setFanMode: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        fanMode: z.string().min(1),
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
    setTarget: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        target: z.number(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
    setTargetRange: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        targetLow: z.number(),
        targetHigh: z.number(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
    setTargetHumidity: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        targetHumidity: z.number().min(0).max(100),
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
    setSwingVertical: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        on: z.boolean(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
    setSwingHorizontal: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        on: z.boolean(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
  },
  status: {
    schema: ClimateControlStatusSchema,
    kind: 'push',
  },
  /**
   * Runtime-state slice — mirrored by the kernel. UI thermostats read
   * the full slice via `device.state.climate-control.value` and refresh
   * on every push without re-querying the provider.
   */
  runtimeState: ClimateControlStatusSchema,

  /**
   * Runtime-state durability: **session** — as `brightness`; `currentTemp` moves continuously and is re-published on connect.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /**
   * History (D850): recorded series. Celsius by contract; setpoints keep every change (`minIntervalMs: 0`).
   */
  history: {
    fields: {
      currentTemp: { kind: 'gauge', unit: '°C', deadband: 0.1 },
      currentHumidity: { kind: 'gauge', unit: '%', deadband: 0.5 },
      target: { kind: 'gauge', unit: '°C', minIntervalMs: 0 },
      targetHigh: { kind: 'gauge', unit: '°C', minIntervalMs: 0 },
      targetLow: { kind: 'gauge', unit: '°C', minIntervalMs: 0 },
    },
  },
} as const satisfies CapabilityDefinition

export type IClimateControlProvider = InferProvider<typeof climateControlCapability>
