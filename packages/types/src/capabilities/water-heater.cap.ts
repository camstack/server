import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'
import { t } from '../device/cap-vocabulary/l10n.js'

/**
 * Water heater / boiler cap. Models HA `water_heater.*` entities — a
 * climate-family actuator with a target temperature, an operation-mode
 * selector (`eco` / `electric` / `gas` / `heat_pump` / `high_demand` /
 * `performance` / `off`), and an optional away-mode toggle.
 *
 * The slice carries the current + target temperature, the active
 * operation mode (HA's `state`) and its available set (HA's
 * `operation_list`), the away flag (HA `away_mode` 'on'/'off' → bool,
 * null when unsupported), plus the `min_temp` / `max_temp` bounds.
 *
 * Providers populate only what the hardware reports — temperature and
 * away fields stay null when the device has no such surface.
 */

export const WaterHeaterStatusSchema = z.object({
  /** Current measured temperature. Null when not reported. */
  currentTemp: z.number().nullable().meta(readingMeta('temperature')),
  /** Target temperature setpoint. Null when no setpoint surface. */
  targetTemp: z.number().nullable().meta(readingMeta('temperature')),
  /** Active operation mode = HA `state` (`eco` / `electric` / `gas` /
   *  `heat_pump` / `high_demand` / `performance` / `off`). Null when the
   *  device reports an unknown state. */
  operationMode: z.string().nullable(),
  /** Available operation modes = HA `operation_list`. */
  availableModes: z.array(z.string()),
  /** Away mode (HA `away_mode` 'on'/'off' → bool). Null when the device
   *  has no away surface. */
  away: z.boolean().nullable(),
  /** HA `min_temp` attribute. Null when not reported. */
  minTemp: z.number().nullable().meta(readingMeta('temperature')),
  /** HA `max_temp` attribute. Null when not reported. */
  maxTemp: z.number().nullable().meta(readingMeta('temperature')),
  /**
   * The last operation mode other than `off` the device reported. Kept by the device-state
   * mirror on every write (providers never set it), so "turn on" can return to it.
   */
  lastActiveMode: z.string().optional(),
  /** Ms epoch when the slice was last updated. */
  lastChangedAt: z.number(),
})

export type WaterHeaterStatus = z.infer<typeof WaterHeaterStatusSchema>

export const waterHeaterCapability = {
  name: 'water-heater',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.WaterHeater],
  power: {
    kind: 'mode',
    field: 'operationMode',
    offValue: 'off',
    set: 'setOperationMode',
    lastField: 'lastActiveMode',
  },
  methods: {
    setOperationMode: method(
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
            id: 'waterHeater.off',
            label: t('Water heater off', 'Scaldacqua spento'),
            phrase: t('Turn off {device}', 'Spegni {device}'),
            icon: 'power-off',
            effect: { field: 'operationMode', value: 'off' },
            args: { mode: 'off' },
          },
          {
            id: 'waterHeater.mode',
            label: t('Set mode', 'Imposta la modalità'),
            phrase: t('Set {device} to {mode}', 'Imposta {device} su {mode}'),
            icon: 'list',
            effect: { field: 'operationMode', fromArg: 'mode' },
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
    setAway: method(
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
            id: 'waterHeater.awayOn',
            label: t('Water heater away on', 'Scaldacqua in modalità assenza'),
            phrase: t('Put {device} in away mode', 'Metti {device} in modalità assenza'),
            icon: 'plane',
            effect: { field: 'away', value: true },
            args: { on: true },
          },
          {
            id: 'waterHeater.awayOff',
            label: t('Water heater away off', 'Scaldacqua fuori dalla modalità assenza'),
            phrase: t('Take {device} out of away mode', 'Togli {device} dalla modalità assenza'),
            icon: 'house',
            effect: { field: 'away', value: false },
            args: { on: false },
          },
        ],
      },
    ),
    setTargetTemp: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        temp: z.number().finite(),
      }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'protected',
        actions: [
          {
            id: 'waterHeater.target',
            label: t('Set temperature', 'Imposta la temperatura'),
            phrase: t(
              'Heat the water of {device} to {temp}',
              'Scalda l’acqua di {device} a {temp}',
            ),
            icon: 'thermometer',
            effect: { field: 'targetTemp', fromArg: 'temp' },
            openArgs: [
              {
                key: 'temp',
                label: t('Temperature', 'Temperatura'),
                offer: { kind: 'number', step: 1, unit: '°C' },
              },
            ],
          },
        ],
      },
    ),
  },
  status: {
    schema: WaterHeaterStatusSchema,
    kind: 'push',
  },
  /**
   * Runtime-state slice — mirrored by the kernel. UI controls watch the
   * slice for live temperature / mode / away changes.
   */
  runtimeState: WaterHeaterStatusSchema,

  /**
   * Runtime-state durability: **session** — as `climate-control`.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'restored',
  restoredStateFields: ['lastActiveMode'],
  /**
   * History (D850): recorded series. The schema carries no unit; providers publish Celsius. Setpoint keeps every change.
   */
  history: {
    fields: {
      currentTemp: { kind: 'gauge', unit: '°C', deadband: 0.5 },
      targetTemp: { kind: 'gauge', unit: '°C', minIntervalMs: 0 },
    },
  },
  vocabulary: {
    noun: t('Water heater', 'Scaldacqua'),
    order: 1100,
    state: [
      {
        kind: 'numeric',
        field: 'currentTemp',
        quantity: t('the water temperature', 'la temperatura dell’acqua'),
        label: t('Water temperature', 'Temperatura dell’acqua'),
        unit: '°C',
        icon: 'thermometer',
      },
      {
        kind: 'boolean',
        field: 'away',
        label: t('Away mode', 'Modalità assenza'),
        whenTrue: t(
          'When {device} goes into away mode',
          'Quando {device} entra in modalità assenza',
        ),
        whenFalse: t(
          'When {device} leaves away mode',
          'Quando {device} esce dalla modalità assenza',
        ),
        icon: 'plane',
      },
      {
        kind: 'value',
        field: 'operationMode',
        label: t('Mode', 'Modalità'),
        offer: { kind: 'dynamic', from: 'status', field: 'availableModes' },
        icon: 'list',
      },
    ],
  },
} as const satisfies CapabilityDefinition

export type IWaterHeaterProvider = InferProvider<typeof waterHeaterCapability>
