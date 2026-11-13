import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'
import { t } from '../device/cap-vocabulary/l10n.js'

/**
 * Humidifier / dehumidifier cap. Models HA `humidifier.*` entities —
 * an on/off actuator with an optional target-humidity setpoint and an
 * optional vendor mode (`auto` / `normal` / `baby` / …).
 *
 * A climate-family sibling: the slice carries the on/off state, the
 * current + target relative humidity (0..100), the active mode and its
 * available set, plus HA's free-form `action` readout
 * (`humidifying` / `drying` / `idle` / `off`). `minHumidity` /
 * `maxHumidity` mirror HA's `min_humidity` / `max_humidity` attributes
 * (null → the UI falls back to a 0..100 range).
 *
 * Providers populate only what the hardware reports — `mode` and the
 * humidity fields stay null when the device has no such surface.
 */

export const HumidifierStatusSchema = z.object({
  /** Whether the humidifier is currently on. */
  on: z.boolean(),
  /** Current measured relative humidity (0..100). Null when not reported. */
  currentHumidity: z.number().min(0).max(100).nullable().meta(readingMeta('humidity')),
  /** Target relative humidity (0..100). Null when no setpoint surface. */
  targetHumidity: z.number().min(0).max(100).nullable().meta(readingMeta('humidity')),
  /** Active mode (`auto` / `normal` / `baby` / vendor). Null when the
   *  device has no mode surface. */
  mode: z.string().nullable(),
  /** Available modes the device accepts. */
  availableModes: z.array(z.string()),
  /** HA `action` attribute, verbatim (`humidifying` / `drying` /
   *  `idle` / `off`). Null when the device doesn't report it. */
  action: z.string().nullable(),
  /** HA `min_humidity` attribute. Null → UI uses 0. */
  minHumidity: z.number().nullable().meta(readingMeta('humidity')),
  /** HA `max_humidity` attribute. Null → UI uses 100. */
  maxHumidity: z.number().nullable().meta(readingMeta('humidity')),
  /** Ms epoch when the slice was last updated. */
  lastChangedAt: z.number(),
})

export type HumidifierStatus = z.infer<typeof HumidifierStatusSchema>

export const humidifierCapability = {
  name: 'humidifier',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Humidifier],
  power: { kind: 'field', field: 'on', set: 'setOn' },
  methods: {
    setOn: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        on: z.boolean(),
      }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'protected',
        actions: [
          {
            id: 'humidifier.on',
            label: t('Humidifier on', 'Umidificatore acceso'),
            phrase: t('Turn on {device}', 'Accendi {device}'),
            icon: 'power',
            effect: { field: 'on', value: true },
            args: { on: true },
          },
          {
            id: 'humidifier.off',
            label: t('Humidifier off', 'Umidificatore spento'),
            phrase: t('Turn off {device}', 'Spegni {device}'),
            icon: 'power-off',
            effect: { field: 'on', value: false },
            args: { on: false },
          },
        ],
      },
    ),
    setTargetHumidity: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        humidity: z.number().min(0).max(100),
      }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'protected',
        actions: [
          {
            id: 'humidifier.target',
            label: t('Set humidity', 'Imposta l’umidità'),
            phrase: t(
              'Set {device} to {humidity} humidity',
              'Imposta {device} al {humidity} di umidità',
            ),
            icon: 'droplets',
            effect: { field: 'targetHumidity', fromArg: 'humidity' },
            openArgs: [
              {
                key: 'humidity',
                label: t('Humidity', 'Umidità'),
                offer: { kind: 'number', min: 0, max: 100, step: 1, unit: '%' },
              },
            ],
          },
        ],
      },
    ),
    setMode: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        mode: z.string().min(1),
      }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'protected',
        actions: [
          {
            id: 'humidifier.mode',
            label: t('Set mode', 'Imposta la modalità'),
            phrase: t('Set {device} to {mode}', 'Imposta {device} su {mode}'),
            icon: 'list',
            effect: { field: 'mode', fromArg: 'mode' },
            openArgs: [
              {
                key: 'mode',
                label: t('Mode', 'Modalità'),
                offer: {
                  kind: 'dynamic',
                  from: 'status',
                  field: 'availableModes',
                },
              },
            ],
          },
        ],
      },
    ),
  },
  status: {
    schema: HumidifierStatusSchema,
    kind: 'push',
  },
  /**
   * Runtime-state slice — mirrored by the kernel. UI controls watch the
   * slice for live humidity / mode changes.
   */
  runtimeState: HumidifierStatusSchema,

  /**
   * Runtime-state durability: **session** — as `climate-control`.
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
      currentHumidity: { kind: 'gauge', unit: '%', deadband: 0.5 },
      on: { kind: 'boolean' },
    },
  },
  vocabulary: {
    noun: t('Humidifier', 'Umidificatore'),
    order: 1090,
    state: [
      {
        kind: 'boolean',
        field: 'on',
        label: t('On', 'Acceso'),
        whenTrue: t('When {device} turns on', 'Quando {device} si accende'),
        whenFalse: t('When {device} turns off', 'Quando {device} si spegne'),
        icon: 'power',
      },
      {
        kind: 'numeric',
        field: 'currentHumidity',
        quantity: t('the humidity', 'l’umidità'),
        label: t('Humidity', 'Umidità'),
        unit: '%',
        icon: 'droplets',
      },
    ],
  },
} as const satisfies CapabilityDefinition

export type IHumidifierProvider = InferProvider<typeof humidifierCapability>
