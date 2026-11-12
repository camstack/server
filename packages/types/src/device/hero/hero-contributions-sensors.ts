/**
 * What the sensing caps add to a hero (D1023): the alarm sensors (smoke, flood,
 * gas, tamper, vibration), motion, presence, the doorbell, the generic binary
 * and meter, the weather station, a firmware update, an image and the two
 * caps a person acts on directly (a button, a control).
 *
 * A sensor's title is its READING ("Clear" / "Detected"), never a power word:
 * the generic On / Off belong to something that can be switched. A slice that
 * does not parse is "not answered" and reads `unknown`, never clear (D315/D393);
 * a measurement the device did not report is absent, never a zero (D393).
 */
import { BinaryStatusSchema } from '../../capabilities/binary.cap.js'
import { ControlStatusSchema, type ControlStatus } from '../../capabilities/control.cap.js'
import { DoorbellStatusSchema } from '../../capabilities/doorbell.cap.js'
import { FloodStatusSchema } from '../../capabilities/flood.cap.js'
import { GasStatusSchema } from '../../capabilities/gas.cap.js'
import { ImageStatusSchema } from '../../capabilities/image.cap.js'
import { MeterStatusSchema } from '../../capabilities/meter.cap.js'
import { MotionStatusSchema } from '../../capabilities/motion.cap.js'
import { PresenceStatusSchema } from '../../capabilities/presence.cap.js'
import { SmokeStatusSchema } from '../../capabilities/smoke.cap.js'
import { TamperStatusSchema } from '../../capabilities/tamper.cap.js'
import { UpdateStatusSchema } from '../../capabilities/update.cap.js'
import { VibrationStatusSchema } from '../../capabilities/vibration.cap.js'
import { WeatherStatusSchema } from '../../capabilities/weather.cap.js'
import {
  action,
  asAction,
  contribution,
  elapsedText,
  fact,
  reading,
  row,
  type HeroContribution,
} from './hero-contribution-kit.js'
import type { StateSource } from './hero-fragment.js'
import type { HeroFact, HeroRow, HeroSideTile } from './hero-model.js'
import type { HeroState } from './hero-state.js'
import { heroText, type HeroText } from './hero-text.js'
import type { z } from 'zod'

/** The recency of a transition as the top line's "since" fact; absent when never observed. */
function sinceFact(at: number | null, now: number, tone: HeroFact['tone'] = 'muted'): HeroFact[] {
  if (at === null) return []
  const ago = elapsedText(at, now)
  return ago === null ? [] : [fact('since', 'clock', ago, tone)]
}

// ── the on/off-shaped sensors ──────────────────────────────────────────────

interface DetectionWords {
  readonly yes: HeroText
  readonly no: HeroText
}

interface DetectionSpec<S> {
  readonly cap: string
  readonly source: StateSource
  readonly schema: z.ZodType<S>
  readonly words: DetectionWords
  /** What the "yes" reading is: a tripped alarm is `alert`, a plain detection `on`. */
  readonly yesState: HeroState
  readonly flag: (slice: S) => boolean
  /** Ms epoch of the last transition; `0` / `null` = never observed. */
  readonly changedAt: (slice: S) => number | null
}

function detection<S>(spec: DetectionSpec<S>): HeroContribution {
  return contribution(spec.cap, spec.schema, (slice, ctx) => {
    if (slice === undefined) return { reading: reading(spec.source, 'unknown') }
    const tripped = spec.flag(slice)
    const changed = spec.changedAt(slice)
    return {
      reading: reading(
        spec.source,
        tripped ? spec.yesState : 'idle',
        false,
        tripped ? spec.words.yes : spec.words.no,
      ),
      facts: sinceFact(changed === 0 ? null : changed, ctx.now, tripped ? 'danger' : 'muted'),
    }
  })
}

const detected = {
  yes: heroText('Detected', 'Rilevato'),
  no: heroText('Clear', 'Libero'),
}

const smokeContribution = detection({
  cap: 'smoke',
  source: 'smoke',
  schema: SmokeStatusSchema,
  words: {
    yes: heroText('Smoke detected', 'Fumo rilevato'),
    no: heroText('Clear', 'Nessun fumo'),
  },
  yesState: 'alert',
  flag: (s) => s.detected,
  changedAt: (s) => s.lastChangedAt,
})

const floodContribution = detection({
  cap: 'flood',
  source: 'flood',
  schema: FloodStatusSchema,
  words: {
    yes: heroText('Leak detected', 'Perdita rilevata'),
    no: heroText('Dry', 'Asciutto'),
  },
  yesState: 'alert',
  flag: (s) => s.flooded,
  changedAt: (s) => s.lastChangedAt,
})

const gasContribution = detection({
  cap: 'gas',
  source: 'gas',
  schema: GasStatusSchema,
  words: {
    yes: heroText('Gas detected', 'Gas rilevato'),
    no: heroText('Clear', 'Nessun gas'),
  },
  yesState: 'alert',
  flag: (s) => s.detected,
  changedAt: (s) => s.lastChangedAt,
})

const tamperContribution = detection({
  cap: 'tamper',
  source: 'tamper',
  schema: TamperStatusSchema,
  words: {
    yes: heroText('Tampered', 'Manomesso'),
    no: heroText('Secure', 'Integro'),
  },
  yesState: 'alert',
  flag: (s) => s.tampered,
  changedAt: (s) => s.lastChangedAt,
})

const vibrationContribution = detection({
  cap: 'vibration',
  source: 'vibration',
  schema: VibrationStatusSchema,
  words: {
    yes: heroText('Vibration', 'Vibrazione'),
    no: heroText('Still', 'Fermo'),
  },
  yesState: 'on',
  flag: (s) => s.detected,
  changedAt: (s) => s.lastChangedAt,
})

const binaryContribution = detection({
  cap: 'binary',
  source: 'binary',
  schema: BinaryStatusSchema,
  words: {
    yes: heroText('Active', 'Attivo'),
    no: heroText('Inactive', 'Inattivo'),
  },
  yesState: 'on',
  flag: (s) => s.on,
  changedAt: (s) => s.lastChangedAt,
})

const motionContribution = contribution('motion', MotionStatusSchema, (slice, ctx) => {
  if (slice === undefined) return { reading: reading('motion', 'unknown') }
  const last = slice.lastDetectedAt
  const ago = last === null ? null : elapsedText(last, ctx.now)
  return {
    reading: reading(
      'motion',
      slice.detected ? 'on' : 'idle',
      false,
      slice.detected ? detected.yes : heroText('Clear', 'Nessun movimento'),
    ),
    ...(ago === null
      ? {}
      : {
          facts: [
            fact(
              'since',
              'clock',
              heroText(`Last motion ${ago.en}`, `Ultimo movimento ${ago.it}`),
              slice.detected ? 'primary' : 'muted',
            ),
          ],
        }),
  }
})

// ── presence ───────────────────────────────────────────────────────────────

const presenceContribution = contribution('presence', PresenceStatusSchema, (slice, ctx) => {
  if (slice === undefined) return { reading: reading('presence', 'unknown') }
  const zone = slice.state
  const home = zone === 'home'
  const away = zone === 'not_home'
  const title = home
    ? heroText('Home', 'A casa')
    : away
      ? heroText('Away', 'Fuori casa')
      : heroText(zone, zone)
  const facts: HeroFact[] = []
  if (slice.location !== null && slice.location !== '')
    facts.push(fact('reading', 'map-pin', heroText(slice.location, slice.location)))
  facts.push(...sinceFact(slice.lastChangedAt === 0 ? null : slice.lastChangedAt, ctx.now))
  return {
    reading: reading('presence', away ? 'off' : 'on', false, title),
    facts,
  }
})

// ── doorbell ───────────────────────────────────────────────────────────────

/** A ring this recent still reads as "ringing". */
const RINGING_MS = 30_000

const doorbellContribution = contribution('doorbell', DoorbellStatusSchema, (slice, ctx) => {
  if (slice === undefined) return { reading: reading('doorbell', 'unknown') }
  const last = slice.lastPressedAt
  const ago = last === null ? null : elapsedText(last, ctx.now)
  const ringing = last !== null && ctx.now >= last && ctx.now - last < RINGING_MS
  const title: HeroText = ringing
    ? heroText('Ringing', 'Suona')
    : ago === null
      ? heroText('No ring yet', 'Nessun squillo')
      : heroText(`Last ring ${ago.en}`, `Ultimo squillo ${ago.it}`)
  const count = slice.pressCountSinceStart
  return {
    // A camera that also reports motion keeps motion's words; the ring is then a fact.
    ...(ctx.caps.includes('motion') && !ringing
      ? {}
      : {
          reading: reading('doorbell', ringing ? 'on' : 'idle', false, title),
        }),
    facts: [
      ...(ctx.caps.includes('motion') && !ringing ? [fact('event', 'bell', title)] : []),
      ...(count > 0
        ? [
            fact(
              'event',
              'bell-ring',
              heroText(`${count} ring${count === 1 ? '' : 's'}`, `${count} squilli`),
            ),
          ]
        : []),
    ],
  }
})

// ── meter ──────────────────────────────────────────────────────────────────

const number = (n: number): string => `${Number(n.toFixed(2))}`

const meterContribution = contribution('meter', MeterStatusSchema, (slice, ctx) => {
  // A gap (null) is "no reading", never zero.
  if (slice === undefined || slice.value === null) return { reading: reading('meter', 'unknown') }
  const value = number(slice.value)
  return {
    reading: reading('meter', 'idle', false, heroText(value, value)),
    facts: sinceFact(slice.lastFetchedAt === 0 ? null : slice.lastFetchedAt, ctx.now),
  }
})

// ── weather ────────────────────────────────────────────────────────────────

const CONDITION_WORDS: Readonly<Record<string, HeroText>> = {
  sunny: heroText('Sunny', 'Soleggiato'),
  'clear-night': heroText('Clear night', 'Notte serena'),
  cloudy: heroText('Cloudy', 'Nuvoloso'),
  partlycloudy: heroText('Partly cloudy', 'Parzialmente nuvoloso'),
  rainy: heroText('Rain', 'Pioggia'),
  pouring: heroText('Heavy rain', 'Pioggia forte'),
  snowy: heroText('Snow', 'Neve'),
  'snowy-rainy': heroText('Sleet', 'Nevischio'),
  fog: heroText('Fog', 'Nebbia'),
  windy: heroText('Windy', 'Ventoso'),
  'windy-variant': heroText('Windy', 'Ventoso'),
  lightning: heroText('Thunderstorm', 'Temporale'),
  'lightning-rainy': heroText('Thunderstorm', 'Temporale'),
  hail: heroText('Hail', 'Grandine'),
  exceptional: heroText('Exceptional', 'Eccezionale'),
}

const weatherContribution = contribution('weather', WeatherStatusSchema, (slice, ctx) => {
  if (slice === undefined) return { reading: reading('weather', 'unknown') }
  const { condition, temperature, humidity, pressure, windSpeed } = slice
  const celsius = temperature === null ? null : `${number(temperature)}°C`
  const word =
    condition === null ? null : (CONDITION_WORDS[condition] ?? heroText(condition, condition))
  const title: HeroText | null = word ?? (celsius === null ? null : heroText(celsius, celsius))
  if (title === null) return { reading: reading('weather', 'unknown') }
  const facts: HeroFact[] = []
  if (celsius !== null && word !== null)
    facts.push(fact('reading', 'thermometer', heroText(celsius, celsius), 'primary'))
  if (humidity !== null)
    facts.push(
      fact('reading', 'droplets', heroText(`${Math.round(humidity)}%`, `${Math.round(humidity)}%`)),
    )
  if (windSpeed !== null)
    facts.push(
      fact('reading', 'wind', heroText(`${number(windSpeed)} m/s`, `${number(windSpeed)} m/s`)),
    )
  if (pressure !== null)
    facts.push(
      fact(
        'reading',
        'gauge',
        heroText(`${Math.round(pressure)} hPa`, `${Math.round(pressure)} hPa`),
      ),
    )
  facts.push(...sinceFact(slice.lastFetchedAt === 0 ? null : slice.lastFetchedAt, ctx.now))
  const left: HeroSideTile[] = []
  if (humidity !== null)
    left.push({
      label: heroText('Humidity', 'Umidità'),
      value: heroText(`${Math.round(humidity)}%`, `${Math.round(humidity)}%`),
    })
  if (pressure !== null)
    left.push({
      label: heroText('Pressure', 'Pressione'),
      value: heroText(`${Math.round(pressure)} hPa`, `${Math.round(pressure)} hPa`),
    })
  const right: HeroSideTile[] =
    windSpeed === null
      ? []
      : [
          {
            label: heroText('Wind', 'Vento'),
            value: heroText(`${number(windSpeed)} m/s`, `${number(windSpeed)} m/s`),
          },
        ]
  return {
    reading: reading('weather', 'on', false, title),
    facts,
    tiles: { left, right },
  }
})

// ── update ─────────────────────────────────────────────────────────────────

// Read-only on purpose: `update` is a singleton cap and `installUpdate` names no device
// (update.cap.ts), so an action on this hero could not say which device to update.

const updateContribution = contribution('update', UpdateStatusSchema, (slice) => {
  if (slice === undefined) return { reading: reading('update', 'unknown') }
  const { currentVersion, availableVersion, inProgress } = slice
  const pending =
    availableVersion !== null && availableVersion !== '' && availableVersion !== currentVersion
  if (!pending && currentVersion === null && !inProgress)
    return { reading: reading('update', 'unknown') }
  const state: HeroState = inProgress ? 'running' : pending ? 'standby' : 'idle'
  const title: HeroText = inProgress
    ? heroText('Updating', 'Aggiornamento in corso')
    : pending
      ? heroText('Update available', 'Aggiornamento disponibile')
      : heroText('Up to date', 'Aggiornato')
  const versions =
    currentVersion === null
      ? pending
        ? heroText(`${availableVersion}`, `${availableVersion}`)
        : null
      : pending
        ? heroText(
            `${currentVersion} → ${availableVersion}`,
            `${currentVersion} → ${availableVersion}`,
          )
        : heroText(`Version ${currentVersion}`, `Versione ${currentVersion}`)
  return {
    reading: reading('update', state, false, title),
    facts:
      versions === null
        ? []
        : [fact('reading', 'download', versions, pending ? 'warning' : 'muted')],
    rows: [row('update', 'download', versions, [])],
  }
})

// ── image ──────────────────────────────────────────────────────────────────

const imageContribution = contribution('image', ImageStatusSchema, (slice, ctx) => {
  if (slice === undefined) return { reading: reading('image', 'unknown') }
  if (slice.url === null)
    return {
      reading: reading('image', 'idle', false, heroText('No image yet', 'Nessuna immagine')),
    }
  const ago = slice.lastUpdated === null ? null : elapsedText(slice.lastUpdated, ctx.now)
  const title =
    ago === null
      ? heroText('Image', 'Immagine')
      : heroText(`Updated ${ago.en}`, `Aggiornata ${ago.it}`)
  return {
    reading: reading('image', 'on', false, title),
    artworkUrl: slice.url,
  }
})

// ── button ─────────────────────────────────────────────────────────────────

/** A button has no state to read: it is always ready, so it is never `unknown`. */
const buttonContribution: HeroContribution = {
  cap: 'button',
  contribute: () => ({
    reading: reading('button', 'idle', false, heroText('Ready', 'Pronto')),
    rows: [
      row('button', 'pointer', null, [
        asAction(
          action(
            'button.press',
            heroText('Press', 'Premi'),
            'pointer',
            'button',
            'press',
            {},
            'primary',
            'press',
          ),
        ),
      ]),
    ],
  }),
}

// ── control ────────────────────────────────────────────────────────────────

const controlContribution = contribution('control', ControlStatusSchema, (slice, ctx) => {
  if (slice === undefined) return { reading: reading('control', 'unknown') }
  const text = typeof slice.value === 'number' ? number(slice.value) : slice.value
  return {
    reading: reading('control', 'on', false, heroText(text, text)),
    facts: sinceFact(slice.lastChangedAt === 0 ? null : slice.lastChangedAt, ctx.now),
    rows: controlRows(slice),
  }
})

const CONTROL_LABEL = heroText('Value', 'Valore')

/**
 * A number with known bounds is a slider, one without a number field, a choice a picker,
 * free text a text field; a date stays read-only.
 */
function controlRows(slice: ControlStatus): HeroRow[] {
  if (slice.kind === 'numeric' && typeof slice.value === 'number') {
    if (slice.min === undefined || slice.max === undefined) {
      return [
        row('control', 'sliders-horizontal', null, [
          {
            kind: 'number',
            id: 'control.value',
            label: CONTROL_LABEL,
            value: slice.value,
            step: slice.step ?? null,
            unit: '',
            call: { cap: 'control', method: 'setValue', args: { control: { kind: 'numeric' } } },
            valueArg: 'control.value',
          },
        ]),
      ]
    }
    return [
      row('control', 'sliders-horizontal', null, [
        {
          kind: 'slider',
          id: 'control.value',
          label: CONTROL_LABEL,
          value: slice.value,
          min: slice.min,
          max: slice.max,
          step: slice.step ?? 1,
          unit: '',
          call: { cap: 'control', method: 'setValue', args: { control: { kind: 'numeric' } } },
          valueArg: 'control.value',
        },
      ]),
    ]
  }
  if (slice.kind === 'select' && typeof slice.value === 'string') {
    return [
      row('control', 'sliders-horizontal', null, [
        {
          kind: 'picker',
          id: 'control.value',
          label: CONTROL_LABEL,
          current: slice.value,
          options: slice.options,
          call: { cap: 'control', method: 'setValue', args: { control: { kind: 'select' } } },
          valueArg: 'control.value',
        },
      ]),
    ]
  }
  if (slice.kind === 'text') {
    return [
      row('control', 'sliders-horizontal', null, [
        {
          kind: 'text',
          id: 'control.value',
          label: CONTROL_LABEL,
          value: typeof slice.value === 'string' ? slice.value : null,
          call: { cap: 'control', method: 'setValue', args: { control: { kind: 'text' } } },
          valueArg: 'control.value',
        },
      ]),
    ]
  }
  return []
}

export const SENSORS_FAMILY_CONTRIBUTIONS: Readonly<Record<string, HeroContribution>> = {
  smoke: smokeContribution,
  flood: floodContribution,
  gas: gasContribution,
  tamper: tamperContribution,
  vibration: vibrationContribution,
  binary: binaryContribution,
  motion: motionContribution,
  presence: presenceContribution,
  doorbell: doorbellContribution,
  meter: meterContribution,
  weather: weatherContribution,
  update: updateContribution,
  image: imageContribution,
  button: buttonContribution,
  control: controlContribution,
}
