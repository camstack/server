import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'

/**
 * Ambient illuminance reading in lux. Drives Home Assistant `sensor`
 * entries with `device_class: illuminance`.
 */
export const AmbientLightSensorStatusSchema = z.object({
  /** Current illuminance in lux (lx). `null` when the sample was refused (D393). */
  illuminance: z
    .number()
    .min(0)
    .nullable()
    .meta(readingMeta('illuminance', { precision: 0, label: 'Illuminance' })),
  /** Ms epoch when the slice was last updated. */
  lastFetchedAt: z.number(),
})

export type AmbientLightSensorStatus = z.infer<typeof AmbientLightSensorStatusSchema>

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
      illuminance: { kind: 'gauge', unit: 'lx', deadbandPct: 10, minIntervalMs: 60000 },
    },
  },
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastFetchedAt'],
} as const satisfies CapabilityDefinition

export type IAmbientLightSensorProvider = InferProvider<typeof ambientLightSensorCapability>
