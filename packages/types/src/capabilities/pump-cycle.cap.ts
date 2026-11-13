import { z } from 'zod'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { t } from '../device/cap-vocabulary/l10n.js'

/**
 * The on/off duty cycle of a pet fountain's pump. Some models run the pump
 * continuously and have nothing to configure; others can alternate a run time
 * and a rest time. That is model-specific, so it is its own optional cap on the
 * fountain device: a fountain without cycle entities simply never composes it
 * (planning#366), and the `pet-fountain` cap stays the model-independent core.
 *
 * Like `pet-fountain` it has no native vendor provider: an operator BUILDS the
 * cycle from loose entities (a cycle switch and two number boxes) and every
 * method is a forward to one source entity (D659, D967). Durations are stored
 * in SECONDS (D944); a number box that cannot be read back leaves them `null`
 * — unknown, never zero (D393).
 */

export const PumpCycleStatusSchema = z.object({
  /** True when the pump works on the on/off cycle, false when it runs continuously. Null while unknown. */
  enabled: z.boolean().nullable(),
  /** How long the pump runs per cycle, in seconds. Null while unknown. */
  onTime: z.number().min(0).nullable().meta(readingMeta('duration')),
  /** How long the pump rests per cycle, in seconds. Null while unknown. */
  offTime: z.number().min(0).nullable().meta(readingMeta('duration')),
  /** Ms epoch when the slice was last refreshed. */
  lastFetchedAt: z.number(),
})

export type PumpCycleStatus = z.infer<typeof PumpCycleStatusSchema>

const DeviceIdSchema = z.number().int().nonnegative()
const MinutesSchema = z.number().int().min(0)

export const pumpCycleCapability = {
  name: 'pump-cycle',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.PetFountain],
  methods: {
    /** Switch the on/off duty cycle on or off (off = the pump runs continuously). */
    setEnabled: method(z.object({ deviceId: DeviceIdSchema, on: z.boolean() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'pumpCycle.on',
          label: t('Pump cycle on', 'Ciclo pompa attivo'),
          phrase: t(
            'Run the pump of {device} on its on/off cycle',
            'Fai lavorare la pompa di {device} a ciclo acceso/spento',
          ),
          icon: 'timer',
          args: { on: true },
        },
        {
          id: 'pumpCycle.off',
          label: t('Pump cycle off', 'Ciclo pompa spento'),
          phrase: t(
            'Run the pump of {device} continuously',
            'Fai lavorare la pompa di {device} in continuo',
          ),
          icon: 'timer-off',
          args: { on: false },
        },
      ],
    }),
    /** Set how many minutes the pump runs per cycle. */
    setOnMinutes: method(z.object({ deviceId: DeviceIdSchema, minutes: MinutesSchema }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'pumpCycle.onMinutes',
          label: t('Set pump run time', 'Imposta il tempo di lavoro della pompa'),
          phrase: t(
            'Set the pump of {device} to run {minutes} minutes per cycle',
            'Imposta la pompa di {device} a lavorare {minutes} minuti per ciclo',
          ),
          icon: 'timer',
          openArgs: [
            {
              key: 'minutes',
              label: t('Minutes', 'Minuti'),
              offer: { kind: 'number', min: 0, step: 1, unit: 'min' },
            },
          ],
        },
      ],
    }),
    /** Set how many minutes the pump rests per cycle. */
    setOffMinutes: method(
      z.object({ deviceId: DeviceIdSchema, minutes: MinutesSchema }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'protected',
        actions: [
          {
            id: 'pumpCycle.offMinutes',
            label: t('Set pump rest time', 'Imposta il tempo di riposo della pompa'),
            phrase: t(
              'Set the pump of {device} to rest {minutes} minutes per cycle',
              'Imposta la pompa di {device} a riposare {minutes} minuti per ciclo',
            ),
            icon: 'timer-off',
            openArgs: [
              {
                key: 'minutes',
                label: t('Minutes', 'Minuti'),
                offer: { kind: 'number', min: 0, step: 1, unit: 'min' },
              },
            ],
          },
        ],
      },
    ),
  },
  status: {
    schema: PumpCycleStatusSchema,
    kind: 'push',
  },
  /** Runtime-state slice — mirrored by the kernel; the hero card reads it whole. */
  runtimeState: PumpCycleStatusSchema,

  /**
   * Runtime-state durability: **session** — live appliance state re-published on connect.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /** History (D850): a duty-cycle setting is not a series worth recording. */
  history: 'none',
  vocabulary: {
    noun: t('Pump cycle', 'Ciclo della pompa'),
    order: 2050,
    state: [
      {
        kind: 'boolean',
        field: 'enabled',
        label: t('Pump cycle', 'Ciclo pompa'),
        whenTrue: t(
          'When {device} starts running its pump on a cycle',
          'Quando {device} inizia a far lavorare la pompa a ciclo',
        ),
        whenFalse: t(
          'When {device} runs its pump continuously',
          'Quando {device} fa lavorare la pompa in continuo',
        ),
        icon: 'timer',
      },
    ],
  },
} as const satisfies CapabilityDefinition

export type IPumpCycleProvider = InferProvider<typeof pumpCycleCapability>
