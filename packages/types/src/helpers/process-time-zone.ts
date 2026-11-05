/**
 * The process's usable IANA time zone.
 *
 * A container started with `TZ=` (set, empty) makes
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` answer `Etc/Unknown`, and
 * `new Intl.DateTimeFormat(…, { timeZone: 'Etc/Unknown' })` then throws a
 * `RangeError`. Every consumer of "the hub's zone" goes through here instead of
 * reading the Intl default itself.
 */
import type { IScopedLogger } from '../interfaces/logging.js'

const UNKNOWN_ZONE = 'Etc/Unknown'

/** True when `Intl.DateTimeFormat` accepts the zone and it is not `Etc/Unknown`. */
export function isUsableTimeZone(timeZone: string): boolean {
  if (timeZone.length === 0 || timeZone === UNKNOWN_ZONE) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

export interface ProcessTimeZoneProbe {
  /** The zone the runtime reports (default: the Intl default). */
  readonly read?: () => string
}

/** The process zone when usable, else `null`. Callers choose the fallback. */
export function usableProcessTimeZone(probe: ProcessTimeZoneProbe = {}): string | null {
  const read = probe.read ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone)
  const zone = read()
  return typeof zone === 'string' && isUsableTimeZone(zone) ? zone : null
}

let warnedRejectedZone = false

/** Process zone, or `fallback` (default `UTC`); warns once with the rejected value. */
export function processTimeZoneOr(
  fallback: string,
  logger?: IScopedLogger,
  probe: ProcessTimeZoneProbe = {},
): string {
  const usable = usableProcessTimeZone(probe)
  if (usable !== null) return usable
  if (!warnedRejectedZone) {
    warnedRejectedZone = true
    const read = probe.read ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone)
    logger?.warn('the process time zone is not usable, using a fallback', {
      meta: { rejectedTimeZone: read(), fallbackTimeZone: fallback },
    })
  }
  return fallback
}

/** Test seam: re-arm the warn-once latch. */
export function resetProcessTimeZoneWarning(): void {
  warnedRejectedZone = false
}
