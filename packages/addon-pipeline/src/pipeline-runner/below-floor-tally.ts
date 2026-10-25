/**
 * below-floor-tally — how many boxes the operator's per-class confidence floor
 * took from the tracker, per camera, per class, per score band (D665).
 *
 * The executor records every box `macroGateVerdict` refuses on
 * `FrameResult.discarded` with reason `below-threshold` — for the viewer's
 * ghost overlay. Nothing COUNTED them, so on 2026-09-27 the share of camera
 * 104's re-splits caused by the 0.65 person floor could not be measured: the
 * tracker logged 0 person boxes under 0.65 because it is never handed one.
 *
 * The count rides the existing per-camera `pipeline stats` line (every 10 s),
 * never one line per box. The bands are the two numbers the question is about:
 * `0.35` is the tracker's low-score continuation floor (below it a box is not
 * even continuation evidence), `0.65` the person default; `>=0.65` is what an
 * operator floor set above the default removes.
 */
import type { DiscardedDetection } from '@camstack/types'

export const BELOW_FLOOR_BANDS = ['<0.35', '0.35-0.50', '0.50-0.65', '>=0.65'] as const
export type BelowFloorBand = (typeof BELOW_FLOOR_BANDS)[number]

/** class → band → count. A class or band absent from the map counted zero. */
export type BelowFloorTally = Readonly<
  Record<string, Readonly<Partial<Record<BelowFloorBand, number>>>>
>

type MutableTally = Record<string, Partial<Record<BelowFloorBand, number>>>

export function belowFloorBand(score: number): BelowFloorBand {
  if (score < 0.35) return '<0.35'
  if (score < 0.5) return '0.35-0.50'
  if (score < 0.65) return '0.50-0.65'
  return '>=0.65'
}

function addInto(into: MutableTally, macroClass: string, band: BelowFloorBand, n: number): void {
  const row = into[macroClass] ?? {}
  row[band] = (row[band] ?? 0) + n
  into[macroClass] = row
}

/** One frame's `below-threshold` discards, tallied. Other reasons are not the
 *  floor's doing and are not counted here. */
export function tallyBelowFloor(
  discarded: readonly DiscardedDetection[] | undefined,
): BelowFloorTally {
  const out: MutableTally = {}
  if (discarded === undefined) return out
  for (const d of discarded) {
    if (d.reason !== 'below-threshold') continue
    addInto(out, d.macroClass, belowFloorBand(d.score), 1)
  }
  return out
}

/** Per-device running sum between two stats reports. */
export class BelowFloorAccumulator {
  private readonly byDevice = new Map<number, MutableTally>()

  add(deviceId: number, tally: BelowFloorTally): void {
    const classes = Object.keys(tally)
    if (classes.length === 0) return
    const into = this.byDevice.get(deviceId) ?? {}
    for (const macroClass of classes) {
      const row = tally[macroClass]
      if (row === undefined) continue
      for (const band of BELOW_FLOOR_BANDS) {
        const n = row[band]
        if (n !== undefined && n > 0) addInto(into, macroClass, band, n)
      }
    }
    this.byDevice.set(deviceId, into)
  }

  /** The sum since the last drain, and reset. `{}` is a measured zero. */
  drain(deviceId: number): BelowFloorTally {
    const out = this.byDevice.get(deviceId) ?? {}
    this.byDevice.delete(deviceId)
    return out
  }
}
