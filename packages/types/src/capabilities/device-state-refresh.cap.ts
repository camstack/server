import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { t } from '../device/cap-vocabulary/l10n.js'
import { StateRefreshReasonSchema } from '../device/state-refresh.js'

/**
 * device-state-refresh — the HOW of a device's state refresh, called by the
 * core, which owns the WHEN (D1062).
 *
 * The provider registers it per device with its policy
 * (`registerNativeCap(cap, provider, { stateRefresh })`). The hub's scheduler
 * calls `refresh` on the schedule, after a command and in the burst that
 * follows it, and `resubscribe` when a push integration fell silent. The
 * provider re-reads and writes the slices it already writes; nothing is
 * returned but completion.
 */
export const DeviceStateRefreshInputSchema = z.object({
  /** The device the call is routed by (one of `deviceIds`). */
  deviceId: z.number().int().nonnegative(),
  /** Every device to re-read: one, or the integration's whole set when the provider batches. */
  deviceIds: z.array(z.number().int().nonnegative()).min(1),
  reason: StateRefreshReasonSchema,
})
export type DeviceStateRefreshInput = z.infer<typeof DeviceStateRefreshInputSchema>

export const DeviceStateResubscribeInputSchema = z.object({
  deviceId: z.number().int().nonnegative(),
})

export const DeviceStateRefreshResultSchema = z.object({ ok: z.literal(true) })

const NOT_OPERATOR_FACING =
  'the core schedules state refreshes itself; an operator never asks for one'

export const deviceStateRefreshCapability = {
  name: 'device-state-refresh',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  methods: {
    /** Re-read a device's state from the source now. */
    refresh: method(DeviceStateRefreshInputSchema, DeviceStateRefreshResultSchema, {
      kind: 'mutation',
      auth: 'admin',
      notOperatorFacing: NOT_OPERATOR_FACING,
    }),
    /** Re-establish a device's live state subscription. */
    resubscribe: method(DeviceStateResubscribeInputSchema, DeviceStateRefreshResultSchema, {
      kind: 'mutation',
      auth: 'admin',
      notOperatorFacing: NOT_OPERATOR_FACING,
    }),
  },
  vocabulary: { noun: t('State refresh', 'Aggiornamento dello stato'), order: 3247 },
} as const satisfies CapabilityDefinition

export type IDeviceStateRefreshProvider = InferProvider<typeof deviceStateRefreshCapability>
