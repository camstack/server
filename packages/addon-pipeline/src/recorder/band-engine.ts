import type { RecordingBand } from './config-types.js'

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(':')
  return Number(h) * 60 + Number(m)
}

export function bandActiveAt(band: RecordingBand, date: Date): boolean {
  const wd = date.getDay()
  const prevWd = (wd + 6) % 7
  const t = date.getHours() * 60 + date.getMinutes()
  const s = toMin(band.start)
  const e = toMin(band.end)
  const applies = (d: number): boolean => band.days.length === 0 || band.days.includes(d)

  if (s < e) return applies(wd) && t >= s && t < e
  if (s > e) return (applies(wd) && t >= s) || (applies(prevWd) && t < e)
  return applies(wd)
}

/**
 * The band covering `date`, or null. GENERIC over the band type so the caller
 * gets back exactly what it put in: the recorder decides on `EffectiveBand`s
 * (`band-decision.ts`), which carry the one non-authored fact — that the DEVICE
 * decides — and a return type widened to `RecordingBand` would erase it right
 * where the gates read it.
 */
export function activeBandAt<B extends RecordingBand>(
  config: { readonly bands: readonly B[] },
  date: Date,
): B | null {
  return config.bands.find((b) => bandActiveAt(b, date)) ?? null
}
