/**
 * Resolving a recordings location by id — and the distinction between "I do
 * not know that location" and "the operator switched it off".
 *
 * A `disabled` location is an operator CHOICE (D385). Reporting it as an
 * unknown location turns that choice into what looks like a fault: the operator
 * sees a stack trace naming an id they configured, on a screen that says
 * nothing about the switch they flipped. This is the one change in the state
 * model that can manufacture a bug report, so the two answers are named
 * separately and both are typed.
 */
import type { RecordingsLocation } from './roots.js'
import { locationMayBeRead } from './roots.js'

export { locationMayBeRead, locationMayBeWritten, locationMode } from './roots.js'

/** Why a location could not serve a read. */
export type LocationUnavailableReason = 'unknown' | 'disabled'

/**
 * A location this process may READ from.
 *
 * Throws with a message that names WHICH of the two it is — never one message
 * for both. The caller does not have to branch: the message is the product.
 */
export function requireReadableLocation(
  locations: readonly RecordingsLocation[],
  locationId: string,
  context: string,
): RecordingsLocation {
  const location = locations.find((candidate) => candidate.id === locationId)
  if (location === undefined) {
    throw new Error(`${context}: unknown location ${locationId}`)
  }
  if (!locationMayBeRead(location)) {
    throw new Error(
      `${context}: recordings location ${locationId} is UNAVAILABLE — the operator switched it ` +
        `off (mode: ${location.mode}). Its footage is still on disk; set the location back to ` +
        `readonly or active to read it.`,
    )
  }
  return location
}

/** The same question without the throw, for callers that report rather than
 *  fail — `null` means the location may serve a read. */
export function locationUnavailableReason(
  locations: readonly RecordingsLocation[],
  locationId: string,
): LocationUnavailableReason | null {
  const location = locations.find((candidate) => candidate.id === locationId)
  if (location === undefined) return 'unknown'
  return locationMayBeRead(location) ? null : 'disabled'
}
