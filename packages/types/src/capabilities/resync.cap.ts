import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { z } from 'zod'
import { DeviceType } from '../device/device-type.js'
import { t } from '../device/cap-vocabulary/l10n.js'
import { ResyncResultSchema } from './device-adoption.cap.js'

/**
 * resync — a device whose derived spec can be re-aligned on demand with its
 * upstream source (#459, Q6). Registered by the containers an integration
 * adopted; `DeviceFeature.Resyncable` (the generic Re-sync button) is derived
 * from it being bound with `resync` implemented.
 *
 * The work itself stays where it is: the owning addon's `device-adoption`
 * provider, reached through `deviceManager.adoptionResync` (which also owns
 * the "resync from zero" child purge). A provider answers this method by
 * asking for exactly that — see `resyncThroughAdoption`.
 */
export const ResyncDeviceInputSchema = z.object({
  deviceId: z.number().int().nonnegative(),
  /** "Resync from zero": purge the accessory children before re-deriving. */
  resetToSource: z.boolean().optional(),
})

export const resyncCapability = {
  name: 'resync',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Container],
  methods: {
    resync: method(ResyncDeviceInputSchema, ResyncResultSchema, {
      kind: 'mutation',
      auth: 'admin',
      notOperatorFacing:
        'device adoption — re-aligning a device with its source is an onboarding step, not an automation action',
    }),
  },
  vocabulary: { noun: t('Re-sync', 'Risincronizzazione'), order: 3245 },
} as const satisfies CapabilityDefinition

export type IResyncProvider = InferProvider<typeof resyncCapability>
