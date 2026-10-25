/**
 * A consumable item reduced to the only thing worth storing: its BAND.
 *
 * The same shape as `battery-band.ts`, for the same reasons, and the operator
 * asked for exactly that: "vanno trattati come le notifiche per batterie". What
 * differs is the SOURCE — the `consumables` cap carries two independent
 * readings per item and either may be absent:
 *
 *  - `level` — remaining life 0..100, a MEASUREMENT the operator's threshold
 *    speaks about;
 *  - `status` — `'ok' | 'replace'`, a VERDICT the provider already reached.
 *
 * ## When both are present, EITHER may raise the alarm
 *
 * This is the one place the consumable rule departs from the battery's, and
 * deliberately. A binary battery ignores the threshold because the provider is
 * the authority and there is nothing else to read. A consumable can report both
 * at once — the cap says so — and the two can disagree: a filter at 5 % life
 * whose provider still says `ok`, or a mop pad reported `replace` with no level
 * at all.
 *
 * Silence is the expensive mistake here. A worn part that nobody is told about
 * keeps wearing; a notification the operator did not need costs a glance. So a
 * `replace` verdict raises it, a level at or under the threshold raises it, and
 * `normal` requires BOTH to be quiet. The battery's direction — the provider
 * decides — is preserved where it applies: a `replace` is honoured whatever the
 * level says, and is never overturned by a healthy percentage.
 *
 * ## `null` is the third answer, and it is not `normal`
 *
 * An item whose `level` and `status` are both absent has told us nothing. The
 * cap's own docblock describes exactly that item — "a provider may only know
 * the item exists". Seeding it healthy would be a claim, and the first genuine
 * `replace` would then read as a transition out of a state nobody observed.
 * (The same third state `battery-band.ts` exists to protect.)
 *
 * Pure. No clock, no I/O.
 */

/** The band an item is in. `null` is the third answer — see above. */
export type NcConsumableBand = 'low' | 'normal'

/**
 * Hysteresis on the MEASURED side only, mirroring the battery's.
 *
 * A level that oscillates around the threshold must not produce alternating
 * low/normal pairs. There is nothing to smooth on the verdict side: a provider
 * that flips `ok`/`replace` is stating a decision, not a reading.
 */
export const CONSUMABLE_LOW_HYSTERESIS_PCT = 5

export interface NcConsumableReading {
  /** Remaining life %, or `null` when the provider does not measure it. */
  readonly level: number | null
  /** The provider's own verdict, or `null` when it has none. */
  readonly status: 'ok' | 'replace' | null
}

export interface NcConsumableBandInput {
  readonly reading: NcConsumableReading
  readonly thresholdPercent: number
  /** The band the ledger already holds, for hysteresis. */
  readonly previous: NcConsumableBand | undefined
}

export function deriveConsumableBand(input: NcConsumableBandInput): NcConsumableBand | null {
  const { level, status } = input.reading
  const measured = level !== null && Number.isFinite(level)
  if (!measured && status === null) return null

  // The provider's verdict, honoured whatever the measurement says. A
  // `replace` is never talked out of by a healthy percentage.
  if (status === 'replace') return 'low'

  if (!measured) {
    // `status === 'ok'` and nothing measured: the provider is the only voice.
    return 'normal'
  }
  const value = level as number
  if (input.previous === 'low') {
    // Climbing out takes the threshold PLUS the hysteresis — a part is only
    // "no longer low" once it has clearly recovered, which for a consumable
    // means it was replaced.
    return value >= input.thresholdPercent + CONSUMABLE_LOW_HYSTERESIS_PCT ? 'normal' : 'low'
  }
  return value <= input.thresholdPercent ? 'low' : 'normal'
}
