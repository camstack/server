import { normalizeEnpalUnit } from './enpal-units.js'
import type { EnpalReading } from './enpal-snapshot.js'

const CARD_HEADER = /<div class="card-header">\s*<h2>([^<]+)<\/h2>/g
const ROW = /<tr>\s*<td>([^<]+)<\/td>\s*<td>([^<]*)<\/td>\s*<td>[^<]*<\/td>\s*<\/tr>/g
const KEY_SHAPE = /^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z0-9-]+)+$/
/** `10231W`, `-350W`, `1.85kW`, `51°C`, `62.5%`, `3` */
const VALUE = /^(-?\d+(?:[.,]\d+)?)\s*(\S*)$/

function decodeEntities(text: string): string {
  return text
    .replace(/&deg;/g, '°')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .trim()
}

/** Offsets of each card header, so a row can be assigned to the card it sits in. */
function cardOffsets(html: string): ReadonlyArray<{ readonly at: number; readonly name: string }> {
  const out: Array<{ at: number; name: string }> = []
  for (const match of html.matchAll(CARD_HEADER)) {
    out.push({ at: match.index ?? 0, name: decodeEntities(match[1] ?? '') })
  }
  return out
}

/**
 * Parse the box's local device page (`/deviceMessages`) into readings. One card per device
 * group, one row per data point (`key | value+unit | timestamp`). A text value (a bitfield, a
 * serial number) is not a reading and is skipped. The row timestamp is a locale string with
 * no zone, so it is not used: the poll time is.
 *
 * Firmware 8.51 and later pre-render only the "Site Data" card; the device rows then never
 * appear and this returns `[]`.
 */
export function parseDeviceMessages(html: string): EnpalReading[] {
  const cards = cardOffsets(html)
  const readings: EnpalReading[] = []
  for (const match of html.matchAll(ROW)) {
    const key = decodeEntities(match[1] ?? '')
    if (!KEY_SHAPE.test(key)) continue
    const parsed = VALUE.exec(decodeEntities(match[2] ?? ''))
    if (parsed === null) continue
    const value = Number((parsed[1] ?? '').replace(',', '.'))
    if (!Number.isFinite(value)) continue
    const at = match.index ?? 0
    const card = [...cards].reverse().find((c) => c.at <= at)
    readings.push({
      key,
      value,
      unit: normalizeEnpalUnit(parsed[2]),
      measurement: card?.name,
    })
  }
  return readings
}
