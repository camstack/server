/**
 * WHICH cameras the on-demand sentry is allowed to touch.
 *
 * Deliberately narrow, and narrower than the mechanism could technically
 * serve. The operator's rule: a battery camera THAT DECLARES the signals cap.
 * Both terms, and each excludes a case worth excluding:
 *
 *  - **Battery.** A mains camera has nothing to save by sleeping, so the whole
 *    apparatus — a demand split, a wake hold, a quarantine — buys it nothing
 *    and can only cost it a surprise. The lazy-source test I first proposed
 *    would have swept in the cloud-relayed robot camera, which nobody asked
 *    for.
 *  - **Declares `stream-signals`.** Without signals there is nothing that can
 *    wake the camera, so a sentry consumer would hold a session open
 *    against a camera that can never come up — a stream that is permanently a
 *    photograph. A provider that has not implemented the cap has not opted its
 *    devices in, and silence is the right reading of that.
 *
 * Both facts are ASKED, never assumed, and an unanswerable question is a NO.
 * A device the registry cannot describe is not a battery camera with signals;
 * it is a device nobody could describe, and turning that into "yes" is how a
 * mains camera ends up in a wake-hold loop.
 */

export interface SentryEligibilityInput {
  /** Whether the device is battery-operated. `null` ⇒ nobody could say. */
  readonly batteryOperated: boolean | null
  /** Whether the device binds `stream-signals`. `null` ⇒ nobody could say. */
  readonly declaresSignals: boolean | null
}

export type SentryRefusalReason = 'not-battery' | 'no-signals-cap' | 'unknown'

export function sentryEligible(
  input: SentryEligibilityInput,
):
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: SentryRefusalReason } {
  if (input.batteryOperated === null || input.declaresSignals === null) {
    return { eligible: false, reason: 'unknown' }
  }
  if (!input.batteryOperated) return { eligible: false, reason: 'not-battery' }
  if (!input.declaresSignals) return { eligible: false, reason: 'no-signals-cap' }
  return { eligible: true }
}
