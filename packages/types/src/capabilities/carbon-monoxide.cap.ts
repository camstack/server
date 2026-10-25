import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Carbon-monoxide alarm sensor. Drives Home Assistant `binary_sensor`
 * entries with `device_class: carbon_monoxide`. Push-driven.
 */
export const CarbonMonoxideStatusSchema = z.object({
  detected: z.boolean(),
  /** Ms epoch of the last transition. 0 if never observed. */
  lastChangedAt: z.number(),
})

export type CarbonMonoxideStatus = z.infer<typeof CarbonMonoxideStatusSchema>

export const carbonMonoxideCapability = {
  name: 'carbon-monoxide',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Sensor],
  methods: {},
  status: {
    schema: CarbonMonoxideStatusSchema,
    kind: 'push',
  },
  runtimeState: CarbonMonoxideStatusSchema,

  /**
   * Runtime-state durability: **restored** — as `smoke`.
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
      detected: { kind: 'boolean' },
    },
  },
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastChangedAt'],
} as const satisfies CapabilityDefinition

export type ICarbonMonoxideProvider = InferProvider<typeof carbonMonoxideCapability>
