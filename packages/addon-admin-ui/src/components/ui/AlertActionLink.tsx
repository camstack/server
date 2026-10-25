/**
 * The action button of an alert. An admin route is a router link; a route the
 * hub serves (an OAuth start) leaves the SPA through `startServerNavigation`,
 * so "Sign in again" opens the sign-in instead of bouncing to the home page.
 * The `href` stays on the anchor so it is still a real link (open in a new
 * tab, copy address).
 */
import { useQueryClient } from '@tanstack/react-query'
import type { MouseEvent, JSX } from 'react'
import { Link } from 'react-router-dom'
import { startServerNavigation } from '../../lib/broker-oauth-popup'
import { hubPath } from '../../lib/mount'
import { isServerAlertAction, type AlertActionWithHref } from './critical-alerts'

export interface AlertActionLinkProps {
  readonly action: AlertActionWithHref
  readonly className: string
  /** Runs before the action is followed (the bell stops the row click here). */
  readonly onActivate?: (event: MouseEvent) => void
}

export function AlertActionLink({
  action,
  className,
  onActivate,
}: AlertActionLinkProps): JSX.Element {
  const queryClient = useQueryClient()

  if (!isServerAlertAction(action)) {
    return (
      <Link to={action.href} className={className} onClick={onActivate}>
        {action.label}
      </Link>
    )
  }

  return (
    <a
      href={hubPath(action.href)}
      className={className}
      onClick={(event) => {
        event.preventDefault()
        onActivate?.(event)
        startServerNavigation(action.href, () => {
          // The flow changed what the alert is about: refresh the alerts and the brokers.
          void queryClient.invalidateQueries({ queryKey: [['alerts']] })
          void queryClient.invalidateQueries({ queryKey: [['broker']] })
          void queryClient.invalidateQueries({ queryKey: [['recordEntries']] })
        })
      }}
    >
      {action.label}
    </a>
  )
}
