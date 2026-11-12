/**
 * The climate family's contributions to a hero (D1023): `climate-control`,
 * `water-heater`, `heating-valve`, and the read-only sensors. Capabilities
 * contribute, types never do (D14). A slice that is absent or does not parse is
 * "not answered": the state reads unknown, no row is drawn (D315, D393).
 */
import { AirQualitySensorStatusSchema } from '../../capabilities/air-quality-sensor.cap.js'
import { AmbientLightSensorStatusSchema } from '../../capabilities/ambient-light-sensor.cap.js'
import { CarbonMonoxideStatusSchema } from '../../capabilities/carbon-monoxide.cap.js'
import {
  ClimateControlStatusSchema,
  type HvacMode,
} from '../../capabilities/climate-control.cap.js'
import { EnumSensorStatusSchema } from '../../capabilities/enum-sensor.cap.js'
import { HeatingValveStatusSchema } from '../../capabilities/heating-valve.cap.js'
import { HumiditySensorStatusSchema } from '../../capabilities/humidity-sensor.cap.js'
import { NumericSensorStatusSchema } from '../../capabilities/numeric-sensor.cap.js'
import { PressureSensorStatusSchema } from '../../capabilities/pressure-sensor.cap.js'
import { TemperatureSensorStatusSchema } from '../../capabilities/temperature-sensor.cap.js'
import { WaterHeaterStatusSchema } from '../../capabilities/water-heater.cap.js'
import { DeviceFeature } from '../device-type.js'
import {
  action,
  contribution,
  fact,
  measured,
  reading,
  type HeroContribution,
} from './hero-contribution-kit.js'
import type { HeroFragment } from './hero-fragment.js'
import {
  emptyMeasurement,
  humidityMeasurement,
  temperatureMeasurement,
  textMeasurement,
} from './hero-measurement.js'
import type { HeroControl, HeroFact, HeroRow, HeroSideTile } from './hero-model.js'
import type { HeroSceneMode } from './hero-scene.js'
import { heroText, type HeroText } from './hero-text.js'
import {
  climateStatusText,
  deriveClimateView,
  fanLabelOf,
  modeLabelsOf,
  formatDegrees,
  levelWithin,
  rangeFrom,
  thermalStatusText,
  type ClimateSetpointRange,
} from './climate-view.js'

const same = (text: string): HeroText => heroText(text, text)

function tile(en: string, it: string, value: string): HeroSideTile {
  return { label: heroText(en, it), value: same(value) }
}

function setpointSlider(
  id: string,
  cap: string,
  method: string,
  valueArg: string,
  value: number | null,
  range: ClimateSetpointRange,
): HeroControl {
  return {
    kind: 'slider',
    id,
    label: heroText('Target', 'Obiettivo'),
    value,
    min: range.min,
    max: range.max,
    step: range.step,
    unit: '°',
    call: { cap, method, args: {} },
    valueArg,
  }
}

function setpointRow(status: HeroText | null, slider: HeroControl | null): readonly HeroRow[] {
  return slider === null
    ? []
    : [{ id: 'setpoint', icon: 'thermometer', status, controls: [slider] }]
}

// ── climate-control ────────────────────────────────────────────────────────

const climateContribution = contribution(
  'climate-control',
  ClimateControlStatusSchema,
  (slice, ctx): HeroFragment => {
    if (slice === undefined) return { reading: reading('climate-control', 'unknown') }
    const view = deriveClimateView(slice)
    const status = climateStatusText(view)
    const facts: HeroFact[] = []
    if (status !== null) facts.push(fact('climate', 'thermometer', status))
    if (view.humidity !== null) {
      facts.push(fact('humidity', 'droplets', same(`${Math.round(view.humidity)}%`)))
    }
    if (view.targetHumidity !== null) {
      facts.push(fact('humidity', 'droplets', same(`→ ${Math.round(view.targetHumidity)}%`)))
    }
    const left: HeroSideTile[] = []
    const right: HeroSideTile[] = []
    if (view.measured !== null) left.push(tile('Indoor', 'In casa', formatDegrees(view.measured)))
    if (view.humidity !== null) {
      left.push(tile('Humidity', 'Umidità', `${Math.round(view.humidity)}%`))
    }

    const modeControls: HeroControl[] = [
      {
        kind: 'picker',
        id: 'climate.mode',
        label: heroText('Mode', 'Modalità'),
        current: view.mode,
        // "Off" is a mode here: the card draws no separate power row, the last segment switches the device off.
        options: [
          ...view.availableModes.filter((m) => m !== 'off'),
          ...view.availableModes.filter((m) => m === 'off'),
        ],
        optionLabels: modeLabelsOf(view.availableModes),
        call: { cap: 'climate-control', method: 'setMode', args: {} },
        valueArg: 'mode',
      },
    ]
    if (slice.availablePresets.length > 0) {
      modeControls.push({
        kind: 'picker',
        id: 'climate.preset',
        label: heroText('Preset', 'Preset'),
        current: slice.preset === '' ? null : slice.preset,
        options: [...slice.availablePresets],
        call: { cap: 'climate-control', method: 'setPreset', args: {} },
        valueArg: 'preset',
      })
    }
    const fanControls: HeroControl[] = []
    if (slice.availableFanModes.length > 0) {
      fanControls.push({
        kind: 'picker',
        id: 'climate.fan',
        label: heroText('Fan', 'Ventola'),
        current: slice.fanMode === '' ? null : slice.fanMode,
        options: [...slice.availableFanModes],
        optionLabels: Object.fromEntries(slice.availableFanModes.map((m) => [m, fanLabelOf(m)])),
        call: { cap: 'climate-control', method: 'setFanMode', args: {} },
        valueArg: 'fanMode',
      })
    }
    const swing = (
      id: string,
      en: string,
      it: string,
      method: string,
      on: boolean | null,
      feature: DeviceFeature,
    ): HeroControl[] =>
      ctx.features.includes(feature)
        ? [
            {
              kind: 'toggle',
              id,
              label: heroText(en, it),
              on,
              turnOn: action(`${id}.on`, heroText(en, it), 'wind', 'climate-control', method, {
                on: true,
              }),
              turnOff: action(`${id}.off`, heroText(en, it), 'wind', 'climate-control', method, {
                on: false,
              }),
            },
          ]
        : []
    fanControls.push(
      ...swing(
        'climate.swing-vertical',
        'Swing vertical',
        'Oscillazione verticale',
        'setSwingVertical',
        slice.swingVertical,
        DeviceFeature.ClimateSwingVertical,
      ),
      ...swing(
        'climate.swing-horizontal',
        'Swing horizontal',
        'Oscillazione orizzontale',
        'setSwingHorizontal',
        slice.swingHorizontal,
        DeviceFeature.ClimateSwingHorizontal,
      ),
    )

    const rows: HeroRow[] = [
      {
        id: 'climate-mode',
        icon: 'thermometer',
        status: view.modeLabel,
        controls: modeControls,
      },
    ]
    if (fanControls.length > 0) {
      rows.push({
        id: 'climate-fan',
        icon: 'fan',
        status: slice.fanMode === '' ? null : same(slice.fanMode),
        controls: fanControls,
      })
    }
    rows.push(
      ...setpointRow(
        view.target === null ? null : same(formatDegrees(view.target)),
        view.range === null || view.target === null
          ? null
          : setpointSlider(
              'climate.target',
              'climate-control',
              'setTarget',
              'target',
              view.target,
              view.range,
            ),
      ),
    )

    const sceneMode: HeroSceneMode | null = view.sceneMode
    return {
      reading: reading('climate-control', view.isOff ? 'off' : 'on'),
      title: view.modeLabel,
      ...(view.isOff || slice.fanMode === ''
        ? {}
        : {
            caption: heroText(
              `${view.modeLabel.en} · fan ${fanLabelOf(slice.fanMode).en}`,
              `${view.modeLabel.it} · ventola ${fanLabelOf(slice.fanMode).it}`,
            ),
          }),
      facts,
      ...(left.length === 0 && right.length === 0 ? {} : { tiles: { left, right } }),
      scene: {
        ...(sceneMode === null ? {} : { mode: sceneMode }),
        ...(view.level === null ? {} : { level: view.level }),
      },
      // On returns to the mode the device last ran (kept by the mirror), else the first it accepts in a fixed order.
      ...(view.onMode === null
        ? {}
        : {
            ownPower: {
              source: 'climate-control' as const,
              on: !view.isOff,
              assumed: false,
              turnOn: action(
                'own-power.on',
                heroText('Turn on', 'Accendi'),
                'power',
                'climate-control',
                'setMode',
                { mode: view.onMode },
              ),
              turnOff: action(
                'own-power.off',
                heroText('Turn off', 'Spegni'),
                'power-off',
                'climate-control',
                'setMode',
                { mode: 'off' satisfies HvacMode },
              ),
            },
          }),
      rows,
    }
  },
)

// ── water-heater ───────────────────────────────────────────────────────────

const WATER_ON_PREFERENCE: readonly string[] = ['eco', 'electric', 'heat_pump', 'performance']

function capitalised(word: string): HeroText {
  const label = word.charAt(0).toUpperCase() + word.slice(1).replace(/_/g, ' ')
  return same(label)
}

const waterHeaterContribution = contribution(
  'water-heater',
  WaterHeaterStatusSchema,
  (slice): HeroFragment => {
    if (slice === undefined || slice.operationMode === null) {
      return { reading: reading('climate-control', 'unknown') }
    }
    const isOff = slice.operationMode === 'off'
    const label = capitalised(slice.operationMode)
    const status = thermalStatusText(slice.targetTemp, slice.currentTemp)
    const range = rangeFrom(slice.minTemp, slice.maxTemp, 1)
    const candidates = slice.availableModes.filter((m) => m !== 'off')
    const last = slice.lastActiveMode
    const onMode =
      last !== undefined && candidates.includes(last)
        ? last
        : (WATER_ON_PREFERENCE.find((m) => candidates.includes(m)) ?? candidates[0] ?? null)

    const modeControls: HeroControl[] = [
      {
        kind: 'picker',
        id: 'water-heater.mode',
        label: heroText('Mode', 'Modalità'),
        current: slice.operationMode,
        options: [...slice.availableModes],
        call: { cap: 'water-heater', method: 'setOperationMode', args: {} },
        valueArg: 'mode',
      },
    ]
    if (slice.away !== null) {
      modeControls.push({
        kind: 'toggle',
        id: 'water-heater.away',
        label: heroText('Away', 'Assente'),
        on: slice.away,
        turnOn: action(
          'water-heater.away.on',
          heroText('Away', 'Assente'),
          'house',
          'water-heater',
          'setAway',
          { on: true },
        ),
        turnOff: action(
          'water-heater.away.off',
          heroText('Away', 'Assente'),
          'house',
          'water-heater',
          'setAway',
          { on: false },
        ),
      })
    }
    const rows: HeroRow[] = [
      {
        id: 'climate-mode',
        icon: 'flame',
        status: label,
        controls: modeControls,
      },
      ...setpointRow(
        slice.targetTemp === null ? null : same(formatDegrees(slice.targetTemp)),
        range === null || slice.targetTemp === null
          ? null
          : setpointSlider(
              'water-heater.target',
              'water-heater',
              'setTargetTemp',
              'temp',
              slice.targetTemp,
              range,
            ),
      ),
    ]
    const level = levelWithin(slice.targetTemp, range)
    return {
      reading: reading('climate-control', isOff ? 'off' : 'on'),
      title: label,
      facts: status === null ? [] : [fact('climate', 'flame', status)],
      ...(slice.currentTemp === null
        ? {}
        : {
            tiles: {
              left: [tile('Water', 'Acqua', formatDegrees(slice.currentTemp))],
            },
          }),
      scene: {
        ...(isOff ? {} : { mode: 'heat' as const }),
        ...(level === null ? {} : { level }),
      },
      ...(onMode === null
        ? {}
        : {
            ownPower: {
              source: 'climate-control' as const,
              on: !isOff,
              assumed: false,
              turnOn: action(
                'own-power.on',
                heroText('Turn on', 'Accendi'),
                'power',
                'water-heater',
                'setOperationMode',
                { mode: onMode },
              ),
              turnOff: action(
                'own-power.off',
                heroText('Turn off', 'Spegni'),
                'power-off',
                'water-heater',
                'setOperationMode',
                { mode: 'off' },
              ),
            },
          }),
      rows,
    }
  },
)

// ── heating-valve ──────────────────────────────────────────────────────────

const heatingValveContribution = contribution(
  'heating-valve',
  HeatingValveStatusSchema,
  (slice): HeroFragment => {
    const position = slice?.position ?? null
    if (position === null) return { reading: reading('sensor', 'unknown') }
    const text = same(`${Math.round(position)}%`)
    return {
      reading: reading('sensor', position > 0 ? 'running' : 'idle'),
      facts: [fact('valve', 'gauge', heroText(`Valve ${text.en}`, `Valvola ${text.it}`))],
      tiles: { right: [tile('Valve', 'Valvola', text.en)] },
      ...(position > 0
        ? {
            caption: heroText(`Heating · valve ${text.en}`, `Riscalda · valvola ${text.it}`),
          }
        : {}),
      // Heat rises slower when the valve is nearly shut: the intensity follows the opening.
      scene: { level: position / 100 },
    }
  },
)

// ── sensors ────────────────────────────────────────────────────────────────

/** One reading fact plus its tile; a value that did not answer says nothing and the state stays unknown. */
function sensorFragment(
  value: number | string | null,
  id: HeroFact['id'],
  icon: HeroFact['icon'],
  en: string,
  it: string,
  text: string,
): HeroFragment {
  if (value === null) return { reading: reading('sensor', 'unknown') }
  return {
    reading: reading('sensor', 'on'),
    title: same(text),
    facts: [fact(id, icon, same(text))],
    tiles: { right: [tile(en, it, text)] },
  }
}

const temperatureContribution = contribution(
  'temperature-sensor',
  TemperatureSensorStatusSchema,
  (slice) =>
    measured(
      sensorFragment(
        slice?.temperature ?? null,
        'temperature',
        'thermometer',
        'Temperature',
        'Temperatura',
        formatDegrees(slice?.temperature ?? 0),
      ),
      slice?.temperature == null
        ? emptyMeasurement('temperature')
        : temperatureMeasurement(slice.temperature, slice.lastFetchedAt),
    ),
)

const humidityContribution = contribution('humidity-sensor', HumiditySensorStatusSchema, (slice) =>
  measured(
    sensorFragment(
      slice?.humidity ?? null,
      'humidity',
      'droplets',
      'Humidity',
      'Umidità',
      `${Math.round(slice?.humidity ?? 0)}%`,
    ),
    slice?.humidity == null
      ? emptyMeasurement('humidity')
      : humidityMeasurement(slice.humidity, slice.lastFetchedAt),
  ),
)

const pressureContribution = contribution('pressure-sensor', PressureSensorStatusSchema, (slice) =>
  sensorFragment(
    slice?.pressure ?? null,
    'pressure',
    'gauge',
    'Pressure',
    'Pressione',
    `${Math.round(slice?.pressure ?? 0)} hPa`,
  ),
)

const illuminanceContribution = contribution(
  'ambient-light-sensor',
  AmbientLightSensorStatusSchema,
  (slice) =>
    sensorFragment(
      slice?.illuminance ?? null,
      'illuminance',
      'sun',
      'Light',
      'Luce',
      `${Math.round(slice?.illuminance ?? 0)} lx`,
    ),
)

const numericContribution = contribution('numeric-sensor', NumericSensorStatusSchema, (slice) =>
  sensorFragment(
    slice?.value ?? null,
    'reading',
    'gauge',
    'Value',
    'Valore',
    String(Number((slice?.value ?? 0).toFixed(2))),
  ),
)

const enumContribution = contribution('enum-sensor', EnumSensorStatusSchema, (slice) => {
  // A timestamp is not a state: it would read as an opaque string.
  if (slice === undefined || slice.value === '') {
    return measured({ reading: reading('sensor', 'unknown') }, emptyMeasurement('text'))
  }
  if (slice.timestamp === true) return { reading: reading('sensor', 'on') }
  return measured(
    sensorFragment(slice.value, 'reading', 'gauge', 'State', 'Stato', slice.value),
    textMeasurement(slice.value, slice.lastFetchedAt),
  )
})

interface AirPart {
  readonly label: string
  readonly value: string
}

/** Index bands: the headline of an air-quality sensor is a word, not a number. */
function airQualityWord(aqi: number): HeroText {
  if (aqi <= 50) return heroText('Good', 'Buona')
  if (aqi <= 100) return heroText('Moderate', 'Discreta')
  if (aqi <= 150) return heroText('Poor', 'Scadente')
  return heroText('Unhealthy', 'Malsana')
}

const airQualityContribution = contribution(
  'air-quality-sensor',
  AirQualitySensorStatusSchema,
  (slice): HeroFragment => {
    if (slice === undefined) return { reading: reading('sensor', 'unknown') }
    const parts: AirPart[] = []
    if (slice.aqi !== undefined) parts.push({ label: 'AQI', value: String(Math.round(slice.aqi)) })
    if (slice.co2 !== undefined) parts.push({ label: 'CO₂', value: `${Math.round(slice.co2)} ppm` })
    if (slice.pm25 !== undefined) {
      parts.push({ label: 'PM2.5', value: `${Math.round(slice.pm25)} µg/m³` })
    }
    if (slice.voc !== undefined) parts.push({ label: 'VOC', value: `${Math.round(slice.voc)} ppb` })
    if (slice.pm10 !== undefined) {
      parts.push({ label: 'PM10', value: `${Math.round(slice.pm10)} µg/m³` })
    }
    if (parts.length === 0) return { reading: reading('sensor', 'unknown') }
    return {
      reading: reading('sensor', 'on'),
      ...(slice.aqi === undefined ? {} : { title: airQualityWord(slice.aqi) }),
      facts: parts.map((p) => fact('air-quality', 'wind', same(`${p.label} ${p.value}`))),
      tiles: { right: parts.slice(0, 2).map((p) => tile(p.label, p.label, p.value)) },
    }
  },
)

const carbonMonoxideContribution = contribution(
  'carbon-monoxide',
  CarbonMonoxideStatusSchema,
  (slice): HeroFragment => {
    if (slice === undefined) return { reading: reading('sensor', 'unknown') }
    return {
      reading: reading('sensor', slice.detected ? 'alert' : 'idle'),
      title: slice.detected
        ? heroText('CO detected', 'CO rilevato')
        : heroText('Air clear', 'Aria libera'),
      facts: [
        fact(
          'reading',
          slice.detected ? 'triangle-alert' : 'shield-check',
          slice.detected
            ? heroText('CO detected', 'CO rilevato')
            : heroText('Air clear', 'Aria libera'),
          slice.detected ? 'danger' : 'muted',
        ),
      ],
    }
  },
)

/** The climate family, in the order their fragments are merged (a valve's level outranks a setpoint's). */
export const CLIMATE_FAMILY_CONTRIBUTIONS: Readonly<Record<string, HeroContribution>> = {
  'heating-valve': heatingValveContribution,
  'climate-control': climateContribution,
  'water-heater': waterHeaterContribution,
  'temperature-sensor': temperatureContribution,
  'humidity-sensor': humidityContribution,
  'pressure-sensor': pressureContribution,
  'air-quality-sensor': airQualityContribution,
  'carbon-monoxide': carbonMonoxideContribution,
  'ambient-light-sensor': illuminanceContribution,
  'numeric-sensor': numericContribution,
  'enum-sensor': enumContribution,
}
