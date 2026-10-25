/**
 * DoorbellRecentPanel — compact list of recent doorbell presses.
 *
 * Renders the result of `useDoorbellEvents({deviceId})` as a small
 * card: header with the bell icon + counter, body with one row per
 * press (relative time + absolute timestamp on hover). Returns null
 * when no presses have been observed yet so the parent layout
 * collapses cleanly.
 */
import { Bell, BellRing } from 'lucide-react'
import { cn } from '../lib/cn'
import { useUiText, type UiTextFn } from '../contexts/ui-text'
import type { DoorbellPressEvent } from '../hooks/use-doorbell-events'
import { type JSX } from 'react'

export interface DoorbellRecentPanelProps {
  readonly history: readonly DoorbellPressEvent[]
  /** Max rows to show (defaults to 5). */
  readonly limit?: number
  /** Visual hint that the latest press is fresh (< 30s) — pulses the icon. */
  readonly latestIsFresh?: boolean
  readonly className?: string
}

function formatRelative(ms: number, t: UiTextFn): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return t('uiLibrary.doorbellRecentPanel.justNow', 'just now')
  if (diff < 3_600_000) {
    return t('uiLibrary.doorbellRecentPanel.minutesAgo', '{{count}}m ago', {
      count: Math.floor(diff / 60_000),
    })
  }
  if (diff < 86_400_000) {
    return t('uiLibrary.doorbellRecentPanel.hoursAgo', '{{count}}h ago', {
      count: Math.floor(diff / 3_600_000),
    })
  }
  return t('uiLibrary.doorbellRecentPanel.daysAgo', '{{count}}d ago', {
    count: Math.floor(diff / 86_400_000),
  })
}

export function DoorbellRecentPanel({
  history,
  limit = 5,
  latestIsFresh,
  className,
}: DoorbellRecentPanelProps): JSX.Element | null {
  const t = useUiText()
  if (history.length === 0) return null

  const Icon = latestIsFresh ? BellRing : Bell
  const visible = history.slice(0, limit)

  return (
    <div className={cn('rounded-lg border border-border bg-surface px-3 py-2', className)}>
      <div className="flex items-center gap-2 mb-2">
        <Icon className={cn('h-4 w-4 text-amber-400', latestIsFresh && 'animate-pulse')} />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-foreground-subtle">
          {t('uiLibrary.doorbellRecentPanel.recentPresses', 'Recent presses')}
        </span>
        <span className="ml-auto rounded-full bg-foreground-subtle/10 px-1.5 py-0.5 text-[10px] font-medium text-foreground-subtle border border-border">
          {history.length}
        </span>
      </div>
      <ul className="space-y-1">
        {visible.map((p) => (
          <li
            key={`${p.deviceId}-${p.timestamp}`}
            className="flex items-center justify-between text-[11px]"
            title={new Date(p.timestamp).toLocaleString()}
          >
            <span className="text-foreground">{formatRelative(p.timestamp, t)}</span>
            <span className="text-foreground-subtle font-mono text-[10px]">
              {new Date(p.timestamp).toLocaleTimeString()}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
