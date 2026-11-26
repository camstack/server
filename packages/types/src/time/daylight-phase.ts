/**
 * The DAYLIGHT PHASE — is it day or night — as data and as pure rules. One
 * authority per cluster decides it; every window and time spec reads it.
 *
 * Two sources:
 *  - `sun`    — the phase follows sunrise and sunset at the site (the default,
 *    and what every consumer did before a sensor could be named);
 *  - `sensor` — one device reading (a lux field) decides: night below
 *    `darkBelow`, day from `darkBelow + hysteresis` up, and in between the
 *    phase stays as it is. A change is held back until the phase has lasted
 *    `minDwellMin`, so a cloud or a passing headlight flips nothing.
 *
 * A reading that cannot be taken is NOT a measurement: the authority falls back
 * to the sun and says why (see the service in `packages/system`). The pure
 * evaluators receive the phase on the site ({@link TimeSite.phase}); a site
 * without one, or with a `sun` reading, is judged on the sun exactly as before.
 */
import { z } from 'zod'
import { type TimeSite, occurrenceOn } from './time-spec.js'

export const DaylightPhaseSchema = z.enum(['day', 'night'])
export type DaylightPhase = z.infer<typeof DaylightPhaseSchema>

export const DaylightSourceSchema = z.enum(['sun', 'sensor'])

/** The phase right now, when it began, and which source decided it. */
export const DaylightPhaseReadingSchema = z.object({
  phase: DaylightPhaseSchema,
  /** Epoch ms the phase began. */
  since: z.number(),
  source: DaylightSourceSchema,
})
export type DaylightPhaseReading = z.infer<typeof DaylightPhaseReadingSchema>

export const DaylightSensorSettingsSchema = z.object({
  source: z.literal('sensor'),
  /** The device, capability and field that carry the reading (the vocabulary of a `device-is` leaf). */
  deviceId: z.number().int().nonnegative(),
  cap: z.string().min(1),
  fieldPath: z.string().min(1),
  /** Night begins when the reading is BELOW this. */
  darkBelow: z.number(),
  /** Day begins when the reading reaches `darkBelow + hysteresis`. */
  hysteresis: z.number().min(0),
  /** A phase must have lasted this long before it may change, in minutes. */
  minDwellMin: z.number().int().min(0).max(1440),
})
export type DaylightSensorSettings = z.infer<typeof DaylightSensorSettingsSchema>

export const DaylightSettingsSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('sun') }),
  DaylightSensorSettingsSchema,
])
export type DaylightSettings = z.infer<typeof DaylightSettingsSchema>

/** The default, and the behaviour of every install before the sensor source existed. */
export const DEFAULT_DAYLIGHT_SETTINGS: DaylightSettings = { source: 'sun' }

/**
 * How often a verdict that depends on a SENSOR phase is judged again. The next
 * transition cannot be predicted, so a window or schedule that reads it asks
 * to be re-judged within this bound (and on every transition, by RPC).
 */
export const PHASE_RECHECK_MS = 5 * 60_000

const MINUTE_MS = 60_000

/** The sensor reading a site carries, or undefined: a site without one (or on the sun) is judged on the sun. */
export function sensorPhaseOf(site: TimeSite): DaylightPhaseReading | undefined {
  return site.phase?.source === 'sensor' ? site.phase : undefined
}

/**
 * The next phase after one sensor value. `prev` is the phase so far (null at
 * the first reading). A previous `sun` reading is no history: the sensor is
 * back from a fallback and decides at once.
 */
export function advanceSensorPhase(
  prev: DaylightPhaseReading | null,
  settings: DaylightSensorSettings,
  value: number,
  nowMs: number,
): DaylightPhaseReading {
  const bright = value >= settings.darkBelow + settings.hysteresis
  const dark = value < settings.darkBelow
  if (prev === null || prev.source !== 'sensor') {
    // No history: a reading inside the band has nothing to keep, and is read as day.
    return { phase: dark ? 'night' : 'day', since: nowMs, source: 'sensor' }
  }
  const target: DaylightPhase = dark ? 'night' : bright ? 'day' : prev.phase
  if (target === prev.phase) return prev
  if (nowMs - prev.since < settings.minDwellMin * MINUTE_MS) return prev
  return { phase: target, since: nowMs, source: 'sensor' }
}

/** The phase the sun gives at an instant, and when it began; null when the site has no sun to read. */
export function sunPhaseAt(site: TimeSite, nowMs: number): DaylightPhaseReading | null {
  if (site.zoneOnly === true) return null
  let best: DaylightPhaseReading | null = null
  const today = new Date(nowMs).toISOString().slice(0, 10)
  for (const offset of [-2, -1, 0, 1]) {
    const date = new Date(Date.parse(`${today}T12:00:00Z`) + offset * 86_400_000)
      .toISOString()
      .slice(0, 10)
    for (const [event, phase] of [
      ['sunrise', 'day'],
      ['sunset', 'night'],
    ] as const) {
      const at = occurrenceOn({ kind: 'sun', event, offsetMin: 0 }, date, site)
      if (at !== null && at <= nowMs && (best === null || at > best.since)) {
        best = { phase, since: at, source: 'sun' }
      }
    }
  }
  return best
}

/**
 * The site with the authority's phase attached. Only a `sensor` phase changes how a window or a
 * time spec is judged, so a `sun` answer (or none) leaves the site exactly as it was.
 */
export function siteWithPhase(
  site: TimeSite,
  status: { readonly phase: DaylightPhaseReading | null } | null,
): TimeSite {
  const phase = status?.phase
  return phase !== undefined && phase !== null && phase.source === 'sensor'
    ? { ...site, phase }
    : site
}

/** The numeric reading at a dotted field path of a device slice, or null when it is not a finite number. */
export function sensorValueOf(slice: unknown, fieldPath: string): number | null {
  let cursor: unknown = slice
  for (const part of fieldPath.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return null
    cursor = Reflect.get(cursor, part)
  }
  return typeof cursor === 'number' && Number.isFinite(cursor) ? cursor : null
}
