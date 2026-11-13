import { z } from 'zod'
import { DeviceType } from '../device/device-type.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'
import { t } from '../device/cap-vocabulary/l10n.js'

/**
 * do-not-disturb - whether a speaker or display holds back its own sounds
 * (announcements, notifications, alarms) until the operator lets it speak again.
 *
 * It is NOT part of `media-player`: a player is about what it plays and how
 * loud, while Do Not Disturb is a household switch the vendor keeps per device.
 * `enabled` is null when the vendor has not said (never a guess of `false`).
 */
export const DoNotDisturbStatusSchema = z.object({
  /** True while Do Not Disturb is on; null when unknown. */
  enabled: z.boolean().nullable().meta({ label: 'Do not disturb' }),
  /** Ms epoch of the last read or write that set `enabled`. */
  lastChangedAt: z.number(),
})

export type DoNotDisturbStatus = z.infer<typeof DoNotDisturbStatusSchema>

export const doNotDisturbCapability = {
  name: 'do-not-disturb',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.MediaPlayer],
  methods: {
    setEnabled: method(z.object({ deviceId: z.number().int(), enabled: z.boolean() }), z.void(), {
      kind: 'mutation',
      // ACTUATION, like `switch.setState`: the caller's device grant governs it.
      auth: 'protected',
      actions: [
        {
          id: 'dnd.on',
          label: t('Do not disturb on', 'Attiva Non disturbare'),
          phrase: t('Turn on Do not disturb on {device}', 'Attiva Non disturbare su {device}'),
          icon: 'bell-off',
          args: { enabled: true },
        },
        {
          id: 'dnd.off',
          label: t('Do not disturb off', 'Disattiva Non disturbare'),
          phrase: t('Turn off Do not disturb on {device}', 'Disattiva Non disturbare su {device}'),
          icon: 'bell',
          args: { enabled: false },
        },
      ],
    }),
  },
  status: { schema: DoNotDisturbStatusSchema, kind: 'push' },
  runtimeState: DoNotDisturbStatusSchema,
  /**
   * Runtime-state durability: **session** - the vendor owns the switch and the
   * device re-reads it on the next poll, so a restored value would only be stale.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /** History (D850): when Do Not Disturb was switched on and off. */
  history: {
    fields: {
      enabled: { kind: 'boolean' },
    },
  },
  vocabulary: {
    noun: t('Do not disturb', 'Non disturbare'),
    order: 2160,
    state: [
      {
        kind: 'boolean',
        field: 'enabled',
        label: t('Do not disturb', 'Non disturbare'),
        whenTrue: t(
          'When Do not disturb turns on on {device}',
          'Quando {device} attiva Non disturbare',
        ),
        whenFalse: t(
          'When Do not disturb turns off on {device}',
          'Quando {device} disattiva Non disturbare',
        ),
        icon: 'bell-off',
      },
    ],
  },
} as const satisfies CapabilityDefinition

export type IDoNotDisturbProvider = InferProvider<typeof doNotDisturbCapability>
