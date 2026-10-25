/**
 * audio-level-density — the LEVEL of a timeline bucket, as opposed to its count.
 *
 * The viewer's audio lane painted `EventDensityBucket.audio` — the number of
 * audio events — on the same six-rung meter the live view uses for dBFS. Fifty
 * brief clicks in a quiet hour lit every rung, whatever their volume, which is
 * the operator's "anche durante ore calme mostra il massimo del livello" [even during quiet hours it shows the maximum level]. It is
 * a category error rather than a scaling one: the bar never read a level.
 *
 * This computes the level the bar should have been reading, on the hub, where
 * the samples already are — one number per bucket instead of thousands of
 * events crossing the wire (D431). See `__tests__/audio-level-density.spec.ts`
 * for the measured mapping this replaces.
 */

/** The two fields of an audio event this file needs. */
export interface AudioLevelSample {
  readonly timestamp: number
  readonly dbfs: number
}

/**
 * The energy-weighted mean of a set of dBFS values, in dBFS.
 *
 * dBFS is logarithmic, so an arithmetic mean of dB numbers is the mean of
 * nothing physical — it under-weights the loud moment that is the reason to
 * look at a bar at all. Averaging POWER and converting back is what a meter is
 * expected to show, and it is the same arithmetic as an RMS over the interval.
 *
 * `undefined` for an empty set, and for a set with no finite sample: a bucket
 * nobody measured must not be reported as silence, and −∞ dBFS is not a number
 * a bar can paint.
 */
export function energyWeightedMeanDbfs(samples: readonly number[]): number | undefined {
  let power = 0
  let n = 0
  for (const dbfs of samples) {
    // A stored −Infinity (digital silence) contributes zero power, which is
    // arithmetically true and keeps it from poisoning everything measured
    // beside it. NaN carries no claim at all and is dropped.
    if (Number.isNaN(dbfs)) continue
    if (dbfs === Number.NEGATIVE_INFINITY) {
      n += 1
      continue
    }
    if (!Number.isFinite(dbfs)) continue
    power += 10 ** (dbfs / 10)
    n += 1
  }
  if (n === 0) return undefined
  const mean = power / n
  if (mean <= 0) return undefined
  return 10 * Math.log10(mean)
}

/**
 * Energy-weighted mean dBFS per bucket index, for the buckets that HAVE audio.
 *
 * A bucket with no events is absent from the map rather than present at zero:
 * "nothing was heard" and "nothing was measured" are different claims, and the
 * lane has to be able to draw nothing.
 */
export function audioDbfsByBucket(
  events: readonly AudioLevelSample[],
  since: number,
  bucketMs: number,
): Map<number, number> {
  const out = new Map<number, number>()
  if (bucketMs <= 0) return out
  const byBucket = new Map<number, number[]>()
  for (const ev of events) {
    const idx = Math.floor((ev.timestamp - since) / bucketMs)
    if (idx < 0) continue
    const bin = byBucket.get(idx)
    if (bin === undefined) byBucket.set(idx, [ev.dbfs])
    else bin.push(ev.dbfs)
  }
  for (const [idx, samples] of byBucket) {
    const mean = energyWeightedMeanDbfs(samples)
    if (mean !== undefined) out.set(idx, mean)
  }
  return out
}

/** One device-history point of the audio level series; only `max` is read. */
export interface AudioLevelHistoryPoint {
  readonly t: number
  readonly max: number
}

/**
 * PEAK dBFS per bucket index from device-history points (D431 follow-up).
 *
 * The bar answers "was it loud here", so a bucket reports the loudest window
 * in it. A raw point has `max === value`; a rollup row's `max` is the loudest
 * point it covers, which a mean would flatten. A bucket with no point is
 * absent — never zero. A rollup row also credits a held value across a quiet
 * gap, so its max can echo an earlier measured peak.
 */
export function audioPeakByBucket(
  points: readonly AudioLevelHistoryPoint[],
  since: number,
  bucketMs: number,
): Map<number, number> {
  const out = new Map<number, number>()
  if (bucketMs <= 0) return out
  for (const p of points) {
    if (!Number.isFinite(p.max)) continue
    const idx = Math.floor((p.t - since) / bucketMs)
    if (idx < 0) continue
    const prev = out.get(idx)
    if (prev === undefined || p.max > prev) out.set(idx, p.max)
  }
  return out
}
