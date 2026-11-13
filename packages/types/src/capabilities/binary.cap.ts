import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType, DeviceRole } from '../device/device-type.js'
import { t } from '../device/cap-vocabulary/l10n.js'

/**
 * Generic boolean sensor — last-resort fallback when no domain-
 * specific binary cap fits (Home Assistant `binary_sensor` without a
 * known `device_class`, or a domain we haven't typed yet). Pure
 * pass-through: just the bool + timestamp. Push-driven.
 *
 * Prefer the typed alternatives (`contact`, `flood`, `smoke`,
 * `carbon-monoxide`, `gas`, `tamper`, `vibration`, `connectivity`,
 * `motion`) when the semantics match — export adapters render those
 * with the right HomeKit / Alexa display category.
 */
export const BinaryStatusSchema = z.object({
  on: z.boolean().meta({ label: 'On' }),
  /** Ms epoch of the last transition. 0 if never observed. */
  lastChangedAt: z.number(),
})

export type BinaryStatus = z.infer<typeof BinaryStatusSchema>

export const binaryCapability = {
  name: 'binary',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Sensor],
  methods: {},
  status: {
    schema: BinaryStatusSchema,
    kind: 'push',
  },
  runtimeState: BinaryStatusSchema,

  /**
   * Runtime-state durability: **restored** — transition-driven sensor state; the restored value gives the boot comparison.
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
      on: { kind: 'boolean' },
    },
  },
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastChangedAt'],
  vocabulary: {
    noun: t('Binary sensor', 'Sensore binario'),
    order: 5020,
    state: [
      {
        kind: 'boolean',
        field: 'on',
        label: t('On', 'Acceso'),
        whenTrue: t('When {device} turns active', 'Quando {device} si attiva'),
        whenFalse: t('When {device} turns inactive', 'Quando {device} si disattiva'),
        icon: 'toggle-right',
      },
    ],
    overrides: {
      byRole: {
        [DeviceRole.MotionSensor]: {
          state: {
            on: {
              label: t('Motion', 'Movimento'),
              whenTrue: t('When {device} detects motion', 'Quando {device} rileva movimento'),
              whenFalse: t(
                'When motion clears on {device}',
                'Quando il movimento su {device} cessa',
              ),
              icon: 'activity',
            },
          },
        },
        [DeviceRole.ContactSensor]: {
          state: {
            on: {
              label: t('Open', 'Aperto'),
              whenTrue: t('When {device} opens', 'Quando {device} si apre'),
              whenFalse: t('When {device} closes', 'Quando {device} si chiude'),
              icon: 'door-open',
            },
          },
        },
        [DeviceRole.LeakSensor]: {
          state: {
            on: {
              label: t('Leak', 'Perdita'),
              whenTrue: t('When {device} detects a leak', 'Quando {device} rileva una perdita'),
              whenFalse: t('When {device} is dry again', 'Quando {device} torna asciutto'),
              icon: 'droplets',
            },
          },
        },
        [DeviceRole.SmokeSensor]: {
          state: {
            on: {
              label: t('Smoke', 'Fumo'),
              whenTrue: t('When {device} detects smoke', 'Quando {device} rileva fumo'),
              whenFalse: t('When smoke clears on {device}', 'Quando il fumo su {device} si dirada'),
              icon: 'alarm-smoke',
            },
          },
        },
        [DeviceRole.COSensor]: {
          state: {
            on: {
              label: t('Carbon monoxide', 'Monossido di carbonio'),
              whenTrue: t(
                'When {device} detects carbon monoxide',
                'Quando {device} rileva monossido di carbonio',
              ),
              whenFalse: t(
                'When the carbon monoxide clears on {device}',
                'Quando il monossido su {device} rientra',
              ),
              icon: 'cloud-alert',
            },
          },
        },
        [DeviceRole.GasSensor]: {
          state: {
            on: {
              label: t('Gas', 'Gas'),
              whenTrue: t('When {device} detects gas', 'Quando {device} rileva gas'),
              whenFalse: t('When the gas clears on {device}', 'Quando il gas su {device} rientra'),
              icon: 'flame',
            },
          },
        },
        [DeviceRole.TamperSensor]: {
          state: {
            on: {
              label: t('Tampered', 'Manomesso'),
              whenTrue: t('When {device} is tampered with', 'Quando {device} viene manomesso'),
              whenFalse: t(
                'When the tamper alert on {device} clears',
                'Quando l’allarme di manomissione di {device} rientra',
              ),
              icon: 'shield-alert',
            },
          },
        },
        [DeviceRole.VibrationSensor]: {
          state: {
            on: {
              label: t('Vibration', 'Vibrazione'),
              whenTrue: t('When {device} vibrates', 'Quando {device} vibra'),
              whenFalse: t('When {device} is still again', 'Quando {device} torna fermo'),
              icon: 'vibrate',
            },
          },
        },
        [DeviceRole.ConnectivitySensor]: {
          state: {
            on: {
              label: t('Connected', 'Connesso'),
              whenTrue: t('When {device} connects', 'Quando {device} si connette'),
              whenFalse: t('When {device} disconnects', 'Quando {device} si disconnette'),
              icon: 'wifi',
            },
          },
        },
        [DeviceRole.SoundSensor]: {
          state: {
            on: {
              label: t('Sound', 'Suono'),
              whenTrue: t('When {device} hears a sound', 'Quando {device} sente un suono'),
              whenFalse: t('When {device} is quiet again', 'Quando {device} torna silenzioso'),
              icon: 'ear',
            },
          },
        },
        [DeviceRole.BatterySensor]: {
          state: {
            on: {
              label: t('Battery low', 'Batteria scarica'),
              whenTrue: t(
                'When the battery of {device} runs low',
                'Quando la batteria di {device} si scarica',
              ),
              whenFalse: t(
                'When the battery of {device} is fine again',
                'Quando la batteria di {device} torna a posto',
              ),
              icon: 'battery-low',
            },
          },
        },
        [DeviceRole.BinaryHelper]: {
          state: {
            on: {
              label: t('On', 'Acceso'),
              whenTrue: t('When {device} turns on', 'Quando {device} si accende'),
              whenFalse: t('When {device} turns off', 'Quando {device} si spegne'),
              icon: 'toggle-right',
            },
          },
        },
      },
    },
  },
} as const satisfies CapabilityDefinition

export type IBinaryProvider = InferProvider<typeof binaryCapability>
