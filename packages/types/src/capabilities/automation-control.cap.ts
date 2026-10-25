import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Automation-control cap. Models HA `automation.*` entities on
 * `DeviceType.Automation`. An automation is a trigger+condition+
 * action rule that can be enabled / disabled and manually fired
 * via the `trigger` method.
 *
 * `trigger` accepts an optional `skipCondition` flag — when true,
 * the automation's action block runs WITHOUT evaluating its
 * condition block. Pair with `DeviceFeature.AutomationSkipCondition`
 * to gate the UI checkbox for the manual-trigger dialog.
 */

export const AutomationControlStatusSchema = z.object({
  /** Whether the automation is currently enabled. Disabled automations
   *  ignore their trigger block — manual `trigger` still works. */
  enabled: z.boolean(),
  /** Whether the automation is currently executing its action block. */
  isRunning: z.boolean(),
  /** Ms epoch of the last successful run. 0 when never run. */
  lastTriggeredAt: z.number(),
  /** Failure description from the last completed run. Null on success
   *  or when never run. */
  lastError: z.string().nullable(),
  /** Ms epoch when the slice was last updated. */
  lastChangedAt: z.number(),
})

export type AutomationControlStatus = z.infer<typeof AutomationControlStatusSchema>

export const automationControlCapability = {
  name: 'automation-control',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Automation],
  methods: {
    enable: method(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    disable: method(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    trigger: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        /** When true, fires the action block while bypassing the
         *  automation's condition evaluation. Gated by
         *  `DeviceFeature.AutomationSkipCondition`. */
        skipCondition: z.boolean().optional(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),
  },
  status: {
    schema: AutomationControlStatusSchema,
    kind: 'push',
  },
  /**
   * Runtime-state slice — mirrored by the kernel. UI automation tile
   * reads `enabled` (toggle) + `isRunning` (spinner) + `lastError`
   * (badge) directly.
   */
  runtimeState: AutomationControlStatusSchema,

  /**
   * Runtime-state durability: **session** — the authority for an automation being enabled is the automation store; a restored `isRunning` would be a lie. D62: one authority per switch.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /**
   * History (D850): none — configuration and transient run state.
   */
  history: 'none',
} as const satisfies CapabilityDefinition

export type IAutomationControlProvider = InferProvider<typeof automationControlCapability>
