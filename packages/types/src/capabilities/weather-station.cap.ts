import { z } from 'zod'
import { DeviceType } from '../device/device-type.js'
import { t } from '../device/cap-vocabulary/l10n.js'
import { readingMeta } from '../units/quantity.js'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'

/**
 * A physical weather station (an Ecowitt outdoor array, and the same shape for
 * any later station). Read-only: one slice per station, filled from the
 * station's own poll. `weather` stays the forecast provider.
 *
 * The station is the ONE owner of its readings and of their history: a provider
 * does not also declare them as standalone sensor devices.
 *
 * Every reading is nullable. Null means the station does not report it;
 * a missing sensor is never stored as 0 (D393). Units are the quantity base
 * (D944), declared the same way sibling sensor caps declare them.
 */
export const WeatherStationReadingsSchema = z.object({
  temperature: z
    .number()
    .nullable()
    .meta(readingMeta('temperature', { precision: 1 })),
  humidity: z.number().min(0).max(100).nullable().meta(readingMeta('humidity')),
  pressure: z.number().nullable().meta(readingMeta('pressure')),
  windSpeed: z.number().nullable().meta(readingMeta('speed')),
  windGust: z.number().nullable().meta(readingMeta('speed')),
  windBearing: z.number().nullable().meta(readingMeta('angle')),
  rainRate: z
    .number()
    .nullable()
    .meta(readingMeta('precipitation-rate', { precision: 1 })),
  rainDaily: z
    .number()
    .nullable()
    .meta(readingMeta('precipitation', { precision: 1 })),
  rainEvent: z
    .number()
    .nullable()
    .meta(readingMeta('precipitation', { precision: 1 })),
  uv: z
    .number()
    .nullable()
    .meta(readingMeta('index', { precision: 1 })),
  solarRadiation: z.number().nullable().meta(readingMeta('irradiance')),
  dewPoint: z
    .number()
    .nullable()
    .meta(readingMeta('temperature', { precision: 1 })),
  /** Apparent ("feels like") temperature. */
  feelsLike: z
    .number()
    .nullable()
    .meta(readingMeta('temperature', { precision: 1 })),
  /** Vapour-pressure deficit. Stored as a pressure (hPa, 10 hPa = 1 kPa). */
  vpd: z
    .number()
    .nullable()
    .meta(readingMeta('pressure', { precision: 1 })),
  /** Highest wind gust since local midnight. */
  windGustMax: z.number().nullable().meta(readingMeta('speed')),
  /** Wind bearing averaged over the station's own window. */
  windBearingAvg: z.number().nullable().meta(readingMeta('angle')),
  rain24h: z
    .number()
    .nullable()
    .meta(readingMeta('precipitation', { precision: 1 })),
  rainWeekly: z
    .number()
    .nullable()
    .meta(readingMeta('precipitation', { precision: 1 })),
  rainMonthly: z
    .number()
    .nullable()
    .meta(readingMeta('precipitation', { precision: 1 })),
  rainYearly: z
    .number()
    .nullable()
    .meta(readingMeta('precipitation', { precision: 1 })),
})

export const WeatherStationStatusSchema = WeatherStationReadingsSchema.extend({
  /** Ms epoch of the poll that produced this slice. 0 before the first one. */
  lastFetchedAt: z.number(),
})

export type WeatherStationStatus = z.infer<typeof WeatherStationStatusSchema>

const numeric = (
  field: string,
  quantity: { en: string; it: string },
  label: { en: string; it: string },
  unit: string,
  icon: 'thermometer' | 'droplets' | 'gauge' | 'wind' | 'cloud-sun',
) => ({
  kind: 'numeric' as const,
  field,
  quantity,
  label,
  unit,
  icon,
})

export const weatherStationCapability = {
  name: 'weather-station',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.WeatherStation],
  methods: {},
  status: {
    schema: WeatherStationStatusSchema,
    kind: 'push',
  },
  runtimeState: WeatherStationStatusSchema,
  /**
   * History (D850): the station records its own readings. Rain totals that
   * reset (event, day, week, month, year) and the sliding 24 h total are
   * levels, so `gauge`; `counter` is for a monotonic meter only.
   */
  history: {
    fields: {
      temperature: { kind: 'gauge', unit: '°C', deadband: 0.1 },
      humidity: { kind: 'gauge', unit: '%', deadband: 1 },
      pressure: { kind: 'gauge', unit: 'hPa', deadband: 0.2 },
      windSpeed: { kind: 'gauge', unit: 'm/s', deadband: 0.2 },
      windGust: { kind: 'gauge', unit: 'm/s', deadband: 0.2 },
      windBearing: { kind: 'gauge', unit: '°', deadband: 5 },
      rainRate: { kind: 'gauge', unit: 'mm/h', deadband: 0.1 },
      rainDaily: { kind: 'gauge', unit: 'mm', deadband: 0.1 },
      rainEvent: { kind: 'gauge', unit: 'mm', deadband: 0.1 },
      uv: { kind: 'gauge', unit: 'count', deadband: 0.1 },
      solarRadiation: { kind: 'gauge', unit: 'W/m²', deadband: 5 },
      dewPoint: { kind: 'gauge', unit: '°C', deadband: 0.1 },
      feelsLike: { kind: 'gauge', unit: '°C', deadband: 0.1 },
      vpd: { kind: 'gauge', unit: 'hPa', deadband: 0.1 },
      windGustMax: { kind: 'gauge', unit: 'm/s', deadband: 0.2 },
      windBearingAvg: { kind: 'gauge', unit: '°', deadband: 5 },
      rain24h: { kind: 'gauge', unit: 'mm', deadband: 0.1 },
      rainWeekly: { kind: 'gauge', unit: 'mm', deadband: 0.1 },
      rainMonthly: { kind: 'gauge', unit: 'mm', deadband: 0.1 },
      rainYearly: { kind: 'gauge', unit: 'mm', deadband: 0.1 },
    },
  },
  /** The poll clock is written but is no reason to commit a row. */
  volatileStateFields: ['lastFetchedAt'],
  /**
   * Runtime-state durability: **session** — a station reading is stale the
   * moment the hub is down; the provider re-reads on the next poll.
   */
  durability: 'session',
  vocabulary: {
    noun: t('Weather station', 'Stazione meteo'),
    order: 5235,
    state: [
      numeric(
        'temperature',
        t('the outdoor temperature', 'la temperatura esterna'),
        t('Temperature', 'Temperatura'),
        '°C',
        'thermometer',
      ),
      numeric(
        'humidity',
        t('the outdoor humidity', 'l’umidità esterna'),
        t('Humidity', 'Umidità'),
        '%',
        'droplets',
      ),
      numeric(
        'pressure',
        t('the air pressure', 'la pressione atmosferica'),
        t('Pressure', 'Pressione'),
        'hPa',
        'gauge',
      ),
      numeric(
        'windSpeed',
        t('the wind speed', 'la velocità del vento'),
        t('Wind', 'Vento'),
        'm/s',
        'wind',
      ),
      numeric(
        'windGust',
        t('the wind gust', 'la raffica di vento'),
        t('Gust', 'Raffica'),
        'm/s',
        'wind',
      ),
      numeric(
        'windBearing',
        t('the wind bearing', 'la direzione del vento'),
        t('Wind bearing', 'Direzione del vento'),
        '°',
        'wind',
      ),
      numeric(
        'rainRate',
        t('the rain rate', 'l’intensità della pioggia'),
        t('Rain rate', 'Intensità pioggia'),
        'mm/h',
        'droplets',
      ),
      numeric(
        'rainDaily',
        t('the rain today', 'la pioggia di oggi'),
        t('Rain today', 'Pioggia oggi'),
        'mm',
        'droplets',
      ),
      numeric(
        'rainEvent',
        t('the rain this event', 'la pioggia di questo evento'),
        t('Rain event', 'Evento di pioggia'),
        'mm',
        'droplets',
      ),
      numeric('uv', t('the UV index', 'l’indice UV'), t('UV', 'UV'), '', 'cloud-sun'),
      numeric(
        'solarRadiation',
        t('the solar radiation', 'la radiazione solare'),
        t('Solar', 'Sole'),
        'W/m²',
        'cloud-sun',
      ),
      numeric(
        'dewPoint',
        t('the dew point', 'il punto di rugiada'),
        t('Dew point', 'Punto di rugiada'),
        '°C',
        'thermometer',
      ),
      numeric(
        'feelsLike',
        t('the feels-like temperature', 'la temperatura percepita'),
        t('Feels like', 'Percepita'),
        '°C',
        'thermometer',
      ),
      numeric(
        'vpd',
        t('the vapour-pressure deficit', 'il deficit di pressione di vapore'),
        t('VPD', 'VPD'),
        'hPa',
        'gauge',
      ),
      numeric(
        'windGustMax',
        t('the highest gust today', 'la raffica massima di oggi'),
        t('Max gust', 'Raffica max'),
        'm/s',
        'wind',
      ),
      numeric(
        'windBearingAvg',
        t('the average wind bearing', 'la direzione media del vento'),
        t('Avg bearing', 'Direzione media'),
        '°',
        'wind',
      ),
      numeric(
        'rain24h',
        t('the rain in the last 24 hours', 'la pioggia delle ultime 24 ore'),
        t('Rain 24 h', 'Pioggia 24 h'),
        'mm',
        'droplets',
      ),
      numeric(
        'rainWeekly',
        t('the rain this week', 'la pioggia di questa settimana'),
        t('Rain week', 'Pioggia settimana'),
        'mm',
        'droplets',
      ),
      numeric(
        'rainMonthly',
        t('the rain this month', 'la pioggia di questo mese'),
        t('Rain month', 'Pioggia mese'),
        'mm',
        'droplets',
      ),
      numeric(
        'rainYearly',
        t('the rain this year', 'la pioggia di quest’anno'),
        t('Rain year', 'Pioggia anno'),
        'mm',
        'droplets',
      ),
    ],
  },
} as const satisfies CapabilityDefinition

export type IWeatherStationProvider = InferProvider<typeof weatherStationCapability>
