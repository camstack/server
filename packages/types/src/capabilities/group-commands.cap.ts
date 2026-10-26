import { z } from 'zod'
import { DeviceType } from '../device/device-type.js'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'

/**
 * The last command a helper actuator group sent to each member (D944).
 * The composer writes this slice; the aggregate pass does not, so a later
 * reading does not wipe it. History is none — the outcome is the latest
 * attempt, not a series.
 */
export const GroupCommandResultSchema: z.ZodObject<{
  deviceId: z.ZodNumber
  cap: z.ZodString
  method: z.ZodString
  ok: z.ZodBoolean
  error: z.ZodOptional<z.ZodString>
  at: z.ZodNumber
}> = z.object({
  deviceId: z.number().int().nonnegative(),
  cap: z.string().min(1),
  method: z.string().min(1),
  ok: z.boolean(),
  error: z.string().optional(),
  /** Ms epoch of the attempt. */
  at: z.number(),
})
export type GroupCommandResult = z.infer<typeof GroupCommandResultSchema>

export const GroupCommandsSchema: z.ZodObject<{
  results: z.ZodArray<typeof GroupCommandResultSchema>
}> = z.object({
  /** One row per member that has been commanded. A later command replaces that member's row. */
  results: z.array(GroupCommandResultSchema),
})
export type GroupCommands = z.infer<typeof GroupCommandsSchema>

export const groupCommandsCapability = {
  name: 'group-commands',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Switch, DeviceType.Light],
  methods: {},
  status: {
    schema: GroupCommandsSchema,
    kind: 'push',
  },
  runtimeState: GroupCommandsSchema,
  /**
   * Runtime-state durability: **session** — the last attempt. A restored
   * failure would outlive the command that caused it.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  history: 'none',
} as const satisfies CapabilityDefinition

export type IGroupCommandsProvider = InferProvider<typeof groupCommandsCapability>
