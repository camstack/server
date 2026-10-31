import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { computeAlertPanelStyle } from './alert-bell-placement'
import type { Alert } from '@camstack/types'
import {
  ScrollText,
  Check,
  CheckCheck,
  X,
  Info,
  AlertTriangle,
  AlertCircle,
  CheckCircle2,
  Loader2,
  OctagonAlert,
} from 'lucide-react'
import { AlertActionLink } from './AlertActionLink'
import { useQueryClient } from '@tanstack/react-query'
import {
  useAlertsDismiss,
  useAlertsGetUnreadCount,
  useAlertsList,
  useAlertsMarkAllRead,
  useAlertsMarkRead,
  useClusterNodes,
  useLiveEvent,
  Button,
  Checkbox,
} from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n/index'
import { alertAction, isUnreadCriticalAlert } from './critical-alerts'

// ── Props ───────────────────────────────────────────────────────────

export interface AlertBellProps {
  /** Render inline in a sidebar row: icon + "Alerts" label + badge */
  readonly variant?: 'icon' | 'sidebar'
  /** When true, sidebar variant collapses to icon-only (mid breakpoint
   *  fold). Ignored for `icon` variant. */
  readonly compact?: boolean
}

// ── Severity styling ────────────────────────────────────────────────

const SEVERITY_ICONS = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: AlertCircle,
  critical: OctagonAlert,
} as const

const SEVERITY_COLORS = {
  info: 'text-info',
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-danger',
  critical: 'text-danger',
} as const

const STATUS_COLORS = {
  active: 'border-l-info',
  'in-progress': 'border-l-warning',
  completed: 'border-l-success',
  failed: 'border-l-danger',
  dismissed: 'border-l-foreground-subtle/30',
} as const

// ── Time formatting ─────────────────────────────────────────────────

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return i18n.t('helpers.relativeTime.justNow')
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return i18n.t('helpers.relativeTime.minutesAgo', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return i18n.t('helpers.relativeTime.hoursAgo', { count: hours })
  const days = Math.floor(hours / 24)
  return i18n.t('helpers.relativeTime.daysAgo', { count: days })
}

// ── Node id from alert payload ──────────────────────────────────────

/** Fields used to resolve which node an alert belongs to. */
export interface AlertNodeSource {
  readonly metadata?: Record<string, unknown>
  readonly source?: { readonly type: string; readonly id: string }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Prefer `metadata.nodeId` / `metadata.agentId`; else `source.id` when type is node/agent. */
export function alertNodeId(alert: AlertNodeSource): string | undefined {
  if (isPlainRecord(alert.metadata)) {
    const fromMeta =
      nonEmptyString(alert.metadata['nodeId']) ?? nonEmptyString(alert.metadata['agentId'])
    if (fromMeta !== undefined) return fromMeta
  }
  const source = alert.source
  if (source === undefined) return undefined
  if (source.type !== 'node' && source.type !== 'agent') return undefined
  return nonEmptyString(source.id)
}

// ── Alert card ──────────────────────────────────────────────────────

function AlertCard({
  alert,
  onMarkRead,
  onDismiss,
}: {
  readonly alert: Alert
  readonly onMarkRead: (id: string) => void
  readonly onDismiss: (id: string) => void
}) {
  const { t } = useTranslation()
  const severity =
    alert.severity in SEVERITY_ICONS ? alert.severity : ('info' as keyof typeof SEVERITY_ICONS)
  const action = alertAction(alert)
  const status = alert.status in STATUS_COLORS ? alert.status : 'active'
  const Icon = SEVERITY_ICONS[severity]
  const iconColor = SEVERITY_COLORS[severity]
  const borderColor = STATUS_COLORS[status]
  const { nodes } = useClusterNodes()
  const nodeId = alertNodeId(alert)
  const matched = nodeId === undefined ? undefined : nodes.find((n) => n.id === nodeId)
  const nodeLabel = nodeId === undefined ? undefined : (matched?.name ?? nodeId)

  return (
    <div
      className={`flex items-start gap-2.5 px-3 py-2.5 border-l-2 ${borderColor} ${
        alert.read ? 'opacity-60' : ''
      } hover:bg-surface-hover transition-colors`}
    >
      <Icon className={`h-3.5 w-3.5 shrink-0 mt-0.5 ${iconColor}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span
            className={`text-[11px] font-semibold ${alert.read ? 'text-foreground-subtle' : 'text-foreground'}`}
          >
            {alert.title}
          </span>
          {!alert.read && <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" />}
        </div>
        {nodeLabel !== undefined && (
          <div className="text-foreground-subtle text-[10px] mt-0.5 truncate">{nodeLabel}</div>
        )}
        <div className="text-[10px] text-foreground-subtle mt-0.5 line-clamp-2">
          {alert.message}
        </div>
        {action !== undefined && (
          <AlertActionLink
            action={action}
            className="inline-flex mt-1.5 items-center rounded-md bg-primary px-2 py-0.5 text-[10px] font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
            onActivate={(e) => e.stopPropagation()}
          />
        )}
        {alert.status === 'in-progress' && alert.progress !== undefined && (
          <div className="mt-1.5 flex items-center gap-2">
            <div className="flex-1 h-1 bg-surface-hover rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-300"
                style={{ width: `${String(Math.min(100, Math.max(0, alert.progress)))}%` }}
              />
            </div>
            <span className="text-[9px] text-foreground-subtle font-mono shrink-0">
              {String(Math.round(alert.progress))}%
            </span>
          </div>
        )}
        <div className="text-[9px] text-foreground-subtle/60 mt-1">
          {formatTimeAgo(alert.updatedAt)}
        </div>
      </div>
      <div className="flex items-center gap-0.5 shrink-0">
        {!alert.read && (
          <Button
            variant="unstyled"
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onMarkRead(alert.id)
            }}
            className="p-1 rounded hover:bg-surface-hover transition-colors"
            title={t('ui.alertBell.markAsRead', 'Mark as read')}
          >
            <Check className="h-3 w-3 text-foreground-subtle" />
          </Button>
        )}
        {alert.status !== 'in-progress' && (
          <Button
            variant="unstyled"
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onDismiss(alert.id)
            }}
            className="p-1 rounded hover:bg-surface-hover transition-colors"
            title={t('ui.alertBell.dismiss', 'Dismiss')}
          >
            <X className="h-3 w-3 text-foreground-subtle" />
          </Button>
        )}
      </div>
    </div>
  )
}

// ── AlertBell component ─────────────────────────────────────────────

export function AlertBell({ variant = 'icon', compact = false }: AlertBellProps = {}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [showRead, setShowRead] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const queryClient = useQueryClient()

  const { data: unreadCount = 0 } = useAlertsGetUnreadCount(undefined, {
    refetchInterval: 30_000,
  })

  const { data: rawAlerts = [], isLoading } = useAlertsList(
    { limit: 50 },
    {
      enabled: open,
    },
  )

  const alerts = (showRead ? rawAlerts : rawAlerts.filter((a: Alert) => !a.read)) as Alert[]
  const readCount = rawAlerts.filter((a: Alert) => a.read).length

  const invalidateAlerts = () => {
    void queryClient.invalidateQueries({ queryKey: [['alerts']] })
  }

  const markReadMutation = useAlertsMarkRead({ onSuccess: invalidateAlerts })
  const markAllReadMutation = useAlertsMarkAllRead({ onSuccess: invalidateAlerts })
  const dismissMutation = useAlertsDismiss({ onSuccess: invalidateAlerts })

  useLiveEvent('alert.created', () => {
    void queryClient.invalidateQueries({ queryKey: [['alerts']] })
  })
  useLiveEvent('alert.updated', () => {
    void queryClient.invalidateQueries({ queryKey: [['alerts']] })
  })

  // Close panel when clicking/tapping outside. `touchstart` is included
  // so the dropdown dismisses on mobile, where a tap outside doesn't
  // always synthesize a `mousedown` before the portal swallows it.
  useEffect(() => {
    if (!open) return
    const handleOutside = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node
      if (
        panelRef.current &&
        !panelRef.current.contains(target) &&
        buttonRef.current &&
        !buttonRef.current.contains(target)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleOutside)
    document.addEventListener('touchstart', handleOutside)
    return () => {
      document.removeEventListener('mousedown', handleOutside)
      document.removeEventListener('touchstart', handleOutside)
    }
  }, [open])

  const handleMarkRead = useCallback(
    (id: string) => {
      markReadMutation.mutate({ alertId: id })
    },
    [markReadMutation],
  )

  const handleDismiss = useCallback(
    (id: string) => {
      if (!id) return
      dismissMutation.mutate({ alertId: id })
    },
    [dismissMutation],
  )

  const handleMarkAllRead = useCallback(() => {
    markAllReadMutation.mutate(undefined)
    // `[ALERT-CENTER]` — close the dropdown when the operator marks
    // everything read. Previously the popover stayed open with a "No
    // unread alerts" empty state, which was confusing since the intent
    // of the button is "I've seen these, dismiss the panel". If the
    // operator wants to inspect read alerts, they can re-open and
    // toggle "Show read".
    setOpen(false)
  }, [markAllReadMutation])

  const urgentAlerts = alerts.filter(isUnreadCriticalAlert)
  const urgentIds = new Set(urgentAlerts.map((a) => a.id))
  const inProgressAlerts = alerts.filter((a) => a.status === 'in-progress' && !urgentIds.has(a.id))
  const otherAlerts = alerts.filter((a) => a.status !== 'in-progress' && !urgentIds.has(a.id))

  // Compute a viewport-aware fixed position for the dropdown.
  //
  // The bell renders in two very different spots: the desktop bottom
  // sidebar (button near the viewport BOTTOM → panel must drop UP) and
  // the mobile top header (button near the TOP → panel must drop DOWN).
  // A fixed drop-up anchored at `bottom: innerHeight - rect.top` pushed
  // the whole panel off the top of the screen on mobile — it "opened"
  // but was invisible. We now pick the side with more room, clamp the
  // panel inside the viewport horizontally, fit its width to narrow
  // screens, and cap its height to the available space.
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({})
  const computePanelStyle = useCallback(() => {
    const btn = buttonRef.current
    if (!btn) return
    setPanelStyle(
      computeAlertPanelStyle({
        rect: btn.getBoundingClientRect(),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }),
    )
  }, [])

  useEffect(() => {
    if (!open) return
    computePanelStyle()
    const onReflow = () => computePanelStyle()
    window.addEventListener('resize', onReflow)
    window.addEventListener('scroll', onReflow, true)
    return () => {
      window.removeEventListener('resize', onReflow)
      window.removeEventListener('scroll', onReflow, true)
    }
  }, [open, computePanelStyle])

  return (
    <div>
      {variant === 'sidebar' ? (
        <Button
          variant="unstyled"
          ref={buttonRef}
          type="button"
          onClick={() => setOpen(!open)}
          className={`flex w-full items-center gap-2.5 rounded-md ${compact ? 'justify-center px-0 py-2' : 'px-2.5 py-1.5'} text-[12px] text-foreground-subtle hover:bg-surface-hover hover:text-foreground transition-colors`}
          title={
            compact
              ? unreadCount > 0
                ? t('ui.alertBell.alertsUnread', { count: unreadCount })
                : t('ui.alertBell.alerts')
              : undefined
          }
        >
          <span className="relative inline-flex shrink-0">
            <ScrollText className="h-3.5 w-3.5" />
            {compact && unreadCount > 0 && (
              <span className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-primary" />
            )}
          </span>
          {!compact && (
            <span className="flex-1 text-left">{t('ui.alertBell.alerts', 'Alerts')}</span>
          )}
          {!compact && unreadCount > 0 && (
            <span className="flex items-center justify-center h-4 min-w-4 px-1 rounded-full bg-primary text-primary-foreground text-[9px] font-bold leading-none">
              {unreadCount > 99 ? '99+' : String(unreadCount)}
            </span>
          )}
        </Button>
      ) : (
        <Button
          variant="unstyled"
          ref={buttonRef}
          type="button"
          onClick={() => setOpen(!open)}
          className="relative p-1.5 rounded-md hover:bg-surface-hover text-foreground-subtle hover:text-foreground transition-colors"
          aria-label={t('ui.alertBell.alerts', 'Alerts')}
        >
          <ScrollText className="h-4.5 w-4.5" />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex items-center justify-center h-4 min-w-4 px-0.5 rounded-full bg-primary text-primary-foreground text-[9px] font-bold leading-none">
              {unreadCount > 99 ? '99+' : String(unreadCount)}
            </span>
          )}
        </Button>
      )}

      {open &&
        createPortal(
          <div
            ref={panelRef}
            style={panelStyle}
            className="bg-surface border border-border rounded-lg shadow-xl flex flex-col overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
              <span className="text-[12px] font-semibold text-foreground">
                {t('ui.alertBell.alerts', 'Alerts')}
              </span>
              <div className="flex items-center gap-2">
                {readCount > 0 && (
                  <label className="flex items-center gap-1 text-[10px] text-foreground-subtle cursor-pointer select-none">
                    <Checkbox
                      checked={showRead}
                      onChange={(e) => setShowRead(e.target.checked)}
                      className="h-3 w-3 rounded border-border accent-primary cursor-pointer"
                    />
                    {t('ui.alertBell.showRead', 'Show read')}
                  </label>
                )}
                {unreadCount > 0 && (
                  <Button
                    variant="unstyled"
                    type="button"
                    onClick={handleMarkAllRead}
                    className="flex items-center gap-1 text-[10px] text-primary hover:text-primary/80 transition-colors"
                  >
                    <CheckCheck className="h-3 w-3" />
                    {t('ui.alertBell.markAllRead', 'Mark all read')}
                  </Button>
                )}
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto">
              {isLoading && (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-4 w-4 animate-spin text-foreground-subtle" />
                </div>
              )}

              {!isLoading && alerts.length === 0 && (
                <div className="flex flex-col items-center justify-center py-8 text-foreground-subtle">
                  <ScrollText className="h-6 w-6 mb-2 opacity-40" />
                  <span className="text-[11px]">
                    {rawAlerts.length > 0
                      ? t('ui.alertBell.noUnreadAlerts', 'No unread alerts')
                      : t('ui.alertBell.noAlerts', 'No alerts')}
                  </span>
                  {rawAlerts.length > 0 && !showRead && (
                    <Button
                      variant="unstyled"
                      type="button"
                      onClick={() => setShowRead(true)}
                      className="text-[10px] text-primary mt-1 hover:underline"
                    >
                      {t('ui.alertBell.showRead', { count: readCount })}
                    </Button>
                  )}
                </div>
              )}

              {urgentAlerts.length > 0 && (
                <div className="border-b border-border">
                  <div className="px-3 py-1.5 bg-danger/5">
                    <span className="text-[9px] font-semibold uppercase tracking-widest text-danger">
                      {t('ui.alertBell.urgent', 'Urgent')}
                    </span>
                  </div>
                  {urgentAlerts.map((alert) => (
                    <AlertCard
                      key={alert.id}
                      alert={alert}
                      onMarkRead={handleMarkRead}
                      onDismiss={handleDismiss}
                    />
                  ))}
                </div>
              )}

              {/* In-progress section */}
              {inProgressAlerts.length > 0 && (
                <div className="border-b border-border">
                  <div className="px-3 py-1.5 bg-surface-hover/50">
                    <span className="text-[9px] font-semibold uppercase tracking-widest text-foreground-subtle/60">
                      {t('ui.alertBell.inProgress', 'In Progress')}
                    </span>
                  </div>
                  {inProgressAlerts.map((alert) => (
                    <AlertCard
                      key={alert.id}
                      alert={alert}
                      onMarkRead={handleMarkRead}
                      onDismiss={handleDismiss}
                    />
                  ))}
                </div>
              )}

              {/* Other alerts */}
              {otherAlerts.map((alert) => (
                <AlertCard
                  key={alert.id}
                  alert={alert}
                  onMarkRead={handleMarkRead}
                  onDismiss={handleDismiss}
                />
              ))}
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}
