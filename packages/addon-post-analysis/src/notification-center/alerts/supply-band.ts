/**
 * A supply or waste consumable reduced to the only thing worth storing: its band (D642).
 *
 * These are `supply` or `waste` items on a device's `consumables` slice
 * (D915 — before it, the four vacuum reservoirs lived on `vacuum-control`): a
 * vacuum's clean water, dirty water, detergent and dust bin, a dishwasher's
 * salt and rinse aid. `consumable-routing.ts` narrows the item's status to the
 * band vocabulary below. The operator asked for them to notify like
 * consumables: a supply running low, a waste reservoir full.
 *
 * ## The verdict is the provider's
 *
 * The item's `status` is the device's own sensor (`ok` | `low` | `full`),
 * and it is the ONLY thing judged. The hub has no threshold for a fill level:
 * the rule for thresholds is that they belong to whoever generates the event,
 * and an item that says `low` has already decided. An item that reports only a
 * `level` is therefore not judged at all (`null`) rather than judged against a
 * number the hub would have to invent.
 *
 * ## `null` is the third answer, and it is not `normal`
 *
 * An unknown status says nothing — it neither opens nor closes an episode, for
 * the reason `battery-band.ts` gives: a reading nobody took is not evidence
 * that anything changed.
 *
 * Episodes use `consumable:<deviceId>:<key>` (D934). Pure. No clock, no I/O.
 */

/**
 * Supply/waste items judged on the provider verdict (D934),
 * by their item key — the four a vacuum reports. Any other supply item (salt,
 * rinse aid, …) is worded by its label (`body.item`).
 */
const NC_NAMED_SUPPLY_KEYS = ['cleanWater', 'dirtyWater', 'detergent', 'dustBin'] as const
export type NcNamedSupplyKey = (typeof NC_NAMED_SUPPLY_KEYS)[number]

export function isNamedSupplyKey(key: string): key is NcNamedSupplyKey {
  return NC_NAMED_SUPPLY_KEYS.some((k) => k === key)
}

/** One provider-judged supply/waste item, as the band derivation reads it. */
export interface NcSupplyReading {
  /** The item key; the episode subject is built from it. */
  readonly key: string
  /** The provider's name for it — the sentence when there is no named body. */
  readonly label?: string
  /** Fill 0..100, or `null` when not measured. Never judged — see above. */
  readonly level: number | null
  readonly status: 'ok' | 'low' | 'full' | null
}

/**
 * How long a provider verdict change must HOLD before it counts (D642 review M2).
 *
 * A float switch sloshing at the edge of `low` / `full` flips its status back
 * and forth while the robot moves; each flip is a durable transition, and
 * without a hold each one is a raise and a recovery on the operator's phone.
 * One minute is two reload ticks: long enough to outlast a slosh, short enough
 * that a genuinely full dust bin is said within a minute and a half.
 */
export const NC_SUPPLY_HOLD_MS = 60_000

/** The band a supply/waste item is in. `null` is the third answer — see above. */
export type NcSupplyBand = 'low' | 'full' | 'normal'

export function deriveSupplyBand(reading: NcSupplyReading): NcSupplyBand | null {
  switch (reading.status) {
    case 'low':
      return 'low'
    case 'full':
      return 'full'
    case 'ok':
      return 'normal'
    case null:
      return null
  }
}
