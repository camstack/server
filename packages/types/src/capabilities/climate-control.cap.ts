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
 * HVAC / climate control cap. Models the full surface of a HA
 * `climate.*` entity (thermostat, A/C, heat pump, dehumidifier)
 * with a single coherent slice — mode + fan + preset + target +
 * dual-setpoint range + humidity + read-only current readings.
 *
 * Operation modes (`HvacMode`) follow HA's canonical set; not every
 * device supports every mode — the provider rejects unsupported
 * values at runtime. Min/max/step bounds for the setpoint are surfaced
 * via `getOptions` on the provider — they are static per-device hardware
 * properties persisted in the device config blob.
 *
 * `fanMode` / `preset` are free-form strings because device vendors
 * use vastly different vocabularies (`auto`/`low`/`high` vs
 * `quiet`/`normal`/`turbo`; `eco`/`away`/`sleep` vs `home`/`night`).
 * The provider populates `availableFanModes` / `availablePresets`
 * on the slice so the UI renders a closed-list picker.
 *
 * Sub-surface gating paired with `DeviceFeature` flags:
 *   - `ClimateDualSetpoint` — heat_cool dual-target range support
 *   - `ClimateHumidity` — currentHumidity / targetHumidity surfaces
 *   - `ClimateFanMode` — fan-mode selector
 *   - `ClimatePreset` — preset selector
 *   - `ClimateSwingVertical` — vertical louver swing toggle
 *   - `ClimateSwingHorizontal` — horizontal louver swing toggle
 *
 * Swing is modelled as two INDEPENDENT booleans (vertical / horizontal),
 * each actionable on its own and each gated by its own `DeviceFeature`
 * so the UI shows only the axes a given device supports. This is generic
 * — any climate device (not just Gree) can advertise either / both axes.
 */

export const HvacModeSchema = z.enum([
  'off',
  'heat',
  'cool',
  'auto',
  'heat_cool',
  'fan_only',
  'dry',
])
export type HvacMode = z.infer<typeof HvacModeSchema>

export const ClimateControlStatusSchema = z.object({
  /** Active HVAC mode. */
  mode: HvacModeSchema,
  /** Available HVAC modes the device accepts. Subset of HvacMode. */
  availableModes: z.array(HvacModeSchema),
  /** Active fan mode (`auto` / `low` / `medium` / `high` / `on` / `off`
   *  / vendor-specific) — empty string when the device has no fan
   *  surface. */
  fanMode: z.string(),
  /** Available fan modes the device accepts. */
  availableFanModes: z.array(z.string()),
  /** Active preset (`eco` / `away` / `sleep` / vendor-specific) —
   *  empty string when no preset is active or the device has no
   *  preset surface. */
  preset: z.string(),
  /** Available presets the device accepts. */
  availablePresets: z.array(z.string()),
  /** Single setpoint in Celsius. Used by single-target modes
   *  (heat / cool / dry). Null when the device is in a range mode
   *  (`heat_cool`) or has no setpoint at all (`fan_only`/`off`). */
  target: z.number().nullable().meta(readingMeta('temperature')),
  /** Upper bound of the dual setpoint in Celsius. Populated only
   *  in `heat_cool` mode. */
  targetHigh: z.number().nullable().meta(readingMeta('temperature')),
  /** Lower bound of the dual setpoint in Celsius. Populated only
   *  in `heat_cool` mode. */
  targetLow: z.number().nullable().meta(readingMeta('temperature')),
  /** Target relative humidity (0..100). Null when the device has no
   *  humidity control. */
  targetHumidity: z.number().min(0).max(100).nullable().meta(readingMeta('humidity')),
  /** Current measured temperature in Celsius. Read-only — pushed by
   *  the device's internal sensor. */
  currentTemp: z.number().nullable().meta(readingMeta('temperature')),
  /** Current measured relative humidity (0..100). Read-only. */
  currentHumidity: z.number().min(0).max(100).nullable().meta(readingMeta('humidity')),
  /** Vertical louver swing on/off. Null when the device has no vertical
   *  swing surface (gate with `DeviceFeature.ClimateSwingVertical`). */
  swingVertical: z.boolean().nullable(),
  /** Horizontal louver swing on/off. Null when the device has no
   *  horizontal swing surface (gate with `DeviceFeature.ClimateSwingHorizontal`). */
  swingHorizontal: z.boolean().nullable(),
  /** Lowest setpoint the device accepts, Celsius. Absent / null = not reported. */
  minTemp: z.number().nullable().optional().meta(readingMeta('temperature')),
  /** Highest setpoint the device accepts, Celsius. Absent / null = not reported. */
  maxTemp: z.number().nullable().optional().meta(readingMeta('temperature')),
  /** Setpoint granularity, Celsius (0.5, 1). Absent / null = not reported. */
  tempStep: z.number().positive().nullable().optional().meta(readingMeta('temperature')),
  /**
   * The last non-off mode the device reported. Kept by the device-state mirror on every
   * write (providers never set it), so "turn on" can return to it. Absent until the device
   * has reported a running mode.
   */
  lastActiveMode: HvacModeSchema.exclude(['off']).optional(),
  /** Ms epoch when the slice was last updated (push or command). */
  lastFetchedAt: z.number(),
})

export type ClimateControlStatus = z.infer<typeof ClimateControlStatusSchema>

export const climateControlCapability = {
  name: 'climate-control',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Climate],
  power: {
    kind: 'mode',
    field: 'mode',
    offValue: 'off',
    set: 'setMode',
    lastField: 'lastActiveMode',
  },
  methods: {
    setMode: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        mode: HvacModeSchema,
      }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'protected',
        actions: [
          {
            id: 'climate.off',
            label: t('Climate off', 'Clima spento'),
            phrase: t('Turn off {device}', 'Spegni {device}'),
            icon: 'power-off',
            effect: { field: 'mode', value: 'off' },
            args: { mode: 'off' },
          },
          {
            id: 'climate.heat',
            label: t('Heat', 'Riscalda'),
            phrase: t('Set {device} to heat', 'Metti {device} in riscaldamento'),
            icon: 'flame',
            effect: { field: 'mode', value: 'heat' },
            args: { mode: 'heat' },
          },
          {
            id: 'climate.cool',
            label: t('Cool', 'Raffresca'),
            phrase: t('Set {device} to cool', 'Metti {device} in raffrescamento'),
            icon: 'snowflake',
            effect: { field: 'mode', value: 'cool' },
            args: { mode: 'cool' },
          },
          {
            id: 'climate.auto',
            label: t('Climate auto', 'Clima automatico'),
            phrase: t('Set {device} to automatic', 'Metti {device} in automatico'),
            icon: 'thermometer',
            effect: { field: 'mode', value: 'auto' },
            args: { mode: 'auto' },
          },
          {
            id: 'climate.mode',
            label: t('Set mode', 'Imposta la modalità'),
            phrase: t('Set {device} to {mode}', 'Imposta {device} su {mode}'),
            icon: 'thermometer',
            effect: { field: 'mode', fromArg: 'mode' },
            openArgs: [
              {
                key: 'mode',
                label: t('Mode', 'Modalità'),
                offer: {
                  kind: 'enum',
                  values: [
                    { value: 'off', label: t('Off', 'Spento') },
                    { value: 'heat', label: t('Heat', 'Riscaldamento') },
                    { value: 'cool', label: t('Cool', 'Raffrescamento') },
                    { value: 'auto', label: t('Automatic', 'Automatico') },
                    {
                      value: 'heat_cool',
                      label: t('Heat and cool', 'Caldo e freddo'),
                    },
                    {
                      value: 'fan_only',
                      label: t('Fan only', 'Solo ventilazione'),
                    },
                    { value: 'dry', label: t('Dry', 'Deumidificazione') },
                  ],
                },
              },
            ],
          },
        ],
      },
    ),
    setTarget: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        target: z.number(),
      }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'protected',
        actions: [
          {
            id: 'climate.target',
            label: t('Set temperature', 'Imposta la temperatura'),
            phrase: t('Set {device} to {target}', 'Imposta {device} a {target}'),
            icon: 'thermometer',
            effect: { field: 'target', fromArg: 'target' },
            openArgs: [
              {
                key: 'target',
                label: t('Temperature', 'Temperatura'),
                offer: { kind: 'number', step: 0.5, unit: '°C' },
              },
            ],
          },
        ],
      },
    ),
    setTargetRange: optionalMethod(
      z.object({
        deviceId: z.number().int().nonnegative(),
        targetLow: z.number(),
        targetHigh: z.number(),
      }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'protected',
        actions: [
          {
            id: 'climate.targetRange',
            label: t('Set temperature range', 'Imposta l’intervallo di temperatura'),
            phrase: t(
              'Keep {device} between {targetLow} and {targetHigh}',
              'Mantieni {device} tra {targetLow} e {targetHigh}',
            ),
            icon: 'thermometer',
            openArgs: [
              {
                key: 'targetLow',
                label: t('Lowest', 'Minima'),
                offer: { kind: 'number', step: 0.5, unit: '°C' },
              },
              {
                key: 'targetHigh',
                label: t('Highest', 'Massima'),
                offer: { kind: 'number', step: 0.5, unit: '°C' },
              },
            ],
          },
        ],
      },
    ),
    setTargetHumidity: optionalMethod(
      z.object({
        deviceId: z.number().int().nonnegative(),
        targetHumidity: z.number().min(0).max(100),
      }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'protected',
        actions: [
          {
            id: 'climate.targetHumidity',
            label: t('Set humidity', 'Imposta l’umidità'),
            phrase: t(
              'Set the humidity target of {device} to {targetHumidity}',
              'Imposta l’umidità obiettivo di {device} al {targetHumidity}',
            ),
            icon: 'droplets',
            effect: { field: 'targetHumidity', fromArg: 'targetHumidity' },
            openArgs: [
              {
                key: 'targetHumidity',
                label: t('Humidity', 'Umidità'),
                offer: { kind: 'number', min: 0, max: 100, step: 1, unit: '%' },
              },
            ],
          },
        ],
      },
    ),
    setFanMode: optionalMethod(
      z.object({
        deviceId: z.number().int().nonnegative(),
        fanMode: z.string().min(1),
      }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'protected',
        actions: [
          {
            id: 'climate.fanMode',
            label: t('Set fan mode', 'Imposta la ventilazione'),
            phrase: t(
              'Set the fan of {device} to {fanMode}',
              'Imposta la ventilazione di {device} su {fanMode}',
            ),
            icon: 'fan',
            openArgs: [
              {
                key: 'fanMode',
                label: t('Fan mode', 'Ventilazione'),
                offer: {
                  kind: 'dynamic',
                  from: 'status',
                  field: 'availableFanModes',
                },
              },
            ],
          },
        ],
      },
    ),
    setPreset: optionalMethod(
      z.object({
        deviceId: z.number().int().nonnegative(),
        preset: z.string().min(1),
      }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'protected',
        actions: [
          {
            id: 'climate.preset',
            label: t('Set preset', 'Imposta il preset'),
            phrase: t('Set {device} to preset {preset}', 'Imposta {device} sul preset {preset}'),
            icon: 'list',
            openArgs: [
              {
                key: 'preset',
                label: t('Preset', 'Preset'),
                offer: {
                  kind: 'dynamic',
                  from: 'status',
                  field: 'availablePresets',
                },
              },
            ],
          },
        ],
      },
    ),
    setSwingVertical: optionalMethod(
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
            id: 'climate.swingVerticalOn',
            label: t('Vertical swing on', 'Oscillazione verticale attiva'),
            phrase: t(
              'Start the vertical swing of {device}',
              'Attiva l’oscillazione verticale di {device}',
            ),
            icon: 'move-vertical',
            effect: { field: 'swingVertical', value: true },
            args: { on: true },
          },
          {
            id: 'climate.swingVerticalOff',
            label: t('Vertical swing off', 'Oscillazione verticale spenta'),
            phrase: t(
              'Stop the vertical swing of {device}',
              'Ferma l’oscillazione verticale di {device}',
            ),
            icon: 'move-vertical',
            effect: { field: 'swingVertical', value: false },
            args: { on: false },
          },
        ],
      },
    ),
    setSwingHorizontal: optionalMethod(
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
            id: 'climate.swingHorizontalOn',
            label: t('Horizontal swing on', 'Oscillazione orizzontale attiva'),
            phrase: t(
              'Start the horizontal swing of {device}',
              'Attiva l’oscillazione orizzontale di {device}',
            ),
            icon: 'move-horizontal',
            effect: { field: 'swingHorizontal', value: true },
            args: { on: true },
          },
          {
            id: 'climate.swingHorizontalOff',
            label: t('Horizontal swing off', 'Oscillazione orizzontale spenta'),
            phrase: t(
              'Stop the horizontal swing of {device}',
              'Ferma l’oscillazione orizzontale di {device}',
            ),
            icon: 'move-horizontal',
            effect: { field: 'swingHorizontal', value: false },
            args: { on: false },
          },
        ],
      },
    ),
  },
  status: {
    schema: ClimateControlStatusSchema,
    kind: 'push',
  },
  /**
   * Runtime-state slice — mirrored by the kernel. UI thermostats read
   * the full slice via `device.state.climate-control.value` and refresh
   * on every push without re-querying the provider.
   */
  runtimeState: ClimateControlStatusSchema,

  /**
   * Runtime-state durability: **session** — as `brightness`; `currentTemp` moves continuously and is re-published on connect.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'restored',
  restoredStateFields: ['lastActiveMode'],
  /**
   * History (D850): recorded series. Celsius by contract; setpoints keep every change (`minIntervalMs: 0`).
   */
  history: {
    fields: {
      currentTemp: { kind: 'gauge', unit: '°C', deadband: 0.1 },
      currentHumidity: { kind: 'gauge', unit: '%', deadband: 0.5 },
      target: { kind: 'gauge', unit: '°C', minIntervalMs: 0 },
      targetHigh: { kind: 'gauge', unit: '°C', minIntervalMs: 0 },
      targetLow: { kind: 'gauge', unit: '°C', minIntervalMs: 0 },
    },
  },
  vocabulary: {
    noun: t('Climate', 'Clima'),
    order: 1070,
    state: [
      {
        kind: 'enum',
        field: 'mode',
        label: t('Mode', 'Modalità'),
        values: [
          {
            value: 'off',
            label: t('Off', 'Spento'),
            phrase: t('When {device} turns off', 'Quando {device} si spegne'),
          },
          {
            value: 'heat',
            label: t('Heat', 'Riscaldamento'),
            phrase: t('When {device} starts heating', 'Quando {device} passa al riscaldamento'),
          },
          {
            value: 'cool',
            label: t('Cool', 'Raffrescamento'),
            phrase: t('When {device} starts cooling', 'Quando {device} passa al raffrescamento'),
          },
          { value: 'auto', label: t('Automatic', 'Automatico') },
          { value: 'heat_cool', label: t('Heat and cool', 'Caldo e freddo') },
          { value: 'fan_only', label: t('Fan only', 'Solo ventilazione') },
          { value: 'dry', label: t('Dry', 'Deumidificazione') },
        ],
        icon: 'thermometer',
      },
      {
        kind: 'numeric',
        field: 'currentTemp',
        quantity: t('the temperature', 'la temperatura'),
        label: t('Temperature', 'Temperatura'),
        unit: '°C',
        icon: 'thermometer',
      },
      {
        kind: 'numeric',
        field: 'currentHumidity',
        quantity: t('the humidity', 'l’umidità'),
        label: t('Humidity', 'Umidità'),
        unit: '%',
        icon: 'droplets',
      },
      {
        kind: 'numeric',
        field: 'target',
        quantity: t('the set temperature', 'la temperatura impostata'),
        label: t('Set temperature', 'Temperatura impostata'),
        unit: '°C',
        icon: 'thermometer',
      },
    ],
  },
} as const satisfies CapabilityDefinition

export type IClimateControlProvider = InferProvider<typeof climateControlCapability>
