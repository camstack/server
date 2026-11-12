/**
 * The ONE measurement a simple sensor shows (card wave, phase 1).
 *
 * A sensor that measures a single quantity (a temperature, a humidity, a power,
 * a contact, a text state) is drawn as that reading, once, big, inside a scene
 * whose motion says what the number means: heat rising when hot, flakes when
 * cold, a wire flowing at the speed of the power, a ring while a window is
 * open. Everything the card draws is decided here; a client only paints it.
 */
import { z } from 'zod'
import { IconKeySchema, type IconKey } from '../icon-catalog.js'
import { HERO_TONES, type HeroTone } from './hero-state.js'
import { HeroTextSchema, heroText, type HeroText } from './hero-text.js'

export const HERO_MEASUREMENT_QUANTITIES = [
  'temperature',
  'humidity',
  'power',
  'contact',
  'text',
] as const
export type HeroMeasurementQuantity = (typeof HERO_MEASUREMENT_QUANTITIES)[number]

/** How a temperature reads to a person; drives the heat or the cold scene. */
export const HERO_MEASUREMENT_BANDS = ['hot', 'mild', 'cold'] as const
export type HeroMeasurementBand = (typeof HERO_MEASUREMENT_BANDS)[number]

/** `updated` = the value was last read then ("2 min ago"); `changed` = it has held since then ("for 12 min"). */
export const HERO_MEASUREMENT_SINCE_KINDS = ['updated', 'changed'] as const
export type HeroMeasurementSinceKind = (typeof HERO_MEASUREMENT_SINCE_KINDS)[number]

export interface HeroMeasurement {
  readonly quantity: HeroMeasurementQuantity
  /** The quantity's icon beside the value; `null` = a text state, no icon. */
  readonly icon: IconKey | null
  /** The value, without its unit: "48", "1221", "Open", "Eco". */
  readonly value: HeroText
  /** Drawn small and muted after the value; `null` = none. */
  readonly unit: string | null
  /** A temperature's band; `null` for every other quantity. */
  readonly band: HeroMeasurementBand | null
  /**
   * How strongly the scene moves, 0..1: the power's share of the scale (0 = still),
   * the humidity, the open contact (1). `null` = the quantity has no strength.
   */
  readonly level: number | null
  /** The state corner's word: "Hot", "Active", "Open", "Changed". */
  readonly word: HeroText
  readonly tone: HeroTone
  /** Ms epoch of the `sinceKind` moment; `null` = never observed. */
  readonly since: number | null
  readonly sinceKind: HeroMeasurementSinceKind
  /** The history series a trend line reads (`cap:<cap>.<field>`); `null` = not a number over time. */
  readonly historyKey: string | null
}

export const HeroMeasurementSchema: z.ZodType<HeroMeasurement> = z.object({
  quantity: z.enum(HERO_MEASUREMENT_QUANTITIES),
  icon: IconKeySchema.nullable(),
  value: HeroTextSchema,
  unit: z.string().nullable(),
  band: z.enum(HERO_MEASUREMENT_BANDS).nullable(),
  level: z.number().min(0).max(1).nullable(),
  word: HeroTextSchema,
  tone: z.enum(HERO_TONES),
  since: z.number().nullable(),
  sinceKind: z.enum(HERO_MEASUREMENT_SINCE_KINDS),
  historyKey: z.string().nullable(),
})

/** Below this a temperature reads cold, above `HOT_ABOVE_C` hot (°C). */
export const COLD_BELOW_C = 12
export const HOT_ABOVE_C = 28
/** The power at which the wire runs at full speed (W). */
export const POWER_FULL_SCALE_W = 3000
/** Below / above these a humidity reads dry / humid (%). */
export const DRY_BELOW_PCT = 30
export const HUMID_ABOVE_PCT = 70

const same = (text: string): HeroText => heroText(text, text)
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))
const trimmed = (n: number, digits: number): string => String(Number(n.toFixed(digits)))

export function temperatureBand(celsius: number): HeroMeasurementBand {
  if (celsius < COLD_BELOW_C) return 'cold'
  if (celsius > HOT_ABOVE_C) return 'hot'
  return 'mild'
}

const BAND_WORD: Readonly<Record<HeroMeasurementBand, HeroText>> = {
  hot: heroText('Hot', 'Caldo'),
  mild: heroText('Normal', 'Normale'),
  cold: heroText('Cold', 'Freddo'),
}
const BAND_TONE: Readonly<Record<HeroMeasurementBand, HeroTone>> = {
  hot: 'warning',
  mild: 'muted',
  cold: 'info',
}

export function temperatureMeasurement(celsius: number, since: number | null): HeroMeasurement {
  const band = temperatureBand(celsius)
  return {
    quantity: 'temperature',
    icon: 'thermometer',
    value: same(trimmed(celsius, 1)),
    unit: '°C',
    band,
    level: null,
    word: BAND_WORD[band],
    tone: BAND_TONE[band],
    since,
    sinceKind: 'updated',
    historyKey: 'cap:temperature-sensor.temperature',
  }
}

export function humidityMeasurement(percent: number, since: number | null): HeroMeasurement {
  const dry = percent < DRY_BELOW_PCT
  const humid = percent > HUMID_ABOVE_PCT
  return {
    quantity: 'humidity',
    icon: 'droplets',
    value: same(String(Math.round(percent))),
    unit: '%',
    band: null,
    level: clamp01(percent / 100),
    word: dry
      ? heroText('Dry', 'Secco')
      : humid
        ? heroText('Humid', 'Umido')
        : heroText('Normal', 'Normale'),
    tone: dry || humid ? 'warning' : 'info',
    since,
    sinceKind: 'updated',
    historyKey: 'cap:humidity-sensor.humidity',
  }
}

export function powerMeasurement(watts: number, since: number | null): HeroMeasurement {
  const active = watts > 0
  return {
    quantity: 'power',
    icon: 'zap',
    value: same(String(Math.round(watts))),
    unit: 'W',
    band: null,
    level: clamp01(watts / POWER_FULL_SCALE_W),
    word: active ? heroText('Active', 'Attivo') : heroText('Idle', 'Inattivo'),
    tone: active ? 'primary' : 'muted',
    since,
    sinceKind: 'updated',
    historyKey: 'cap:power-meter.power',
  }
}

export function contactMeasurement(open: boolean, since: number | null): HeroMeasurement {
  return {
    quantity: 'contact',
    icon: open ? 'door-open' : 'door-closed',
    value: open ? heroText('Open', 'Aperto') : heroText('Closed', 'Chiuso'),
    unit: null,
    band: null,
    level: open ? 1 : 0,
    word: open ? heroText('Open', 'Aperto') : heroText('Closed', 'Chiuso'),
    tone: open ? 'warning' : 'success',
    since,
    sinceKind: 'changed',
    historyKey: null,
  }
}

export function textMeasurement(text: string, since: number | null): HeroMeasurement {
  return {
    quantity: 'text',
    icon: null,
    value: same(text),
    unit: null,
    band: null,
    level: null,
    word: heroText('Changed', 'Cambiato'),
    tone: 'muted',
    since,
    sinceKind: 'updated',
    historyKey: null,
  }
}
