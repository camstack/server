import { z } from 'zod'
import {
  method,
  type CapabilityDefinition,
  type InferProvider,
  optionalMethod,
} from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'
import { t } from '../device/cap-vocabulary/l10n.js'

/**
 * Pipe / water / gas valve cap. Models HA `valve.*` entities — anything
 * that moves between an open and a closed state with optional
 * intermediate positioning.
 *
 * State follows HA's canonical lifecycle: `open` / `opening` /
 * `closing` / `closed` / `stopped`. `position` (0 closed, 100 open) is
 * nullable — some valves only support full open/close, while others
 * report and accept an intermediate position. Providers populate only
 * what the hardware reports.
 *
 * Unlike `cover`, valves have no tilt surface — the cap is the strict
 * open/close + optional position subset of the cover lifecycle.
 *
 * Sub-surface gating paired with a `DeviceFeature` flag:
 *   - `ValvePositionable` — intermediate `position` slider / drag
 */

export const ValveStateSchema = z.enum(['open', 'opening', 'closing', 'closed', 'stopped'])
export type ValveState = z.infer<typeof ValveStateSchema>

export const ValveStatusSchema = z.object({
  /** Lifecycle state of the valve. */
  state: ValveStateSchema,
  /** 0 = fully closed, 100 = fully open. Null when the device has no
   *  intermediate position surface. */
  position: z.number().min(0).max(100).nullable().meta(readingMeta('percentage')),
  /** Ms epoch when the slice was last updated. */
  lastChangedAt: z.number(),
})

export type ValveStatus = z.infer<typeof ValveStatusSchema>

export const valveCapability = {
  name: 'valve',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Valve],
  methods: {
    open: method(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'valve.open',
          label: t('Open valve', 'Apri la valvola'),
          phrase: t('Open {device}', 'Apri {device}'),
          icon: 'droplets',
          effect: { field: 'state', value: 'open' },
        },
      ],
    }),
    close: method(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'valve.close',
          label: t('Close valve', 'Chiudi la valvola'),
          phrase: t('Close {device}', 'Chiudi {device}'),
          icon: 'droplet-off',
          effect: { field: 'state', value: 'closed' },
        },
      ],
    }),
    stop: method(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'valve.stop',
          label: t('Stop valve', 'Ferma la valvola'),
          phrase: t('Stop {device}', 'Ferma {device}'),
          icon: 'square',
        },
      ],
    }),
    setPosition: optionalMethod(
      z.object({
        deviceId: z.number().int().nonnegative(),
        position: z.number().min(0).max(100),
      }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'protected',
        actions: [
          {
            id: 'valve.position',
            label: t('Set opening', 'Imposta l’apertura'),
            phrase: t('Open {device} to {position}', 'Apri {device} al {position}'),
            icon: 'droplets',
            effect: { field: 'position', fromArg: 'position' },
            openArgs: [
              {
                key: 'position',
                label: t('Opening', 'Apertura'),
                offer: { kind: 'number', min: 0, max: 100, step: 1, unit: '%' },
              },
            ],
          },
        ],
      },
    ),
  },
  status: {
    schema: ValveStatusSchema,
    kind: 'push',
  },
  /**
   * Runtime-state slice — mirrored by the kernel. UI controls watch the
   * slice for live position changes during a move.
   */
  runtimeState: ValveStatusSchema,

  /**
   * Runtime-state durability: **session** — as `brightness`.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /**
   * History (D850): recorded series. Actuator tier: position keeps every change.
   */
  history: {
    fields: {
      position: { kind: 'gauge', unit: '%', minIntervalMs: 0 },
    },
  },
  vocabulary: {
    noun: t('Valve', 'Valvola'),
    order: 1040,
    state: [
      {
        kind: 'enum',
        field: 'state',
        label: t('State', 'Stato'),
        values: [
          {
            value: 'open',
            label: t('Open', 'Aperto'),
            phrase: t('When {device} is fully open', 'Quando {device} è tutto aperto'),
          },
          {
            value: 'opening',
            label: t('Opening', 'In apertura'),
            phrase: t('When {device} starts opening', 'Quando {device} inizia ad aprirsi'),
          },
          {
            value: 'closing',
            label: t('Closing', 'In chiusura'),
            phrase: t('When {device} starts closing', 'Quando {device} inizia a chiudersi'),
          },
          {
            value: 'closed',
            label: t('Closed', 'Chiuso'),
            phrase: t('When {device} is fully closed', 'Quando {device} è tutto chiuso'),
          },
          {
            value: 'stopped',
            label: t('Stopped', 'Fermo'),
            phrase: t('When {device} stops part-way', 'Quando {device} si ferma a metà'),
          },
        ],
        icon: 'droplets',
      },
      {
        kind: 'numeric',
        field: 'position',
        quantity: t('the opening', 'l’apertura'),
        label: t('Opening', 'Apertura'),
        unit: '%',
        icon: 'droplets',
      },
    ],
  },
} as const satisfies CapabilityDefinition

export type IValveProvider = InferProvider<typeof valveCapability>
