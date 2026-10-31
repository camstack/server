/**
 * EventCard — one card in the Detection Intelligence "Events" grid.
 *
 * Shared between the normal key-events feed (`EventsSection`) and the CLIP
 * semantic-search results (`SemanticEventSearch`). The thumbnail resolves off
 * the admin-gated event-media data-plane via `useAuthedImage` (an `<img>` can't
 * carry the Bearer header): {@link TrackSubject.mediaId} when the row already
 * has one, else the OWNER form for the row's `trackId` (D482) — never
 * `bestEventId`, which names no table and so cannot address a plane URL by
 * itself. The card is deliberately mode-agnostic:
 *
 * - `onToggleSelect` present  → renders the selection checkbox (feed mode).
 * - `score` present           → renders a semantic-match score badge (search
 *                               mode); the checkbox slot is free there.
 *
 * - `provenance` present     → renders a stand-in / low-res badge over the
 *                              tile (D276); see `media-provenance.ts`.
 * - `footer` present         → extra markup under the metadata block (the
 *                              Debug tab's findings).
 *
 * Keeping ONE card component guarantees search hits render pixel-identical to
 * normal events (same aspect/crop handling), plus the small extra badge — and
 * is why the Debug tab has no card of its own. The prop is a
 * {@link TrackSubject}, not the events feed's row, so any surface holding a
 * track can render one.
 */

import { Bug, Check, CheckSquare, GraduationCap, ImageOff, Square, Star } from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { mediaIdPath, mediaOwnerPath, useAuthedImage } from '../../lib/authed-media.js'
import { formatFaceTimestamp } from '../../lib/face-gallery-filters.js'
import { rowDisplayLabel, trackSelectionKey } from './key-events-merge.js'
import { type MediaProvenance, provenanceBadge } from './media-provenance.js'
import type { TrackSubject } from './track-subject.js'
import { useTranslation } from 'react-i18next'
import { Button } from '@camstack/ui-library'

/** windowMs → compact "3.2s" / "1m 05s" duration label; '' when unknown. */
function formatDuration(windowMs: number | undefined): string {
  if (windowMs === undefined || !Number.isFinite(windowMs) || windowMs <= 0) return ''
  const totalSec = windowMs / 1000
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`
  const mins = Math.floor(totalSec / 60)
  const secs = Math.round(totalSec % 60)
  return `${String(mins)}m ${String(secs).padStart(2, '0')}s`
}

interface EventCardProps<T extends TrackSubject> {
  readonly row: T
  readonly cameraName: string
  readonly nowMs: number
  readonly onOpenDetail: (row: T) => void
  /** Feed mode: selection state + toggle. Omit to hide the checkbox (search mode). */
  readonly selected?: boolean
  /** Receives the COMPOSITE `${deviceId}:${trackId}` selection key. */
  readonly onToggleSelect?: (selectionKey: string) => void
  /** Search mode: CLIP semantic-match score [0,1] → top-left badge. */
  readonly score?: number
  /**
   * Provenance of the tile being shown (D276). Absent — and `native` — render
   * NOTHING: a pre-column row ranks `native` precisely because it cannot be
   * classified, so a "native" badge would be a claim nobody checked.
   */
  readonly provenance?: MediaProvenance
  /** Extra markup below the metadata block. The Debug tab's findings live here. */
  readonly footer?: ReactNode
}

export function EventCard<T extends TrackSubject>({
  row,
  cameraName,
  nowMs,
  onOpenDetail,
  selected = false,
  onToggleSelect,
  score,
  provenance,
  footer,
}: EventCardProps<T>): JSX.Element {
  const { t } = useTranslation()
  // Prefer the row's own media row id (D482); every TrackSubject carries a
  // trackId, so the owner-form ladder always has something to ask when the
  // row has no `mediaId` of its own.
  const thumb = useAuthedImage(
    row.mediaId !== undefined ? mediaIdPath(row.mediaId) : mediaOwnerPath('track', row.trackId),
  )
  const importancePct = Math.round(row.importance * 100)
  const scorePct = score === undefined ? undefined : Math.round(score * 100)
  const duration = formatDuration(row.windowMs)
  const openDetail = () => onOpenDetail(row)
  // Rendered whether or not the tile's bytes arrived. Provenance is a fact
  // about the STORED row, not about this browser's fetch — and on a tile that
  // failed to load it is the only thing still saying what the pipeline kept.
  const provBadge = provenanceBadge(provenance)

  return (
    <div
      className={`relative flex flex-col rounded-md border bg-surface overflow-hidden ${selected ? 'border-primary ring-1 ring-primary' : 'border-border'}`}
    >
      <div className="aspect-video relative overflow-hidden bg-surface-hover">
        {thumb.src ? (
          <img
            src={thumb.src}
            alt={t('detectionIntelligence.eventCard.eventFrom', 'Event from {{cameraName}}', {
              cameraName,
            })}
            onClick={openDetail}
            className="h-full w-full cursor-zoom-in object-cover"
          />
        ) : (
          <Button
            variant="unstyled"
            type="button"
            onClick={openDetail}
            className="flex h-full w-full flex-col items-center justify-center gap-1 bg-surface-hover text-foreground-subtle"
            title={
              thumb.failed
                ? t(
                    'detectionIntelligence.eventCard.keyEventMediaUnavailable',
                    'Key-event media unavailable',
                  )
                : t('detectionIntelligence.eventCard.noKeyEventMedia', 'No key-event media')
            }
          >
            <ImageOff className="h-6 w-6 opacity-60" />
          </Button>
        )}

        {/* Select checkbox (feed mode) — always visible + interactive;
            stopPropagation keeps a tick from also opening the detail. */}
        {onToggleSelect && (
          <Button
            variant="unstyled"
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onToggleSelect(trackSelectionKey(row.deviceId, row.trackId))
            }}
            className="absolute left-0 top-0 z-10 rounded-br-md bg-black/50 p-1.5 text-white hover:bg-black/70"
            aria-label={
              selected
                ? t('detectionIntelligence.eventCard.deselect', 'Deselect')
                : t('detectionIntelligence.eventCard.select', 'Select')
            }
          >
            {selected ? (
              <CheckSquare className="h-4 w-4 text-primary" />
            ) : (
              <Square className="h-4 w-4" />
            )}
          </Button>
        )}

        {/* Semantic-match score badge (search mode) — sits where the checkbox
            would be in feed mode; the two never coexist. */}
        {scorePct !== undefined && (
          <span
            className="absolute left-1 top-1 z-10 rounded bg-primary/85 px-1.5 py-0.5 text-[10px] font-semibold text-white tabular-nums"
            title={t(
              'detectionIntelligence.eventCard.clipSemanticMatchScore',
              'CLIP semantic-match score',
            )}
          >
            {String(scorePct)}%
          </span>
        )}

        {/* Importance badge (top-right). */}
        {importancePct > 0 && (
          <span className="absolute right-1 top-1 z-10 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-white">
            {String(importancePct)}
          </span>
        )}

        {/* Provenance of the tile (D276), bottom-right — clear of the flags.
            The operator's "facce senza la persona" complaint, made visible on
            the tile it is about: a stand-in must never be shown as if it were
            a best shot. Nothing is drawn for `native` or for a tile whose
            origin was never recorded. */}
        {provBadge !== null && (
          <span
            className={`absolute bottom-1 right-1 z-10 rounded px-1.5 py-0.5 text-[10px] font-semibold text-white ${
              provBadge.tone === 'warning' ? 'bg-warning/90' : 'bg-black/70'
            }`}
            title={provBadge.title}
          >
            {provBadge.label}
          </span>
        )}

        {/* Operator flags. Read-only here — the toggles live in the detail
            panel. Present so a flagged track is findable by eye in a grid of
            200: a flag whose only evidence is behind a modal is a flag the
            operator has to remember, and they will not. Bottom-left, clear of
            the checkbox/score slot above it. */}
        {(row.markForTrain === true ||
          row.retrainStatus === 'trained' ||
          row.debug === true ||
          row.favourited === true) && (
          <span className="absolute bottom-1 left-1 z-10 flex gap-1">
            {row.markForTrain === true && (
              <span
                className="rounded bg-primary/85 p-0.5 text-white"
                title={t(
                  'detectionIntelligence.eventCard.markedForTraining',
                  'Marked for training',
                )}
                aria-label={t(
                  'detectionIntelligence.eventCard.markedForTraining',
                  'Marked for training',
                )}
              >
                <GraduationCap className="h-3 w-3" />
              </span>
            )}
            {row.retrainStatus === 'trained' && row.markForTrain !== true && (
              <span
                className="rounded bg-success/85 p-0.5 text-white"
                title={t('detectionIntelligence.eventCard.trainingComplete', 'Training complete')}
                aria-label={t(
                  'detectionIntelligence.eventCard.trainingComplete',
                  'Training complete',
                )}
                data-testid="retrain-status-trained"
              >
                <Check className="h-3 w-3" />
              </span>
            )}
            {row.debug === true && (
              <span
                className="rounded bg-black/70 p-0.5 text-white"
                title={t('detectionIntelligence.eventCard.flaggedForDebug', 'Flagged for debug')}
                aria-label={t(
                  'detectionIntelligence.eventCard.flaggedForDebug',
                  'Flagged for debug',
                )}
              >
                <Bug className="h-3 w-3" />
              </span>
            )}
            {row.favourited === true && (
              <span
                className="rounded bg-primary/85 p-0.5 text-white"
                title={t('detectionIntelligence.eventCard.favourited', 'Favourited')}
                aria-label={t('detectionIntelligence.eventCard.favourited', 'Favourited')}
              >
                <Star className="h-3 w-3" />
              </span>
            )}
          </span>
        )}
      </div>

      <Button
        variant="unstyled"
        type="button"
        onClick={openDetail}
        className="min-w-0 px-2 py-1.5 text-left space-y-0.5"
      >
        <p className="text-[11px] font-medium text-foreground truncate" title={row.className}>
          {row.className}
          {rowDisplayLabel(row) ? (
            <span className="text-foreground-subtle"> · {rowDisplayLabel(row)}</span>
          ) : null}
        </p>
        <p className="text-[10px] text-foreground-subtle truncate" title={cameraName}>
          {cameraName}
        </p>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-foreground-subtle truncate">
            {formatFaceTimestamp(row.timestamp, nowMs)}
          </span>
          {duration && (
            <span className="text-[10px] text-foreground-subtle shrink-0">{duration}</span>
          )}
        </div>
      </Button>

      {/* Caller-supplied tail. OUTSIDE the button: the Debug tab's findings are
          badges with their own `title`, and a title inside a button is
          unreachable on touch. */}
      {footer !== undefined && <div className="px-2 pb-1.5">{footer}</div>}
    </div>
  )
}
