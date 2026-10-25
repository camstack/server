/**
 * OfflineBadge — a small, shared "device is unreachable" pill.
 *
 * Rendered ONCE per device (in the detail hero header) when the
 * device-status slice reports `online: false`. Controls themselves stay
 * mounted showing their last-known value (greyed/read-only via the
 * `useDeviceCapability` `available` gate); this badge is the single,
 * legible explanation of WHY they're inert plus how long ago the device
 * was last seen.
 *
 * Pure presentational atom: no fetches, no internal state. The caller
 * supplies `lastChangedAt` (the device-status `lastChangedAt` /
 * `useDeviceCapability` `offlineSince`). When it is absent or
 * non-positive only the "Unavailable" label renders.
 */
import type { ReactElement } from 'react'
import { WifiOff } from 'lucide-react'
import { useUiText } from '../../contexts/ui-text'
import { cn } from '../../lib/cn'
import { formatLastSeen } from '../../lib/format-last-seen'

export interface OfflineBadgeProps {
  /**
   * Ms epoch of the last online→offline transition (device-status
   * `lastChangedAt`). `null`/`undefined`/non-positive → no "last seen"
   * suffix is shown.
   */
  readonly lastChangedAt?: number | null
  readonly className?: string
}

export function OfflineBadge({ lastChangedAt, className }: OfflineBadgeProps): ReactElement {
  const t = useUiText()
  const lastSeen = formatLastSeen(lastChangedAt)
  const unavailable = t('uiLibrary.offlineBadge.unavailable', 'Unavailable')
  const lastSeenText =
    lastSeen === null
      ? null
      : t('uiLibrary.offlineBadge.lastSeen', 'last seen {{when}}', { when: lastSeen })
  const title = lastSeenText === null ? unavailable : `${unavailable} · ${lastSeenText}`

  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5',
        'bg-surface-hover text-foreground-subtle text-[10px] font-medium',
        'border border-border',
        className,
      )}
    >
      <WifiOff className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
      <span>{unavailable}</span>
      {lastSeenText !== null ? (
        <span className="text-foreground-subtle/70">{`· ${lastSeenText}`}</span>
      ) : null}
    </span>
  )
}
