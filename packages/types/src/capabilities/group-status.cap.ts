import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'

/**
 * How many members of a helper group answered (D944). Counts are integers,
 * not measurements: zero included is a real count, never a stand-in reading.
 * The reading itself stays on the output capability. History is none — the
 * series that later statistics read is the output cap's own history block.
 */
export const GroupStatusSchema: z.ZodObject<{
  included: z.ZodNumber
  excluded: z.ZodNumber
  total: z.ZodNumber
}> = z.object({
  /** Members whose current value entered the aggregate. */
  included: z
    .number()
    .int()
    .nonnegative()
    .meta(readingMeta('count', { precision: 0, label: 'Reporting' })),
  /** Members left out: offline, unknown, or not a finite reading (D393). */
  excluded: z
    .number()
    .int()
    .nonnegative()
    .meta(readingMeta('count', { precision: 0, label: 'Excluded' })),
  /** `included` + `excluded`. */
  total: z
    .number()
    .int()
    .nonnegative()
    .meta(readingMeta('count', { precision: 0, label: 'Members' })),
})
export type GroupStatus = z.infer<typeof GroupStatusSchema>

export const groupStatusCapability = {
  name: 'group-status',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Sensor, DeviceType.Switch, DeviceType.Light],
  methods: {},
  status: {
    schema: GroupStatusSchema,
    kind: 'push',
  },
  runtimeState: GroupStatusSchema,
  /**
   * Runtime-state durability: **session** — recomputed from members on the
   * next source event; a restored count would outlive the readings it named.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  history: 'none',
} as const satisfies CapabilityDefinition

export type IGroupStatusProvider = InferProvider<typeof groupStatusCapability>
