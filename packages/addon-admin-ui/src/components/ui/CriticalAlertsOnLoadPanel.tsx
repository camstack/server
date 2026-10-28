import { Button, IconButton, useAlertsList, useAlertsMarkRead } from '@camstack/ui-library'
import type { Alert } from '@camstack/types'
import { useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { AlertActionLink } from './AlertActionLink'
import {
  dismissCriticalAlertsPanelThisLoad,
  filterUnreadCriticalAlerts,
  hasUsableAction,
  isCriticalAlertsPanelDismissedThisLoad,
} from './critical-alerts'

function CriticalAlertPanelRow({
  alert,
  onMarkRead,
}: {
  readonly alert: Alert
  readonly onMarkRead: (id: string) => void
}) {
  const { t } = useTranslation()
  const action = hasUsableAction(alert.action) ? alert.action : undefined

  return (
    <div className="border-b border-border last:border-b-0 px-3 py-2.5">
      <div className="text-[12px] font-semibold text-foreground">{alert.title}</div>
      <div className="text-[11px] text-foreground-muted mt-0.5">{alert.message}</div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {action !== undefined && (
          <AlertActionLink
            action={action}
            className="inline-flex items-center justify-center rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          />
        )}
        <Button type="button" variant="ghost" size="sm" onClick={() => onMarkRead(alert.id)}>
          {t('ui.alertBell.markAsRead', 'Mark as read')}
        </Button>
      </div>
    </div>
  )
}

export function CriticalAlertsOnLoadPanel() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [dismissed, setDismissed] = useState(isCriticalAlertsPanelDismissedThisLoad())

  const { data: rawAlerts = [], isLoading } = useAlertsList({ limit: 50 })

  const urgentAlerts = useMemo(() => filterUnreadCriticalAlerts(rawAlerts), [rawAlerts])

  const invalidateAlerts = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: [['alerts']] })
  }, [queryClient])

  const markReadMutation = useAlertsMarkRead({ onSuccess: invalidateAlerts })

  const handleMarkRead = useCallback(
    (id: string) => {
      markReadMutation.mutate({ alertId: id })
    },
    [markReadMutation],
  )

  const handleClose = useCallback(() => {
    dismissCriticalAlertsPanelThisLoad()
    setDismissed(true)
  }, [])

  if (isLoading || dismissed || urgentAlerts.length === 0) {
    return null
  }

  return createPortal(
    <div
      className="fixed inset-x-0 bottom-0 z-[10000] flex justify-center p-2 sm:p-4 pb-[max(0.5rem,env(safe-area-inset-bottom))] pointer-events-none"
      data-testid="critical-alerts-on-load-panel"
    >
      <div
        className="pointer-events-auto w-full max-w-lg bg-surface border border-danger/30 rounded-lg shadow-xl flex flex-col max-h-[min(70dvh,32rem)] overflow-hidden"
        role="region"
        aria-labelledby="critical-alerts-panel-title"
      >
        <div className="flex items-start justify-between gap-2 px-3 py-2.5 border-b border-border shrink-0 bg-danger/5">
          <div>
            <h2
              id="critical-alerts-panel-title"
              className="text-[12px] font-semibold text-foreground"
            >
              {t('ui.criticalAlertsPanel.title', 'Urgent alerts')}
            </h2>
            <p className="text-[10px] text-foreground-muted mt-0.5">
              {t('ui.criticalAlertsPanel.subtitle', 'These need your attention.')}
            </p>
          </div>
          <IconButton
            type="button"
            variant="ghost"
            onClick={handleClose}
            aria-label={t('ui.criticalAlertsPanel.close', 'Close')}
            data-testid="critical-alerts-panel-close"
            icon={X}
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {urgentAlerts.map((alert) => (
            <CriticalAlertPanelRow key={alert.id} alert={alert} onMarkRead={handleMarkRead} />
          ))}
        </div>
      </div>
    </div>,
    document.body,
  )
}
