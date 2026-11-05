/**
 * The zone the clip catalog reads the camera's wall clock in.
 *
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` answers `Etc/Unknown` in
 * a process whose TZ ICU cannot resolve (a container with an odd or empty TZ),
 * and `Intl.DateTimeFormat` then throws `RangeError: Invalid time zone
 * specified: Etc/Unknown` the first time the catalog formats a day. Validate
 * once, here, and fall back instead of throwing out of the refresh.
 */
import type { IScopedLogger } from '@camstack/types'

export interface ClipTimeZoneResolution {
  readonly timeZone: string
  /** Set when the candidate was rejected: the zone that was refused. */
  readonly rejected?: string
}

export function isUsableTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

/**
 * @param candidate the zone the process reports
 * @param cameraZone a zone derived from the camera's reported UTC offset, if any
 */
export function resolveClipTimeZone(
  candidate: string,
  cameraZone: string | undefined,
): ClipTimeZoneResolution {
  if (isUsableTimeZone(candidate)) return { timeZone: candidate }
  if (cameraZone !== undefined && isUsableTimeZone(cameraZone)) {
    return { timeZone: cameraZone, rejected: candidate }
  }
  return { timeZone: 'UTC', rejected: candidate }
}

/** Resolve and, when the candidate was refused, warn ONCE per `warned` holder. */
export function resolveClipTimeZoneOnce(
  candidate: string,
  cameraZone: string | undefined,
  logger: IScopedLogger,
  deviceId: number,
  warned: { done: boolean },
): string {
  const res = resolveClipTimeZone(candidate, cameraZone)
  if (res.rejected !== undefined && !warned.done) {
    warned.done = true
    logger.warn('clip catalog: the process time zone is not usable, using a fallback', {
      tags: { deviceId },
      meta: { rejectedTimeZone: res.rejected, fallbackTimeZone: res.timeZone },
    })
  }
  return res.timeZone
}
