/**
 * How a motion episode's rising-edge offsets become bytes, and back (D475).
 *
 * A motion episode row (`durationMs` + `edges`) records every distinct
 * off→on transition the camera reported while the episode stayed open — "ogni
 * evento on si deve salvare" (the operator's words). `edges` holds those
 * instants as **ms offsets from the episode's `timestamp`** (its first rising
 * edge, so the first entry is always `0`), never as absolute epochs — an
 * epoch is ~13 digits per entry; an offset into a 40 s episode is 1–5.
 *
 * Mirrors `position-codec.ts` (D471) on purpose: same discipline, different
 * shape. A MALFORMED stored value decodes to an empty array, never a throw —
 * one row's garbage `edges` column must not take out the whole event read
 * path, and a legacy row (written before this column existed) has no `edges`
 * at all, which decodes to `[]` exactly like garbage does. The open/closed
 * question is answered by `durationMs` being `null` vs a number vs absent —
 * never by this column, so an empty `edges` array must never be read as "no
 * episode" or "still open".
 */
import { gunzipSync, gzipSync } from 'node:zlib'

/**
 * Marks a value this module wrote. A distinct namespace from
 * `position-codec.ts`'s `z1:` — different column, different shape, so a
 * value from one can never be mistaken for the other's.
 */
const ENCODED_PREFIX = 'me1:'

/** Round-trip a sequence of rising-edge offsets (ms, from the episode start)
 *  through gzip + base64 — the same trade `position-codec.ts` made: base64
 *  because the settings-store column types have no BLOB, gzip because the
 *  repeated small integers compress well. */
export function encodeMotionEdges(edgesMs: readonly number[]): string {
  const json = JSON.stringify(edgesMs)
  return ENCODED_PREFIX + gzipSync(Buffer.from(json, 'utf8'), { level: 6 }).toString('base64')
}

/**
 * Read a stored `edges` value. Two shapes reach here: a `me1:` string this
 * module wrote, and a plain array (the store parsed the JSON column for us,
 * or a caller handed one straight through — the codec should not be the
 * reason a valid in-memory array fails to read back). Anything else —
 * `undefined` (legacy row, or an episode that never closed), a garbage
 * string, a number — answers `[]`.
 */
export function decodeMotionEdges(value: unknown): readonly number[] {
  if (Array.isArray(value)) return value.filter(isFiniteNumber)
  if (typeof value !== 'string') return []
  if (value.startsWith(ENCODED_PREFIX)) {
    try {
      const raw = gunzipSync(Buffer.from(value.slice(ENCODED_PREFIX.length), 'base64')).toString(
        'utf8',
      )
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter(isFiniteNumber) : []
    } catch {
      return []
    }
  }
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter(isFiniteNumber) : []
  } catch {
    return []
  }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}
