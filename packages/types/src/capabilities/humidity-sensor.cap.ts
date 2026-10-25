import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import type { CapabilityCustomizeSpec } from './customize-spec.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Single-metric humidity reading. Drives Home Assistant `sensor`
 * entries with `device_class: humidity`.
 *
 * Unit normalisation: percent. The canonical display unit (`%`) is a
 * descriptor constant in the UI (ROLE_DESCRIPTOR), not stored in
 * `sourceInfo`.
 */
export const HumiditySensorStatusSchema = z.object({
  /** Current relative humidity, 0..100. */
  percent: z.number().min(0).max(100).meta({ unit: '%', label: 'Humidity' }),
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

export type HumiditySensorStatus = z.infer<typeof HumiditySensorStatusSchema>

/** Advanced rows only (D939). No card target, so a composed device keeps the generic card. */
const humiditySensorCustomize = {
  version: 1,
  advanced: 'derive',
  targets: [],
} as const satisfies CapabilityCustomizeSpec

export const humiditySensorCapability = {
  name: 'humidity-sensor',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Sensor, DeviceType.Thermostat],
  methods: {},
  status: {
    schema: HumiditySensorStatusSchema,
    kind: 'push',
  },
  runtimeState: HumiditySensorStatusSchema,

  /**
   * Runtime-state durability: **restored** — as `numeric-sensor` (67 of 75 writes were the clock alone).
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
      percent: { kind: 'gauge', unit: '%', deadband: 0.5 },
    },
  },
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastFetchedAt'],
  customize: humiditySensorCustomize,
} as const satisfies CapabilityDefinition

export type IHumiditySensorProvider = InferProvider<typeof humiditySensorCapability>
