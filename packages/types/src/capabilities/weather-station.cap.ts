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
   * The sensor children already record each reading. The station slice is the
   * live aggregate a template reads; it does not keep a second series.
   */
  history: 'none',
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
    ],
  },
} as const satisfies CapabilityDefinition

export type IWeatherStationProvider = InferProvider<typeof weatherStationCapability>
