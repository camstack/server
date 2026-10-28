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

type AlertAction = NonNullable<Alert['action']>

/** An alert action that has somewhere to go. */
export type AlertActionWithHref = AlertAction & { readonly href: string }

/** An alert action that runs an addon's custom action. */
export type AlertActionWithInvoke = AlertAction & {
  readonly invoke: NonNullable<AlertAction['invoke']>
}

/** An alert action the UI can render: a link or an invoke button. */
export type UsableAlertAction = AlertActionWithHref | AlertActionWithInvoke

export function hasNonEmptyActionHref(action: Alert['action']): action is AlertActionWithHref {
  return action !== undefined && typeof action.href === 'string' && action.href.length > 0
}

export function hasUsableAction(action: Alert['action']): action is UsableAlertAction {
  return hasNonEmptyActionHref(action) || (action !== undefined && action.invoke !== undefined)
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

/**
 * The action to render for an alert. A button that RUNS something is offered
 * only while the alert is open: once completed or dismissed it has done its
 * job, and the update that closes an alert cannot remove the field.
 */
export function alertAction(alert: Alert): UsableAlertAction | undefined {
  const action = alert.action
  if (!hasUsableAction(action)) return undefined
  if (
    action.invoke !== undefined &&
    (alert.status === 'completed' || alert.status === 'dismissed')
  ) {
    return undefined
  }
  return action
}
