/**
 * Stored rows → the wire points of a query (PURE). What a point MEANS depends on
 * the series' kind:
 *
 *  - `gauge` / `boolean`: the stored numbers as they are (`twMean` of a boolean
 *    is the fraction of time true);
 *  - `counter`: plus `delta`, the growth since the previous point or bucket. A
 *    reading LOWER than the previous one is a reset (a replaced meter, a
 *    firmware wipe): the growth is counted from zero, never negative. With no
 *    previous reading, a bucket's own growth is `last - min`;
 *  - `enum`: the stored number is an ordinal, so `mean` / `twMean` mean nothing
 *    and are `null`; `state` names the ordinal and a rollup's `states` gives the
 *    milliseconds spent in each state, by name.
 */
import type { DeviceHistoryKind, DeviceHistoryQueryPoint } from '@camstack/types'
import type { RawPoint, RollupRow } from '../rollup/rollup-math.js'

export interface SeriesMeaning {
  readonly kind: DeviceHistoryKind
  /** `enum`: the value of each ordinal; `null` otherwise. */
  readonly values: readonly string[] | null
}

/** kWh in one W·ms: 1 kWh = 1 000 W × 3 600 000 ms. */
export const KWH_PER_WATT_MS: number = 1 / 3_600_000_000

/** Growth from `prev` to `cur`; a drop is a reset counted from zero. `fallback` when `prev` is unknown. */
export function counterDelta(
  prev: number | null,
  cur: number | null,
  fallback: number | null,
): number | null {
  if (cur === null) return null
  if (prev === null) return fallback
  return cur >= prev ? cur - prev : cur
}

/** The name of an ordinal, or `null` when the series is not an enum or the ordinal is unknown. */
export function stateName(meaning: SeriesMeaning, ordinal: number | null): string | null {
  if (meaning.kind !== 'enum' || meaning.values === null || ordinal === null) return null
  return meaning.values[ordinal] ?? null
}

function namedStates(
  meaning: SeriesMeaning,
  states: Readonly<Record<string, number>> | null,
): Readonly<Record<string, number>> | null {
  if (meaning.kind !== 'enum' || states === null) return null
  const out: Record<string, number> = {}
  for (const [ordinal, ms] of Object.entries(states)) {
    const name = stateName(meaning, Number(ordinal))
    if (name !== null) out[name] = (out[name] ?? 0) + ms
  }
  return out
}

/** Raw points, oldest first; `prev` is the value of the point before the first one. */
export function rawPoints(
  rows: readonly RawPoint[],
  meaning: SeriesMeaning,
  prev: number | null,
): readonly DeviceHistoryQueryPoint[] {
  const isEnum = meaning.kind === 'enum'
  let held = prev
  return rows.map((r) => {
    const delta = meaning.kind === 'counter' ? counterDelta(held, r.value, null) : null
    held = r.value
    return {
      t: r.ts,
      samples: 1,
      mean: isEnum ? null : r.value,
      twMean: null,
      min: r.value,
      max: r.value,
      last: r.value,
      delta,
      state: stateName(meaning, r.value),
      states: null,
    }
  })
}

/** Rollup rows, oldest first; `prevLast` is the `last` of the bucket before the first one. */
export function rollupPoints(
  rows: readonly RollupRow[],
  meaning: SeriesMeaning,
  prevLast: number | null,
): readonly DeviceHistoryQueryPoint[] {
  const isEnum = meaning.kind === 'enum'
  let held = prevLast
  return rows.map((row) => {
    const delta =
      meaning.kind === 'counter'
        ? counterDelta(held, row.last, row.last === null ? null : row.last - row.min)
        : null
    if (row.last !== null) held = row.last
    return {
      t: row.bucketStart,
      samples: row.samples,
      mean: isEnum || row.samples <= 0 ? null : row.sum / row.samples,
      twMean:
        !isEnum && row.twSum !== null && row.twMs !== null && row.twMs > 0
          ? row.twSum / row.twMs
          : null,
      min: row.min,
      max: row.max,
      last: row.last,
      delta,
      state: stateName(meaning, row.last),
      states: namedStates(meaning, row.states),
    }
  })
}

/** Energy used in each bucket of a `watts` gauge: its time-weighted integral, in kWh. */
export function integratedEnergyPoints(
  rows: readonly RollupRow[],
): readonly DeviceHistoryQueryPoint[] {
  return rows.map((row) => ({
    t: row.bucketStart,
    samples: row.samples,
    mean: null,
    twMean: null,
    min: row.min,
    max: row.max,
    last: null,
    delta: row.twSum === null ? null : row.twSum * KWH_PER_WATT_MS,
    state: null,
    states: null,
  }))
}
