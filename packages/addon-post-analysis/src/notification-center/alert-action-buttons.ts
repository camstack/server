/**
 * The buttons an ALERT notification carries from the alert's own action.
 *
 * An alert says where the operator acts on it (`Alert.action`): a link — an
 * admin route, or a route the hub serves such as an OAuth start — or an
 * `invoke` (an addon custom action). The episode freezes that action whole on
 * the outbox row (`systemEvent.alertAction`, raised phase only), and this is
 * the one place it becomes notification buttons:
 *
 *  - **`href` → an OPEN-URL action**, ABSOLUTE, on the `publicEndpoint` role
 *    (the dispatcher's `publicUrlBase`). Not `notificationTaps`: that role
 *    decides only where a TAP opens and defaults to the CamStack app link,
 *    which is no hub address. An action button, an admin link and a hub route
 *    must resolve from outside the home network — exactly what D734 assigns
 *    to `publicEndpoint`. An `app` action (an admin-ui route) and a `server`
 *    action (a hub route) are both served from the hub origin, so both are
 *    `<origin><href>`; `navigation` only matters to the SPA's own client-side
 *    routing, which a phone browser does not have. An href that is already
 *    absolute is kept. No reachable base means no action: a relative link on a
 *    lock screen is worse than none.
 *  - **`invoke` → a token-authed button** (D47 plane, grant kind
 *    `alert-invoke`). The grant freezes `{addonId, action, input}` and nothing
 *    else; a tap runs exactly that, once.
 *
 * Pure: the mint and the label are injected.
 */

import type { AlertEpisodeAction, NotificationAction } from '@camstack/types'

export const ALERT_OPEN_BUTTON_ID = 'alert-open'
export const ALERT_INVOKE_BUTTON_ID = 'alert-invoke'

/** What a tap on the invoke button runs. Frozen into the grant. */
export interface AlertInvokeSpec {
  readonly addonId: string
  readonly action: string
  readonly input?: Readonly<Record<string, unknown>>
}

const ABSOLUTE_URL = /^https?:\/\//i

/** The absolute URL of an alert action's `href`, or null when it has none / no base. */
export function alertActionOpenUrl(
  action: AlertEpisodeAction,
  publicBaseUrl: string | null,
): string | null {
  const href = action.href
  if (href === undefined || href.length === 0) return null
  if (ABSOLUTE_URL.test(href)) return href
  if (publicBaseUrl === null || publicBaseUrl.length === 0) return null
  const origin = publicBaseUrl.replace(/\/+$/, '')
  return `${origin}${href.startsWith('/') ? href : `/${href}`}`
}

/** The "open" action, or none. */
export function buildAlertOpenAction(
  action: AlertEpisodeAction | undefined,
  publicBaseUrl: string | null,
): NotificationAction | null {
  if (action === undefined) return null
  const url = alertActionOpenUrl(action, publicBaseUrl)
  if (url === null) return null
  return { id: ALERT_OPEN_BUTTON_ID, label: action.label, url, mode: 'navigate' }
}

/** What the alert action's `invoke` freezes, or null when it has none. */
export function alertInvokeSpec(action: AlertEpisodeAction | undefined): AlertInvokeSpec | null {
  const invoke = action?.invoke
  if (invoke === undefined) return null
  return {
    addonId: invoke.addonId,
    action: invoke.action,
    ...(invoke.input !== undefined ? { input: invoke.input } : {}),
  }
}

/** The invoke button draft: the caller mints the callback URL and registers the grant. */
export function buildAlertInvokeAction(
  action: AlertEpisodeAction,
  mintUrl: (spec: AlertInvokeSpec) => string,
): NotificationAction | null {
  const spec = alertInvokeSpec(action)
  if (spec === null) return null
  return {
    id: ALERT_INVOKE_BUTTON_ID,
    label: action.label,
    url: mintUrl(spec),
    // An answer to the notification, not a page to read.
    mode: 'background',
  }
}
