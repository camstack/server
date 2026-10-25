/**
 * **Slice 1 — the camera's own answer to "is there a card".**
 *
 * It turns "no clips" into "no card", which is a different sentence and a
 * different operator action, and it is the cheapest question in the whole clip
 * path (D54: never search a camera whose card is not there).
 *
 * ## There is exactly ONE storage reader in this addon
 *
 * `recording-onboard` (D614) already reads
 * `storageDevice.cgi?action=getDeviceAllInfo` and already parses it into a
 * three-state {@link OnboardStorage} — `present` with its volumes, `absent`
 * with the camera's reason, `unknown` when the read itself failed. This module
 * consumes that parser and writes nothing of its own. A second reader would be
 * a second opinion about whether a card is in the slot, arrived at from the
 * same bytes, which is the defect D62 names.
 *
 * ## The three-state mapping, and why `unknown` is not `no-storage`
 *
 * A measurement that FAILED is not a measurement (D393). Folding an unreadable
 * storage read into "there is no card" tells the operator to go and fit a card
 * that is already fitted; folding it into `ok` produces the empty list this
 * whole line of work exists to prevent. It is `unreachable`, with the reason
 * verbatim.
 *
 * That distinction is DEMONSTRATED on this camera in both directions:
 * `storage.getDeviceAllInfo` answered `result: false, error 268959743` on
 * 2026-09-22 with no card fitted, and answers truthfully today with one. The
 * same call, the same camera, two days.
 *
 * Pure: the caller does the read and the clock, this decides what they mean.
 */
import type { ClipSourceAvailability, OnboardStorage } from '@camstack/types'

import type { AmcrestCameraClock } from './clip-clock.js'

/**
 * What the storage read means for this SOURCE.
 *
 * `null` means "nothing to report" — the card is there and readable, so the
 * next question may be asked. Every other answer is terminal and the camera is
 * not searched.
 */
export function availabilityFromStorage(storage: OnboardStorage): ClipSourceAvailability | null {
  switch (storage.kind) {
    case 'absent':
      return { state: 'no-storage', reason: storage.reason }
    case 'unknown':
      return { state: 'unreachable', reason: storage.reason }
    case 'present':
      return null
  }
}

/**
 * The second gate, and it is not optional.
 *
 * Every time this provider sends the camera travels as the camera's LOCAL wall
 * clock. Without a measured offset there is no window to ask for — and the
 * failure mode of guessing is not an error, it is footage from two hours away
 * presented as the footage that was asked for. So a clock that could not be
 * read is `unreachable` by name, before a search is built.
 */
export function availabilityFromClock(
  clock: AmcrestCameraClock | null,
): ClipSourceAvailability | null {
  if (clock !== null) return null
  return {
    state: 'unreachable',
    reason:
      'The camera did not answer what time it thinks it is, and its recordings are stamped in ' +
      'its own local clock — a window asked for without that offset would return the wrong footage.',
  }
}
