/**
 * Which tiers a camera is allowed to claim.
 *
 * Derived from the sensor, never assumed: a 1080p camera that advertises 4K is
 * telling the controller it can do something it cannot, and that surfaces as a
 * stream which never starts rather than as a refusal anyone can read.
 *
 * ## The table is the specification, not a suggestion
 *
 * § 2 *Minimum Requirements*: *"The accessory must support at least three
 * concurrent video encodings on each sensor"*, and for 16:9 it names them:
 *
 * |            | 4K camera | 2K camera | 1080p camera |
 * | ---------- | --------- | --------- | ------------ |
 * | **High**   | 3840x2160 | 2560x1440 | 1920x1080    |
 * | **Medium** | 1920x1080 | 1920x1080 | 1280x720     |
 * | **Low**    | 640x360   | 640x360   | 640x360      |
 *
 * The first version of this file built the list by pushing 1080p and 360p onto
 * whatever big tier applied, which is right for 4K and 2K and produces only
 * TWO tiers for a 1080p camera — its medium is 720p, and nothing emitted it.
 * Writing the table out means the 1080p column cannot be an afterthought.
 *
 * A tier's MEDIUM resolution can exceed what the camera publishes natively —
 * a 4K camera whose middle stream is 720p still owes a 1080p tier. That is the
 * specification's demand, not ours, and it is a demand on the ENCODER rather
 * than on the sensor.
 *
 * `HIGHEST` is never emitted: the guide reserves it for a 4K camera that also
 * serves 2K SIMULTANEOUSLY, and we cannot prove we do.
 */
import { TierQuality, type VideoStreamTier } from './video-stream-tiers.js'

interface TierSpec {
  readonly width: number
  readonly height: number
  readonly frameRate: number
}

/**
 * Target average and MAXIMUM bitrate per resolution, § 2.
 *
 * The maxima are the reason this is a table and not a multiplier. A peak
 * computed as average × 1.1 reads as "the 10% gap the guide recommends", and it
 * overshoots three of these five rows — 1080p would claim 1870 against a
 * ceiling of 1800, and *"maximum bitrates should not be exceeded"*.
 */
const BITRATE_BY_WIDTH: ReadonlyMap<number, { average: number; peak: number }> = new Map([
  [3840, { average: 4500, peak: 5000 }],
  [2560, { average: 2800, peak: 3000 }],
  [1920, { average: 1700, peak: 1800 }],
  [1280, { average: 768, peak: 800 }],
  [640, { average: 180, peak: 190 }],
])

/** The lowest row, for a width the table does not name. Claiming a small
 *  budget for an unexpected size is the safe direction: it under-promises. */
const FALLBACK_BITRATE = { average: 180, peak: 190 }

function bitrateFor(width: number): { average: number; peak: number } {
  return BITRATE_BY_WIDTH.get(width) ?? FALLBACK_BITRATE
}

export function averageBitrateKbpsFor(width: number): number {
  return bitrateFor(width).average
}

export function peakBitrateKbpsFor(width: number): number {
  return bitrateFor(width).peak
}

/** The three rows of the table, by the column the sensor falls in. */
function rowsForSensor(width: number, height: number): readonly TierSpec[] {
  if (width >= 3840 && height >= 2160) {
    return [
      { width: 3840, height: 2160, frameRate: 30 },
      { width: 1920, height: 1080, frameRate: 30 },
      { width: 640, height: 360, frameRate: 15 },
    ]
  }
  if (width >= 2560 && height >= 1440) {
    return [
      { width: 2560, height: 1440, frameRate: 30 },
      { width: 1920, height: 1080, frameRate: 30 },
      { width: 640, height: 360, frameRate: 15 },
    ]
  }
  // Everything smaller is a 1080p-class camera. A sensor BETWEEN the rows —
  // 2304x1296 on this fleet's baby monitor — takes the lower column: the
  // guide allows resolutions "approximate to these values", and approximating
  // downwards never claims a stream the camera cannot produce.
  return [
    { width: 1920, height: 1080, frameRate: 30 },
    { width: 1280, height: 720, frameRate: 30 },
    { width: 640, height: 360, frameRate: 15 },
  ]
}

export function tiersForSensor(width: number, height: number): readonly VideoStreamTier[] {
  const rows = rowsForSensor(width, height)
  const qualities = [TierQuality.HIGH, TierQuality.MEDIUM, TierQuality.LOW] as const
  return rows.map((row, index) => ({
    identifier: index + 1,
    quality: qualities[index] ?? TierQuality.LOW,
    targetAverageBitrateKbps: averageBitrateKbpsFor(row.width),
    width: row.width,
    height: row.height,
    frameRate: row.frameRate,
  }))
}
