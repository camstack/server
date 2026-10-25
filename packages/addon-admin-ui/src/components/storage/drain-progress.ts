/**
 * Drain progress — reading `storage.listDrainProgress` and turning one row into
 * what a location card draws.
 *
 * The card could say a location was draining and nothing else: there was no
 * backend method for "bytes remaining on a draining location", so the row read
 * `Draining · Remaining not reported yet · Estimated empty time not available
 * yet` — honest, and useless. The method exists now.
 *
 * ## The wire shape, read from the hub rather than assumed
 *
 * Verified against the live hub on 2026-09-08 (`recordings:default`, the disk
 * the operator put into drain):
 *
 * ```json
 * { "locationId": "recordings:default",
 *   "startedAtMs": 1788805596282,
 *   "startBytes": 1676511875669,
 *   "bytesRemaining": 1359839746343,
 *   "drained": false,
 *   "estimatedEmptyAtMs": 1789071138339 }
 * ```
 *
 * {@link toDrainProgressRow} narrows it defensively rather than trusting the
 * shape. That is not ceremony: this surface renders whatever a hub of any
 * version answers with, and a field that arrives missing or renamed has to
 * degrade to "not reported yet" — the state the card already draws correctly —
 * instead of throwing inside a list of locations.
 *
 * ## Three states, and the third is the point
 *
 * `estimatedEmptyAtMs` is NULLABLE, and null means the growth that paces the
 * drain has not been observed yet. There is no date to show and there must not
 * appear to be one: a placeholder that looks like data is the failure this
 * whole line of work has been about. So:
 *
 *  - not draining        → the card draws nothing;
 *  - draining, estimated → bytes remaining AND a date;
 *  - draining, no estimate yet → bytes remaining, and the absence stated.
 */
import type { StorageLocation } from '@camstack/types'

/** One row of `storage.listDrainProgress`, after narrowing. */
export interface DrainProgressRow {
  readonly locationId: string
  readonly startedAtMs: number
  /** Owned bytes when the drain began — the denominator of {@link drainedFraction}. */
  readonly startBytes: number
  readonly bytesRemaining: number
  readonly drained: boolean
  /** Null until the growth that paces the drain has been observed. NEVER
   *  substitute a value for this — see the module docblock. */
  readonly estimatedEmptyAtMs: number | null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function finiteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Narrow one raw row, or `null` when it is not one.
 *
 * `estimatedEmptyAtMs` is the only field allowed to be absent — it is
 * legitimately null on the wire, and an older hub that omits the key entirely
 * means the same thing. Every other field is load-bearing: without
 * `bytesRemaining` there is nothing to report, and reporting a partial row
 * would put a number next to a location it may not belong to.
 */
export function toDrainProgressRow(raw: unknown): DrainProgressRow | null {
  if (!isRecord(raw)) return null
  const locationId = raw['locationId']
  if (typeof locationId !== 'string' || locationId.length === 0) return null
  const startedAtMs = finiteNumber(raw['startedAtMs'])
  const startBytes = finiteNumber(raw['startBytes'])
  const bytesRemaining = finiteNumber(raw['bytesRemaining'])
  if (startedAtMs === null || startBytes === null || bytesRemaining === null) return null
  if (typeof raw['drained'] !== 'boolean') return null
  return {
    locationId,
    startedAtMs,
    startBytes,
    bytesRemaining,
    drained: raw['drained'],
    estimatedEmptyAtMs: finiteNumber(raw['estimatedEmptyAtMs']),
  }
}

/**
 * Narrow a whole response into a lookup by location id.
 *
 * A malformed row is DROPPED, not fatal: the other locations on the page still
 * have progress to show, and one bad row must not blank the list. A response
 * that is not an array at all — which is what a hub too old for the method
 * answers with, once the caller has caught the "no such procedure" error —
 * yields an empty map, and every card falls back to "not reported yet".
 */
export function toDrainProgressById(raw: unknown): ReadonlyMap<string, DrainProgressRow> {
  const out = new Map<string, DrainProgressRow>()
  if (!Array.isArray(raw)) return out
  for (const entry of raw) {
    const row = toDrainProgressRow(entry)
    if (row !== null) out.set(row.locationId, row)
  }
  return out
}

/**
 * Fraction of the starting bytes that has LEFT, in [0, 1].
 *
 * This is the number a draining disk wants on its bar. The capacity bar
 * measures fill, and fill on a draining location is the operator watching the
 * wrong thing go down slowly; drain progress goes UP and reaches an end.
 *
 * Null when it cannot be computed honestly:
 *
 *  - `startBytes === 0` — there was nothing to drain, so there is no fraction
 *    of it (and no division by zero);
 *  - `bytesRemaining > startBytes` — the location GREW after the drain began,
 *    which happens while writes are still landing elsewhere in the same tree.
 *    Progress is not negative and it is not zero-because-nothing-happened; it
 *    is unknown, and the card says the bytes without the bar.
 */
export function drainedFraction(row: DrainProgressRow): number | null {
  if (row.startBytes <= 0) return null
  if (row.bytesRemaining > row.startBytes) return null
  const drained = row.startBytes - row.bytesRemaining
  return Math.min(1, Math.max(0, drained / row.startBytes))
}

/**
 * What the card renders for one location.
 *
 * `idle` is not "no data" — it is "this location is not draining", and it is
 * the reason the card draws nothing at all rather than an empty progress line.
 */
export type DrainDisplay =
  | { readonly kind: 'idle' }
  /** Draining, and the hub has not reported on it yet — an old hub, or a drain
   *  that has just been set. Today's honest sentence. */
  | { readonly kind: 'unreported' }
  | {
      readonly kind: 'draining'
      readonly bytesRemaining: number
      /** See {@link drainedFraction} — null means no bar, never a bar at 0. */
      readonly drainedFraction: number | null
      /** Null means the estimate is not available YET, and the card says so. */
      readonly estimatedEmptyAtMs: number | null
    }
  /** The drain finished: nothing left to move. Distinct from `idle`, because
   *  the location is still IN drain mode and the operator may act on that. */
  | { readonly kind: 'drained' }

/**
 * Combine the location's own state with the progress row.
 *
 * `draining` is the LOCATION's business, not the progress list's: a location
 * the hub has not reported on must still say "draining", or the row silently
 * becomes indistinguishable from a healthy one at exactly the moment the
 * operator is watching it.
 */
export function describeDrain(draining: boolean, row: DrainProgressRow | undefined): DrainDisplay {
  if (!draining) return { kind: 'idle' }
  if (row === undefined) return { kind: 'unreported' }
  if (row.drained || row.bytesRemaining <= 0) return { kind: 'drained' }
  return {
    kind: 'draining',
    bytesRemaining: row.bytesRemaining,
    drainedFraction: drainedFraction(row),
    estimatedEmptyAtMs: row.estimatedEmptyAtMs,
  }
}

/**
 * Is this location draining?
 *
 * Deliberately tolerant of BOTH spellings the fleet has: the four-state `mode`
 * the hub reports today (`active | readonly | drain | disabled`) and the older
 * `config.readOnly === true` a location persisted before it existed still reads
 * back with. A card that understood only one of them would show nothing for
 * half the fleet, which is the failure mode this whole card exists to avoid.
 */
export function isLocationDraining(
  location: Pick<StorageLocation, 'config'> & { readonly mode?: unknown },
): boolean {
  if (location.mode === 'drain') return true
  return location.config['readOnly'] === true
}
