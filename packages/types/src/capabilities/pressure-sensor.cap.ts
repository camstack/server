import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Atmospheric pressure reading in hectopascals. Drives Home Assistant
 * `sensor` entries with `device_class: pressure`.
 *
 * Unit normalisation: hPa. The canonical display unit (`hPa`) is a
 * descriptor constant in the UI (ROLE_DESCRIPTOR), not stored in
 * `sourceInfo`.
 */
export const PressureSensorStatusSchema = z.object({
  /** Current pressure in hPa. */
  hpa: z.number(),
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

export type PressureSensorStatus = z.infer<typeof PressureSensorStatusSchema>

export const pressureSensorCapability = {
  name: 'pressure-sensor',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Sensor],
  methods: {},
  status: {
    schema: PressureSensorStatusSchema,
    kind: 'push',
  },
  runtimeState: PressureSensorStatusSchema,

  /**
   * Runtime-state durability: **restored** — as `numeric-sensor`.
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
      hpa: { kind: 'gauge', unit: 'hPa', deadband: 0.1 },
    },
  },
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastFetchedAt'],
} as const satisfies CapabilityDefinition

export type IPressureSensorProvider = InferProvider<typeof pressureSensorCapability>
