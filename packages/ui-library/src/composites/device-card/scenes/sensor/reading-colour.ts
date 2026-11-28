/**
 * The colour of one reading of a composed sensor: a slot of the chart palette
 * (`--color-chart-series-a..h`, `charts/chart-palette.ts`), so the wedge or tile and
 * the history chart under it wear the same token. Each quantity has a PREFERRED slot
 * (humidity is the blue one wherever it is free); when two readings of ONE card want
 * the same slot the later one takes the next free slot, so on one card no two readings
 * share a colour. The preferred slots of the quantities that sit together on a sensor
 * (humidity, voc, illuminance, co2, temperature, motion, pm25, pm10) are all different;
 * aqi and power take the slots of pm25 and pm10, which they do not share a card with.
 * The palette has eight slots, so a card with more than eight readings repeats slots,
 * like the chart's own lap.
 */
import type { HeroMeasurementQuantity } from '@dominevo/types'
import { CHART_SERIES_TOKENS } from '../../../charts/chart-palette'

const PREFERRED_SLOT: Readonly<Record<HeroMeasurementQuantity, number>> = {
  humidity: 0,
  voc: 1,
  illuminance: 2,
  co2: 3,
  temperature: 4,
  motion: 5,
  pm25: 6,
  pm10: 7,
  aqi: 6,
  power: 7,
  contact: 3,
  text: 5,
}

/** The slot of each reading of a card, in order; all different while the palette lasts. */
export function assignReadingSlots(
  quantities: readonly HeroMeasurementQuantity[],
): readonly number[] {
  const size = CHART_SERIES_TOKENS.length
  const taken = new Set<number>()
  return quantities.map((quantity) => {
    let slot = PREFERRED_SLOT[quantity]
    for (let tried = 0; tried < size && taken.has(slot); tried += 1) slot = (slot + 1) % size
    taken.add(slot)
    if (taken.size >= size) taken.clear()
    return slot
  })
}

export interface ReadingSlotClasses {
  /** A pie wedge: fill and edge. */
  readonly wedge: string
  readonly wedgeSelected: string
  /** A grid tile: tint and border. */
  readonly tile: string
  readonly tileSelected: string
}

const SLOT_A: ReadingSlotClasses = {
  wedge: 'fill-chart-series-a/25 stroke-chart-series-a/60',
  wedgeSelected: 'fill-chart-series-a/45 stroke-chart-series-a',
  tile: 'bg-chart-series-a/10 border-chart-series-a/40',
  tileSelected: 'bg-chart-series-a/25 border-chart-series-a',
}

/** Spelled out so Tailwind finds every class. */
const SLOT_CLASSES: readonly ReadingSlotClasses[] = [
  SLOT_A,
  {
    wedge: 'fill-chart-series-b/25 stroke-chart-series-b/60',
    wedgeSelected: 'fill-chart-series-b/45 stroke-chart-series-b',
    tile: 'bg-chart-series-b/10 border-chart-series-b/40',
    tileSelected: 'bg-chart-series-b/25 border-chart-series-b',
  },
  {
    wedge: 'fill-chart-series-c/25 stroke-chart-series-c/60',
    wedgeSelected: 'fill-chart-series-c/45 stroke-chart-series-c',
    tile: 'bg-chart-series-c/10 border-chart-series-c/40',
    tileSelected: 'bg-chart-series-c/25 border-chart-series-c',
  },
  {
    wedge: 'fill-chart-series-d/25 stroke-chart-series-d/60',
    wedgeSelected: 'fill-chart-series-d/45 stroke-chart-series-d',
    tile: 'bg-chart-series-d/10 border-chart-series-d/40',
    tileSelected: 'bg-chart-series-d/25 border-chart-series-d',
  },
  {
    wedge: 'fill-chart-series-e/25 stroke-chart-series-e/60',
    wedgeSelected: 'fill-chart-series-e/45 stroke-chart-series-e',
    tile: 'bg-chart-series-e/10 border-chart-series-e/40',
    tileSelected: 'bg-chart-series-e/25 border-chart-series-e',
  },
  {
    wedge: 'fill-chart-series-f/25 stroke-chart-series-f/60',
    wedgeSelected: 'fill-chart-series-f/45 stroke-chart-series-f',
    tile: 'bg-chart-series-f/10 border-chart-series-f/40',
    tileSelected: 'bg-chart-series-f/25 border-chart-series-f',
  },
  {
    wedge: 'fill-chart-series-g/25 stroke-chart-series-g/60',
    wedgeSelected: 'fill-chart-series-g/45 stroke-chart-series-g',
    tile: 'bg-chart-series-g/10 border-chart-series-g/40',
    tileSelected: 'bg-chart-series-g/25 border-chart-series-g',
  },
  {
    wedge: 'fill-chart-series-h/25 stroke-chart-series-h/60',
    wedgeSelected: 'fill-chart-series-h/45 stroke-chart-series-h',
    tile: 'bg-chart-series-h/10 border-chart-series-h/40',
    tileSelected: 'bg-chart-series-h/25 border-chart-series-h',
  },
]

/** The slot a reading wears: the card-assigned one, else its quantity's preferred one. */
export function readingSlot(reading: {
  readonly quantity: HeroMeasurementQuantity
  readonly slot?: number | undefined
}): number {
  return (reading.slot ?? PREFERRED_SLOT[reading.quantity]) % SLOT_CLASSES.length
}

export function readingClasses(reading: {
  readonly quantity: HeroMeasurementQuantity
  readonly slot?: number | undefined
}): ReadingSlotClasses {
  return SLOT_CLASSES[readingSlot(reading)] ?? SLOT_A
}
