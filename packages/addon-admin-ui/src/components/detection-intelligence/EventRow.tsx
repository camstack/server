/**
 * One key event as a compact list row: a small thumbnail on the left, class,
 * time and score on the right, the whole row one click target that SEEKS.
 *
 * The rows variant of the events feed, for a surface where the list sits
 * beside a player (Archive → Review): ~7 rows fit where two cards did. The
 * thumbnail still opens the detail panel; the rest of the row plays the
 * moment. Two explicit icon buttons, Details and Play, say the same at every
 * size step.
 */
import { Button, IconButton, Tooltip, TooltipContent, TooltipTrigger } from '@camstack/ui-library'
import { ImageOff, Info, Play, type LucideIcon } from 'lucide-react'
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { mediaIdPath, mediaOwnerPath, useAuthedImage } from '../../lib/authed-media.js'
import { EVENT_ROW_THUMB_CLASS, type EventRowSize } from './event-row-size.js'
import { rowDisplayLabel } from './key-events-merge.js'
import type { TrackSubject } from './track-subject.js'

export interface EventRowProps<T extends TrackSubject> {
  readonly row: T
  readonly onSeek: (atMs: number) => void
  readonly onOpenDetail: (row: T) => void
  /** The size slider's step; the thumbnail grows with it. Default compact. */
  readonly size?: EventRowSize
}

export function EventRow<T extends TrackSubject>({
  row,
  onSeek,
  onOpenDetail,
  size = 0,
}: EventRowProps<T>): JSX.Element {
  const { t } = useTranslation()
  const thumb = useAuthedImage(
    row.mediaId !== undefined ? mediaIdPath(row.mediaId) : mediaOwnerPath('track', row.trackId),
  )
  const importancePct = Math.round(row.importance * 100)
  const label = rowDisplayLabel(row)
  const time = new Date(row.timestamp).toLocaleTimeString()

  return (
    <div
      className="flex w-full items-center gap-2 rounded-md border border-border bg-surface hover:bg-surface-hover"
      data-testid="event-row"
    >
      <Button
        variant="unstyled"
        type="button"
        onClick={() => onOpenDetail(row)}
        className={`aspect-video ${EVENT_ROW_THUMB_CLASS[size]} shrink-0 overflow-hidden rounded-l-md bg-surface-hover`}
        aria-label={t('detectionIntelligence.eventRow.openDetail', 'Open event details')}
      >
        {thumb.src ? (
          <img src={thumb.src} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-foreground-subtle">
            <ImageOff className="h-4 w-4 opacity-60" />
          </span>
        )}
      </Button>
      <Button
        variant="unstyled"
        type="button"
        onClick={() => onSeek(row.timestamp)}
        className="flex min-w-0 flex-1 items-center gap-2 py-1 pr-2 text-left"
        aria-label={t('detectionIntelligence.eventRow.seek', 'Play {{className}} at {{time}}', {
          className: row.className,
          time,
        })}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-medium text-foreground">
            {row.className}
            {label ? <span className="text-foreground-subtle"> · {label}</span> : null}
          </span>
          <span className="block text-[11px] tabular-nums text-foreground-subtle">{time}</span>
        </span>
        {importancePct > 0 && (
          <span className="shrink-0 rounded bg-surface-hover px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-foreground-muted">
            {String(importancePct)}
          </span>
        )}
      </Button>
      <div className="flex shrink-0 items-center gap-0.5 pr-1">
        <RowAction
          icon={Info}
          label={t('detectionIntelligence.eventRow.details', 'Details')}
          onClick={() => onOpenDetail(row)}
        />
        <RowAction
          icon={Play}
          label={t('detectionIntelligence.eventRow.play', 'Play')}
          onClick={() => onSeek(row.timestamp)}
        />
      </div>
    </div>
  )
}

interface RowActionProps {
  readonly icon: LucideIcon
  readonly label: string
  readonly onClick: () => void
}

/** One icon action on the row, its label as both tooltip and accessible name. */
function RowAction({ icon, label, onClick }: RowActionProps): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger>
        <IconButton variant="ghost" size="sm" icon={icon} aria-label={label} onClick={onClick} />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
