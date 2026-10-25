/**
 * Appearance comparison for tracker v2 (D683 §8.2). Pure.
 *
 * Bhattacharyya distance per block, averaged over the blocks both sides can
 * speak for: all six in colour, only value and gradient when either side is
 * gray. A tracklet's aggregate keeps a COLOUR mean and a GRAY mean apart, so a
 * dusk IR read never pollutes the hue blocks a daylight read built.
 * `undefined` means "cannot compare" and is never agreement or disagreement.
 */
import {
  APPEARANCE_BIN_COUNT,
  APPEARANCE_BLOCKS,
  type AppearanceBlockName,
  type AppearanceDescriptor,
} from '@camstack/types'
import { APPEARANCE_DIFF_EPSILON } from './constants.js'

export interface AppearanceVector {
  readonly bins: readonly number[]
  readonly gray: boolean
}

export interface AppearanceMean {
  readonly bins: readonly number[]
  readonly count: number
}

export interface AppearanceAggregate {
  readonly colour: AppearanceMean | null
  readonly gray: AppearanceMean | null
}

const COLOUR_BLOCKS: readonly AppearanceBlockName[] = [
  'upperHs',
  'upperV',
  'upperGrad',
  'lowerHs',
  'lowerV',
  'lowerGrad',
]
const GRAY_BLOCKS: readonly AppearanceBlockName[] = ['upperV', 'upperGrad', 'lowerV', 'lowerGrad']

function blockDistance(
  a: readonly number[],
  b: readonly number[],
  block: AppearanceBlockName,
): number | undefined {
  const [from, to] = APPEARANCE_BLOCKS[block]
  let sa = 0
  let sb = 0
  for (let i = from; i < to; i++) {
    sa += a[i] ?? 0
    sb += b[i] ?? 0
  }
  if (!(sa > 0) || !(sb > 0)) return undefined
  let bc = 0
  for (let i = from; i < to; i++) bc += Math.sqrt(((a[i] ?? 0) / sa) * ((b[i] ?? 0) / sb))
  const diff = Math.max(0, 1 - Math.min(1, bc))
  return diff < APPEARANCE_DIFF_EPSILON ? 0 : Math.sqrt(diff)
}

export function appearanceDistance(a: AppearanceVector, b: AppearanceVector): number | undefined {
  if (a.bins.length !== APPEARANCE_BIN_COUNT || b.bins.length !== APPEARANCE_BIN_COUNT)
    return undefined
  const blocks = a.gray || b.gray ? GRAY_BLOCKS : COLOUR_BLOCKS
  let sum = 0
  let n = 0
  for (const block of blocks) {
    const d = blockDistance(a.bins, b.bins, block)
    if (d === undefined) continue
    sum += d
    n += 1
  }
  return n === 0 ? undefined : sum / n
}

function foldMean(mean: AppearanceMean | null, bins: readonly number[]): AppearanceMean {
  if (mean === null) return { bins: [...bins], count: 1 }
  const count = mean.count + 1
  return { bins: mean.bins.map((v, i) => v + ((bins[i] ?? 0) - v) / count), count }
}

export function foldAppearance(
  agg: AppearanceAggregate | null,
  d: AppearanceDescriptor,
): AppearanceAggregate {
  const base: AppearanceAggregate = agg ?? { colour: null, gray: null }
  return d.gray
    ? { ...base, gray: foldMean(base.gray, d.bins) }
    : { ...base, colour: foldMean(base.colour, d.bins) }
}

/** A probe against an aggregate: its own mode first, the other mode on value+gradient only. */
export function distanceToAggregate(
  agg: AppearanceAggregate,
  d: AppearanceVector,
): number | undefined {
  const same = d.gray ? agg.gray : agg.colour
  if (same !== null) return appearanceDistance({ bins: same.bins, gray: d.gray }, d)
  const other = d.gray ? agg.colour : agg.gray
  return other === null ? undefined : appearanceDistance({ bins: other.bins, gray: true }, d)
}

export function aggregateDistance(
  a: AppearanceAggregate,
  b: AppearanceAggregate,
): number | undefined {
  if (a.colour !== null && b.colour !== null) {
    return appearanceDistance(
      { bins: a.colour.bins, gray: false },
      { bins: b.colour.bins, gray: false },
    )
  }
  if (a.gray !== null && b.gray !== null) {
    return appearanceDistance({ bins: a.gray.bins, gray: true }, { bins: b.gray.bins, gray: true })
  }
  const x = a.colour ?? a.gray
  const y = b.colour ?? b.gray
  return x === null || y === null
    ? undefined
    : appearanceDistance({ bins: x.bins, gray: true }, { bins: y.bins, gray: true })
}
