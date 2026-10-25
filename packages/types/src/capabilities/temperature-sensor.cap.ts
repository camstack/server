import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import type { CapabilityCustomizeSpec } from './customize-spec.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Single-metric temperature reading. Drives Home Assistant `sensor`
 * entries with `device_class: temperature` and any future native
 * thermometer.
 *
 * Unit normalisation: providers convert to Celsius before storing.
 * The slice value is always Celsius so cross-cap aggregators
 * (climate-control's `currentTemp`, energy analytics) can compose
 * without per-source unit fixups. The canonical display unit (`°C`) is
 * a descriptor constant in the UI (ROLE_DESCRIPTOR), not stored in
 * `sourceInfo`.
 *
 * Status `lastFetchedAt` lets staleness-aware consumers detect a
 * frozen feed (provider hung) distinct from a "temperature hasn't
 * changed" steady state.
 */
export const TemperatureSensorStatusSchema = z.object({
  /** Current temperature in Celsius. */
  celsius: z.number().meta({ unit: '°C', label: 'Temperature' }),
  /** Ms epoch when the slice was last updated (push or poll). */
  lastFetchedAt: z.number(),
  /** Live display unit from the upstream source (e.g. HA
   *  `attributes.unit_of_measurement`). The UI prefers this over the
   *  role's canonical unit, so a Fahrenheit feed renders '°F' not '°C'.
   *  Absent → the UI falls back to the role's canonical unit. */
  unit: z.string().optional(),
  /** Suggested decimal places for numeric display.
   *  Populated live from the upstream source when provided (e.g. HA
   *  `attributes.suggested_display_precision`). Falls back to
   *  auto-formatting when absent. */
  precision: z.number().int().min(0).max(10).optional(),
})

export type TemperatureSensorStatus = z.infer<typeof TemperatureSensorStatusSchema>

/** Advanced rows only (D939). No card target, so a composed device keeps the generic card. */
const temperatureSensorCustomize = {
  version: 1,
  advanced: 'derive',
  targets: [],
} as const satisfies CapabilityCustomizeSpec

export const temperatureSensorCapability = {
  name: 'temperature-sensor',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Sensor, DeviceType.Thermostat],
  methods: {},
  status: {
    schema: TemperatureSensorStatusSchema,
    kind: 'push',
  },
  runtimeState: TemperatureSensorStatusSchema,

  /**
   * Runtime-state durability: **restored** — as `numeric-sensor` (69 of 125 writes were the clock alone).
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'restored',
  /**
   * History (D850): recorded series.
   */
  history: {
    fields: {
      celsius: { kind: 'gauge', unit: '°C', deadband: 0.1 },
    },
  },
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastFetchedAt'],
  customize: temperatureSensorCustomize,
} as const satisfies CapabilityDefinition

export type ITemperatureSensorProvider = InferProvider<typeof temperatureSensorCapability>
