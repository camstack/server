/**
 * Which device tab a `?tab=` names — and what happens when it names one this
 * device does not have.
 *
 * Extracted from `DeviceDetail` on 2026-08-30 because it stopped being an
 * internal detail: a `stream-offline` notification now taps through to
 * `/devices/<id>?tab=stream-broker`
 * (`packages/addon-post-analysis/src/notification-center/system-event-tap-url.ts`),
 * so what this resolution does with a tab that is missing, late, or wrong is a
 * property an operator experiences.
 *
 * Two behaviours, and the second is the one that keeps a stale link honest:
 *
 *  - **A tab that has not been DISCOVERED yet still applies.** The Stream
 *    Broker tab is contributed by the pipeline addon through the device
 *    aggregate, so on first paint it does not exist. The URL is left alone and
 *    the tab snaps in the moment discovery finishes — rewriting it to
 *    `overview` on first paint would make every deep link land on Overview.
 *  - **A tab this device will NEVER have falls through to Overview**, and the
 *    URL is still left alone. A camera that was replaced by a plug, or a
 *    device deleted outright, opens a page that renders rather than an empty
 *    tab body; `DeviceDetail` renders "Device not found" when the device is
 *    gone entirely.
 */

/** The only field of a tab this resolution reads. */
export interface DeviceTabRef {
  readonly id: string
}

/** The tab shown when the URL names nothing, or names nothing available. */
export const DEFAULT_DEVICE_TAB = 'overview'

export function resolveActiveDeviceTab(tabs: readonly DeviceTabRef[], desiredTab: string): string {
  return tabs.some((tab) => tab.id === desiredTab) ? desiredTab : DEFAULT_DEVICE_TAB
}
