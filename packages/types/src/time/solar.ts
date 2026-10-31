/**
 * Where the sun is, from a latitude and a longitude — the one solar
 * calculation in the repo. Compact NOAA sunrise equation (accurate to about a
 * minute away from the poles), so no astronomy dependency is needed.
 *
 * Two consumers read it: the scene-condition resolver (day / night / dawn /
 * dusk of a camera) and a schedule's sun time (`time-spec.ts`).
 */

const DEG = Math.PI / 180

/** The sun's upper limb on the horizon, refraction included: sunrise and sunset. */
export const SUNRISE_ALTITUDE_DEG = -0.833

/** The sun's centre 6 degrees below the horizon: civil dawn and civil dusk. */
export const CIVIL_TWILIGHT_ALTITUDE_DEG = -6

/**
 * The two moments, in UTC epoch ms, at which the sun crosses an altitude on one
 * day: going up (`rise`) and going down (`set`).
 */
export interface SunCrossings {
  readonly rise: number
  readonly set: number
}

/** Julian day number for a JS Date (UTC). */
function toJulian(date: Date): number {
  return date.getTime() / 86_400_000 + 2_440_587.5
}

/** Julian day → epoch ms (UTC). */
function fromJulian(j: number): number {
  return (j - 2_440_587.5) * 86_400_000
}

/**
 * When the sun crosses `altitudeDeg` on the day `date` falls in at this place.
 * Pass an instant near local midday of the civil day you mean: the day is
 * chosen from the instant, and midday is the one that never straddles two.
 *
 * `null` when the sun never crosses that altitude that day (polar day or polar
 * night, or — for a twilight altitude — a summer night that never gets dark
 * enough). The caller decides what that means; nothing here guesses.
 */
export function sunCrossings(
  lat: number,
  lng: number,
  date: Date,
  altitudeDeg: number,
): SunCrossings | null {
  const jDate = toJulian(date)
  const n = Math.round(jDate - 2_451_545.0 + 0.0008)
  const jStar = n - lng / 360
  const m = (357.5291 + 0.985_600_28 * jStar) % 360
  const mRad = m * DEG
  const c = 1.9148 * Math.sin(mRad) + 0.02 * Math.sin(2 * mRad) + 0.0003 * Math.sin(3 * mRad)
  const lambda = ((m + c + 180 + 102.9372) % 360) * DEG
  const jTransit = 2_451_545.0 + jStar + 0.0053 * Math.sin(mRad) - 0.0069 * Math.sin(2 * lambda)
  const declination = Math.asin(Math.sin(lambda) * Math.sin(23.44 * DEG))
  const latRad = lat * DEG
  const cosOmega =
    (Math.sin(altitudeDeg * DEG) - Math.sin(latRad) * Math.sin(declination)) /
    (Math.cos(latRad) * Math.cos(declination))
  if (cosOmega > 1 || cosOmega < -1) return null
  const omega = Math.acos(cosOmega) / DEG
  return { rise: fromJulian(jTransit - omega / 360), set: fromJulian(jTransit + omega / 360) }
}

/**
 * Sunrise and sunset (UTC epoch ms) for a place and date; `null` for the polar
 * cases (the sun never rises or sets that day).
 */
export function sunTimes(lat: number, lng: number, date: Date): SunCrossings | null {
  return sunCrossings(lat, lng, date, SUNRISE_ALTITUDE_DEG)
}

/** Civil dawn and dusk (UTC epoch ms); `null` when the sun never gets that low or that high. */
export function twilightTimes(lat: number, lng: number, date: Date): SunCrossings | null {
  return sunCrossings(lat, lng, date, CIVIL_TWILIGHT_ALTITUDE_DEG)
}
