/**
 * Status indicator dot — parity with the viewer's camera status dot.
 * Pure-render atom; no fetches, no internal state (the row resolves the
 * recording-aware status and passes it in).
 *
 * Colour by fixed priority (the row resolves which one applies):
 *   • disabled              → black (+ ring so it stays visible) — soft-disabled.
 *   • offline               → grey — not disabled, not reachable.
 *   • recording-continuous  → red  — online + always-on recording.
 *   • recording-events      → blue — online + on-motion recording.
 *   • online                → green — online, recording off.
 *
 * The "alive" states (online + recording) pulse; offline + disabled are static.
 *
 * When `status === 'offline'` and a `lastChangedAt` (ms epoch of the last
 * online→offline transition) is supplied, the hover tooltip is enriched to
 * "Offline · last seen Xm ago".
 */
import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { useUiText, type UiTextFn } from '../../contexts/ui-text'
import { formatLastSeen } from '../../lib/format-last-seen'

export type StatusDotStatus =
  | 'online'
  | 'offline'
  | 'disabled'
  | 'recording-continuous'
  | 'recording-events'

export interface StatusDotProps {
  readonly status: StatusDotStatus
  /** Ms epoch of the last online→offline transition. Only used to enrich
   *  the tooltip when `status === 'offline'`. */
  readonly lastChangedAt?: number | null
}

/** The states that breathe (are "alive"). Offline + disabled are static. */
function isAlive(status: StatusDotStatus): boolean {
  return status === 'online' || status === 'recording-continuous' || status === 'recording-events'
}

function resolveTitle(
  status: StatusDotStatus,
  lastChangedAt: number | null | undefined,
  t: UiTextFn,
): string {
  switch (status) {
    case 'disabled':
      return t('uiLibrary.statusDot.disabled', 'Disabled')
    case 'online':
      return t('uiLibrary.statusDot.online', 'Online')
    case 'recording-continuous':
      return t('uiLibrary.statusDot.recordingAlways', 'Recording · always')
    case 'recording-events':
      return t('uiLibrary.statusDot.recordingMotion', 'Recording · on motion')
    case 'offline': {
      const lastSeen = formatLastSeen(lastChangedAt, t)
      return lastSeen === null
        ? t('uiLibrary.statusDot.offline', 'Offline')
        : t('uiLibrary.statusDot.offlineLastSeen', 'Offline · last seen {{lastSeen}}', { lastSeen })
    }
  }
}

function colorClass(status: StatusDotStatus): string {
  switch (status) {
    case 'disabled':
      // Black + a hairline ring so it stays visible on a dark surface.
      return 'bg-black ring-1 ring-foreground-subtle/60'
    case 'offline':
      return 'bg-foreground-subtle'
    case 'recording-continuous':
      return 'bg-danger'
    case 'recording-events':
      return 'bg-info'
    case 'online':
      return 'bg-success'
  }
}

export function StatusDot({ status, lastChangedAt }: StatusDotProps): ReactNode {
  const t = useUiText()
  return (
    <span
      className={cn(
        'h-1.5 w-1.5 rounded-full flex-shrink-0',
        colorClass(status),
        isAlive(status) && 'animate-pulse',
      )}
      title={resolveTitle(status, lastChangedAt, t)}
    />
  )
}
