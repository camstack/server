import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'

/**
 * A monotonic total between resets (D944). Energy uses `power-meter.energy`
 * so dashboards keep one series; every other instantaneous reading lands here.
 * `value` is the time integral in the source quantity's accumulated base
 * (base-unit seconds, or kWh on the power meter). `null` is a gap, never zero.
 */
export const MeterStatusSchema = z.object({
  value: z
    .number()
    .nullable()
    .meta(readingMeta('device', { label: 'Total' })),
  lastFetchedAt: z.number(),
})
export type MeterStatus = z.infer<typeof MeterStatusSchema>

export const meterCapability = {
  name: 'meter',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Sensor],
  methods: {},
  status: {
    schema: MeterStatusSchema,
    kind: 'push',
  },
  runtimeState: MeterStatusSchema,
  /**
   * Runtime-state durability: **restored** — the total is a cache of the
   * history integral. A restart shows it only until the history pass
   * recomputes the open period; it is not an in-memory buffer.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'restored',
  history: {
    fields: {
      value: { kind: 'counter', deadband: 0.001, minIntervalMs: 60000 },
    },
  },
  volatileStateFields: ['lastFetchedAt'],
} as const satisfies CapabilityDefinition

export type IMeterProvider = InferProvider<typeof meterCapability>
