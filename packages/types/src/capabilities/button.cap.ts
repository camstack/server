import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { t } from '../device/cap-vocabulary/l10n.js'

/**
 * button — device-scoped capability for HA `button.*` / `input_button.*`
 * fire-only actuators. A button entity has no readable state — pressing it
 * triggers an action on the HA side. There is no `status` / `runtimeState`:
 * nothing to poll, nothing to subscribe to.
 *
 * Usage: the admin UI renders a single "Press" affordance. The provider calls
 * the HA `button.press` (or `input_button.press`) service. The domain is
 * derived from the entity_id prefix at runtime.
 */
export const buttonCapability = {
  name: 'button',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Button],
  methods: {
    press: method(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'button.press',
          label: t('Press', 'Premi'),
          phrase: t('Press {device}', 'Premi {device}'),
          icon: 'circle-dot',
        },
      ],
    }),
  },
  vocabulary: { noun: t('Button', 'Pulsante'), order: 1130 },
} as const satisfies CapabilityDefinition

export type IButtonProvider = InferProvider<typeof buttonCapability>
