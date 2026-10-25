import type { Alert } from '@camstack/types'

/** Dismissed for this full document load only — reset on reload. */
let criticalAlertsPanelDismissedThisLoad = false

export function isCriticalAlertsPanelDismissedThisLoad(): boolean {
  return criticalAlertsPanelDismissedThisLoad
}

export function dismissCriticalAlertsPanelThisLoad(): void {
  criticalAlertsPanelDismissedThisLoad = true
}

/** Test hook — vitest runs each file in isolation; callers reset between cases. */
export function resetCriticalAlertsPanelDismissedForTests(): void {
  criticalAlertsPanelDismissedThisLoad = false
}

export function isUnreadCriticalAlert(alert: Alert): boolean {
  return !alert.read && alert.severity === 'critical'
}

export function filterUnreadCriticalAlerts(alerts: readonly Alert[]): Alert[] {
  return alerts.filter(isUnreadCriticalAlert)
}

/** An alert action that has somewhere to go. */
export type AlertActionWithHref = NonNullable<Alert['action']> & { readonly href: string }

export function hasNonEmptyActionHref(action: Alert['action']): action is AlertActionWithHref {
  return action !== undefined && typeof action.href === 'string' && action.href.length > 0
}

/** `/addon/<id>/oauth/…` — an addon HTTP route (OAuth start/callback), not an admin page. */
const ADDON_OAUTH_ROUTE = /^\/addon\/[^/?#]+\/oauth\//

/**
 * Whether the action's `href` is served by the HUB rather than by the admin
 * SPA, so it needs a full navigation instead of a router link. The producer
 * says so with `navigation: 'server'`; an alert stored before that field
 * existed is recognised by the addon OAuth route shape, since the SPA's only
 * `/addon/:pagePath` route is a single segment.
 */
export function isServerAlertAction(action: AlertActionWithHref): boolean {
  if (action.navigation !== undefined) return action.navigation === 'server'
  return ADDON_OAUTH_ROUTE.test(action.href)
}
