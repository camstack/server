/**
 * The action button of an alert. An admin route is a router link; a route the
 * hub serves (an OAuth start) leaves the SPA through `startServerNavigation`,
 * so "Sign in again" opens the sign-in instead of bouncing to the home page.
 * The `href` stays on the anchor so it is still a real link (open in a new
 * tab, copy address).
 */
import { useQueryClient } from '@tanstack/react-query'
import { useSystem } from '@camstack/ui-library'
import { useState, type MouseEvent, type JSX } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { startServerNavigation } from '../../lib/broker-oauth-popup'
import { hubPath } from '../../lib/mount'
import {
  hasNonEmptyActionHref,
  isServerAlertAction,
  type UsableAlertAction,
} from './critical-alerts'

export interface AlertActionLinkProps {
  readonly action: UsableAlertAction
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
  const system = useSystem()
  const { t } = useTranslation()
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  if (action.invoke !== undefined) {
    const { addonId, action: actionName, input } = action.invoke
    return (
      <span className="inline-flex flex-col items-start gap-0.5">
        <button // ui-check-ok: takes the caller's link-button classes, same as the anchors beside it
          type="button"
          className={className}
          disabled={pending}
          onClick={(event) => {
            event.preventDefault()
            onActivate?.(event)
            setPending(true)
            setFailure(null)
            void system.trpcClient.addons.custom
              .mutate({ addonId, action: actionName, input })
              .then(() => queryClient.invalidateQueries({ queryKey: [['alerts']] }))
              .catch((err: unknown) => setFailure(err instanceof Error ? err.message : String(err)))
              .finally(() => setPending(false))
          }}
        >
          {pending ? t('ui.alertAction.running', 'Working…') : action.label}
        </button>
        {failure !== null && (
          <span role="alert" className="text-[10px] text-destructive">
            {failure}
          </span>
        )}
      </span>
    )
  }

  if (!hasNonEmptyActionHref(action)) return <></>

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
