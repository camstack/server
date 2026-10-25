import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import type { CapabilityCustomizeSpec } from './customize-spec.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Ambient illuminance reading in lux. Drives Home Assistant `sensor`
 * entries with `device_class: illuminance`.
 */
export const AmbientLightSensorStatusSchema = z.object({
  /** Current illuminance in lux (lx). */
  lux: z.number().min(0).meta({ unit: 'lx', label: 'Illuminance' }),
  /** Ms epoch when the slice was last updated. */
  lastFetchedAt: z.number(),
  /** Live display unit from the upstream source (e.g. HA
   *  `attributes.unit_of_measurement`). The UI prefers this over the
   *  role's canonical unit. Absent → fall back to the canonical unit. */
  unit: z.string().optional(),
  /** Suggested decimal places for numeric display.
   *  Populated live from the upstream source when provided (e.g. HA
   *  `attributes.suggested_display_precision`). Falls back to
   *  auto-formatting when absent. */
  precision: z.number().int().min(0).max(10).optional(),
})

export type AmbientLightSensorStatus = z.infer<typeof AmbientLightSensorStatusSchema>

/** Advanced rows only (D939). No card target, so a composed device keeps the generic card. */
const ambientLightSensorCustomize = {
  version: 1,
  advanced: 'derive',
  targets: [],
} as const satisfies CapabilityCustomizeSpec

export const ambientLightSensorCapability = {
  name: 'ambient-light-sensor',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Sensor],
  methods: {},
  status: {
    schema: AmbientLightSensorStatusSchema,
    kind: 'push',
  },
  runtimeState: AmbientLightSensorStatusSchema,

  /**
   * Runtime-state durability: **restored** — as `numeric-sensor`.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'restored',
  /**
   * History (D850): recorded series. Wide range, so a RELATIVE deadband (10 %).
   */
  history: {
    fields: {
      lux: { kind: 'gauge', unit: 'lx', deadbandPct: 10, minIntervalMs: 60000 },
    },
  },
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastFetchedAt'],
  customize: ambientLightSensorCustomize,
} as const satisfies CapabilityDefinition

export type IAmbientLightSensorProvider = InferProvider<typeof ambientLightSensorCapability>
