import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'
import { t } from '../device/cap-vocabulary/l10n.js'

/**
 * Robotic lawn-mower cap. Models HA `lawn_mower.*` entities — anything
 * with a mowing lifecycle plus a dock action.
 *
 * Activity follows HA's canonical lawn-mower lifecycle: `idle` /
 * `mowing` / `paused` / `docked` / `error`. `batteryLevel` (0..100) is
 * nullable — some mowers don't report a battery percentage.
 *
 * `startMowing` begins a mowing run, `pause` halts it in place, and
 * `dock` sends the mower back to its charging station.
 */

export const LawnMowerActivitySchema = z.enum(['idle', 'mowing', 'paused', 'docked', 'error'])
export type LawnMowerActivity = z.infer<typeof LawnMowerActivitySchema>

/** Severity of the current device/error code — info (status), warning, error. */
export const DeviceCodeSeveritySchema = z.enum(['info', 'warning', 'error'])
export type DeviceCodeSeverity = z.infer<typeof DeviceCodeSeveritySchema>

export const LawnMowerControlStatusSchema = z.object({
  /** Lifecycle activity of the mower. */
  activity: LawnMowerActivitySchema,
  /** 0..100 battery percentage. Null when the device has no battery
   *  reading. */
  batteryLevel: z.number().min(0).max(100).nullable().meta(readingMeta('percentage')),
  /** 0..100 mowing-completion percentage of the current task, or null when no
   *  task is active / progress is unavailable. */
  progress: z.number().min(0).max(100).nullable().meta(readingMeta('percentage')),
  /** Current device/event code (dynamic — mostly status, sometimes an error),
   *  or null when unknown. */
  currentCode: z.number().nullable().meta(readingMeta('none')),
  /** Human label for {@link currentCode}, or null when undecodable. */
  currentCodeLabel: z.string().nullable(),
  /** Severity of {@link currentCode}. `error` (and often `warning`) warrants UI
   *  attention; `info` is normal status. */
  severity: DeviceCodeSeveritySchema,
  /** Ms epoch when the slice was last updated. */
  lastChangedAt: z.number(),
})

export type LawnMowerControlStatus = z.infer<typeof LawnMowerControlStatusSchema>

export const lawnMowerControlCapability = {
  name: 'lawn-mower-control',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.LawnMower],
  methods: {
    startMowing: method(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'lawnMower.start',
          label: t('Start mowing', 'Avvia il taglio'),
          phrase: t('Start {device} mowing', 'Fai partire il taglio di {device}'),
          icon: 'play',
        },
      ],
    }),
    pause: method(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'lawnMower.pause',
          label: t('Pause mower', 'Metti in pausa il tosaerba'),
          phrase: t('Pause {device}', 'Metti in pausa {device}'),
          icon: 'pause',
        },
      ],
    }),
    dock: method(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'lawnMower.dock',
          label: t('Dock mower', 'Riporta alla base'),
          phrase: t('Send {device} back to its dock', 'Rimanda {device} alla base'),
          icon: 'house',
        },
      ],
    }),
  },
  status: {
    schema: LawnMowerControlStatusSchema,
    kind: 'push',
  },
  /**
   * Runtime-state slice — mirrored by the kernel. UI controls watch the
   * slice for live activity + battery changes.
   */
  runtimeState: LawnMowerControlStatusSchema,

  /**
   * Runtime-state durability: **session** — as `vacuum-control`.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /**
   * History (D850): recorded series.
   */
  history: {
    fields: {
      batteryLevel: { kind: 'gauge', unit: '%', deadband: 2 },
    },
  },
  vocabulary: {
    noun: t('Robot mower', 'Robot tosaerba'),
    order: 2010,
    state: [
      {
        kind: 'enum',
        field: 'activity',
        label: t('Activity', 'Attività'),
        values: [
          { value: 'idle', label: t('Idle', 'Inattivo') },
          {
            value: 'mowing',
            label: t('Mowing', 'In taglio'),
            phrase: t('When {device} starts mowing', 'Quando {device} inizia a tagliare'),
          },
          { value: 'paused', label: t('Paused', 'In pausa') },
          {
            value: 'docked',
            label: t('Docked', 'Alla base'),
            phrase: t('When {device} docks', 'Quando {device} arriva alla base'),
          },
          {
            value: 'error',
            label: t('Error', 'Errore'),
            phrase: t('When {device} reports an error', 'Quando {device} segnala un errore'),
          },
        ],
        icon: 'bot',
      },
      {
        kind: 'numeric',
        field: 'batteryLevel',
        quantity: t('the battery level', 'il livello della batteria'),
        label: t('Battery', 'Batteria'),
        unit: '%',
        icon: 'battery',
      },
    ],
  },
} as const satisfies CapabilityDefinition

export type ILawnMowerControlProvider = InferProvider<typeof lawnMowerControlCapability>
