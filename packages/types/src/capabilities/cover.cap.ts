import { z } from 'zod'
import {
  method,
  type CapabilityDefinition,
  type InferProvider,
  optionalMethod,
} from './capability-definition.js'
import { DeviceType, DeviceRole } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'
import { t } from '../device/cap-vocabulary/l10n.js'

/**
 * Window covering / blinds / garage door / valve cap. Models HA
 * `cover.*` entities — anything that moves between an open and a
 * closed state with optional intermediate positioning and tilt.
 *
 * State follows HA's canonical lifecycle: `open` / `opening` /
 * `closing` / `closed` / `stopped`. `position` (0 closed, 100 open)
 * and `tiltPosition` are nullable — some shutters only support
 * full open/close, some Venetian blinds add tilt but no slat
 * positioning, garage doors are usually positionless. Providers
 * populate only what the hardware reports.
 *
 * The cap intentionally does NOT split tilt into a sibling cap:
 * physical hardware that has tilt always has the main position
 * surface too, so the coupling stays inside one slice + one method
 * group rather than spreading across two registrations.
 *
 * Sub-surface gating paired with `DeviceFeature` flags:
 *   - `CoverPositionable` — intermediate `position` slider
 *   - `CoverTilt` — slat-tilt slider
 *   - `CoverStoppable` — the `stop` control (a no-op `stop` never declares it)
 */

export const CoverStateSchema = z.enum(['open', 'opening', 'closing', 'closed', 'stopped'])
export type CoverState = z.infer<typeof CoverStateSchema>

export const CoverStatusSchema = z.object({
  /** Lifecycle state of the cover. */
  state: CoverStateSchema,
  /** 0 = fully closed, 100 = fully open. Null when the device has
   *  no intermediate position surface. */
  position: z.number().min(0).max(100).nullable().meta(readingMeta('percentage')),
  /** 0 = closed slats, 100 = open slats. Null when no tilt support. */
  tiltPosition: z.number().min(0).max(100).nullable().meta(readingMeta('percentage')),
  /** Ms epoch when the slice was last updated. */
  lastChangedAt: z.number(),
})

export type CoverStatus = z.infer<typeof CoverStatusSchema>

export const coverCapability = {
  name: 'cover',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Cover],
  methods: {
    open: method(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'cover.open',
          label: t('Open', 'Apri'),
          phrase: t('Open {device}', 'Apri {device}'),
          icon: 'arrow-up-to-line',
          effect: { field: 'state', value: 'open' },
        },
      ],
    }),
    close: method(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'cover.close',
          label: t('Close', 'Chiudi'),
          phrase: t('Close {device}', 'Chiudi {device}'),
          icon: 'arrow-down-to-line',
          effect: { field: 'state', value: 'closed' },
        },
      ],
    }),
    stop: optionalMethod(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'cover.stop',
          label: t('Stop', 'Ferma'),
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
            id: 'cover.position',
            label: t('Set position', 'Imposta la posizione'),
            phrase: t(
              'Move {device} to {position} open',
              'Porta {device} al {position} di apertura',
            ),
            icon: 'blinds',
            effect: { field: 'position', fromArg: 'position' },
            openArgs: [
              {
                key: 'position',
                label: t('Position', 'Posizione'),
                offer: { kind: 'number', min: 0, max: 100, step: 1, unit: '%' },
              },
            ],
          },
        ],
      },
    ),
    setTiltPosition: optionalMethod(
      z.object({
        deviceId: z.number().int().nonnegative(),
        tiltPosition: z.number().min(0).max(100),
      }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'protected',
        actions: [
          {
            id: 'cover.tilt',
            label: t('Set tilt', 'Imposta l’inclinazione'),
            phrase: t('Tilt {device} to {tiltPosition}', 'Inclina {device} al {tiltPosition}'),
            icon: 'blinds',
            effect: { field: 'tiltPosition', fromArg: 'tiltPosition' },
            openArgs: [
              {
                key: 'tiltPosition',
                label: t('Tilt', 'Inclinazione'),
                offer: { kind: 'number', min: 0, max: 100, step: 1, unit: '%' },
              },
            ],
          },
        ],
      },
    ),
  },
  status: {
    schema: CoverStatusSchema,
    kind: 'push',
  },
  /**
   * Runtime-state slice — mirrored by the kernel. UI controls watch
   * the slice for live position changes during a move.
   */
  runtimeState: CoverStatusSchema,

  /**
   * Runtime-state durability: **restored** — position survives a restart on the device; the mirror should agree at boot rather than read blank.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'restored',
  /**
   * History (D850): recorded series. Actuator tier: position keeps every tick of a movement.
   */
  history: {
    fields: {
      position: { kind: 'gauge', unit: '%', minIntervalMs: 0 },
    },
  },
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastChangedAt'],
  vocabulary: {
    noun: t('Cover', 'Copertura'),
    order: 1030,
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
        icon: 'blinds',
      },
      {
        kind: 'numeric',
        field: 'position',
        quantity: t('the opening', 'l’apertura'),
        label: t('Position', 'Posizione'),
        unit: '%',
        icon: 'blinds',
      },
    ],
    overrides: {
      byRole: {
        [DeviceRole.CoverGarage]: {
          actions: {
            'cover.open': {
              phrase: t('Open the garage door {device}', 'Apri il garage {device}'),
              icon: 'warehouse',
            },
            'cover.close': {
              phrase: t('Close the garage door {device}', 'Chiudi il garage {device}'),
              icon: 'warehouse',
            },
          },
        },
        [DeviceRole.CoverGate]: {
          actions: {
            'cover.open': {
              phrase: t('Open the gate {device}', 'Apri il cancello {device}'),
              icon: 'fence',
            },
            'cover.close': {
              phrase: t('Close the gate {device}', 'Chiudi il cancello {device}'),
              icon: 'fence',
            },
          },
        },
        [DeviceRole.CoverDoor]: {
          actions: {
            'cover.open': {
              phrase: t('Open the door {device}', 'Apri la porta {device}'),
              icon: 'door-open',
            },
            'cover.close': {
              phrase: t('Close the door {device}', 'Chiudi la porta {device}'),
              icon: 'door-closed',
            },
          },
        },
        [DeviceRole.CoverWindow]: {
          actions: {
            'cover.open': {
              phrase: t('Open the window {device}', 'Apri la finestra {device}'),
              icon: 'app-window',
            },
            'cover.close': {
              phrase: t('Close the window {device}', 'Chiudi la finestra {device}'),
              icon: 'app-window',
            },
          },
        },
        [DeviceRole.CoverShutter]: {
          actions: {
            'cover.open': {
              phrase: t('Raise the shutter {device}', 'Alza la tapparella {device}'),
            },
            'cover.close': {
              phrase: t('Lower the shutter {device}', 'Abbassa la tapparella {device}'),
            },
          },
        },
        [DeviceRole.CoverAwning]: {
          actions: {
            'cover.open': {
              phrase: t('Extend the awning {device}', 'Apri la tenda da sole {device}'),
            },
            'cover.close': {
              phrase: t('Retract the awning {device}', 'Chiudi la tenda da sole {device}'),
            },
          },
        },
      },
    },
  },
} as const satisfies CapabilityDefinition

export type ICoverProvider = InferProvider<typeof coverCapability>
