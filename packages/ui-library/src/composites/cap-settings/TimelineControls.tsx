import { useUiText } from '../../contexts/ui-text'
import { type ChangeEvent, type JSX } from 'react'
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react'
import {
  ZOOM_LEVELS,
  panWindow,
  zoomWindowAnchoredRight,
  type DayWindow,
} from './recording-timeline-model'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a Date as "YYYY-MM-DD" for <input type="date">. */
function formatDateInput(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Parse "YYYY-MM-DD" from <input type="date"> into a local-midnight Date. */
function parseDateInput(value: string): Date | null {
  const parts = value.split('-')
  const y = parts[0] !== undefined ? parseInt(parts[0], 10) : NaN
  const m = parts[1] !== undefined ? parseInt(parts[1], 10) : NaN
  const d = parts[2] !== undefined ? parseInt(parts[2], 10) : NaN
  if (isNaN(y) || isNaN(m) || isNaN(d)) return null
  return new Date(y, m - 1, d)
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TimelineControlsProps {
  /** Currently selected calendar day. */
  readonly day: Date
  /** Called when the user picks a new day. */
  readonly onDayChange: (d: Date) => void
  /** Current zoom+pan view window. */
  readonly view: DayWindow
  /** Full day bounds (used for zoom/pan clamping). */
  readonly dayBounds: DayWindow
  /** Called when zoom changes the view. */
  readonly onViewChange: (w: DayWindow) => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Date selector + prev/next pan + zoom-in / zoom-out buttons for the recording
 * timeline. Zoom cycles through ZOOM_LEVELS (widest → narrowest), anchored on
 * the view's RIGHT edge — so on today's timeline "now" stays pinned to the right
 * instead of drifting to a midday range. The ◀ / ▶ buttons step the visible
 * window earlier/later within the day (the discoverable equivalent of the
 * horizontal wheel-pan wired in RecordingTimeline), so a zoomed-in day can be
 * navigated back and forth without a mouse wheel.
 */
export function TimelineControls({
  day,
  onDayChange,
  view,
  dayBounds,
  onViewChange,
}: TimelineControlsProps): JSX.Element | null {
  const t = useUiText()
  const handleDateChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const parsed = parseDateInput(e.target.value)
    if (parsed !== null) onDayChange(parsed)
  }

  // Find the closest zoom level index for the current view width.
  const viewSpan = view.toMs - view.fromMs
  const currentLevelIdx = (() => {
    let best = 0
    let bestDiff = Infinity
    for (let i = 0; i < ZOOM_LEVELS.length; i++) {
      const level = ZOOM_LEVELS[i]
      if (level === undefined) continue
      const diff = Math.abs(level - viewSpan)
      if (diff < bestDiff) {
        bestDiff = diff
        best = i
      }
    }
    return best
  })()

  // Anchor zoom on the view's right edge so "now" (today's right edge) stays
  // visible; the user pans to move the window back/forward in time.
  const rightEdgeMs = view.toMs

  const handleZoomIn = (): void => {
    // Narrower → higher index in ZOOM_LEVELS
    const nextIdx = Math.min(currentLevelIdx + 1, ZOOM_LEVELS.length - 1)
    const nextLevel = ZOOM_LEVELS[nextIdx]
    if (nextLevel === undefined) return
    onViewChange(zoomWindowAnchoredRight(dayBounds, nextLevel, rightEdgeMs))
  }

  const handleZoomOut = (): void => {
    // Wider → lower index in ZOOM_LEVELS
    const nextIdx = Math.max(currentLevelIdx - 1, 0)
    const nextLevel = ZOOM_LEVELS[nextIdx]
    if (nextLevel === undefined) return
    onViewChange(zoomWindowAnchoredRight(dayBounds, nextLevel, rightEdgeMs))
  }

  const canZoomIn = currentLevelIdx < ZOOM_LEVELS.length - 1
  const canZoomOut = currentLevelIdx > 0

  // Prev/next pan: step the visible window earlier/later within the day by ~90%
  // of its width (a slight overlap keeps context). Buttons are the discoverable
  // equivalent of horizontal wheel-pan — the only prior way to move a zoomed
  // window back/forward. Disabled at the day edges.
  const panStepMs = Math.max(1, Math.round(viewSpan * 0.9))
  const canPanPrev = view.fromMs > dayBounds.fromMs
  const canPanNext = view.toMs < dayBounds.toMs

  const handlePanPrev = (): void => {
    onViewChange(panWindow(view, dayBounds, -panStepMs))
  }

  const handlePanNext = (): void => {
    onViewChange(panWindow(view, dayBounds, panStepMs))
  }

  return (
    <div className="flex items-center gap-2">
      <input
        type="date"
        value={formatDateInput(day)}
        max={formatDateInput(new Date())}
        onChange={handleDateChange}
        className="rounded border border-border bg-background px-2 py-0.5 text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        aria-label={t('uiLibrary.timelineControls.day', 'Select recording day')}
      />

      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          onClick={handlePanPrev}
          disabled={!canPanPrev}
          title={t('uiLibrary.timelineControls.earlierTitle', 'Earlier (pan back)')}
          aria-label={t('uiLibrary.timelineControls.earlier', 'Pan earlier')}
          className="rounded p-1 text-foreground-subtle transition-colors hover:bg-background/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronLeft size={14} />
        </button>
        <button
          type="button"
          onClick={handlePanNext}
          disabled={!canPanNext}
          title={t('uiLibrary.timelineControls.laterTitle', 'Later (pan forward)')}
          aria-label={t('uiLibrary.timelineControls.later', 'Pan later')}
          className="rounded p-1 text-foreground-subtle transition-colors hover:bg-background/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronRight size={14} />
        </button>
        <span className="mx-0.5 h-3 w-px bg-border" aria-hidden="true" />
        <button
          type="button"
          onClick={handleZoomOut}
          disabled={!canZoomOut}
          title={t('uiLibrary.timelineControls.zoomOut', 'Zoom out')}
          aria-label={t('uiLibrary.timelineControls.zoomOut', 'Zoom out')}
          className="rounded p-1 text-foreground-subtle transition-colors hover:bg-background/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ZoomOut size={13} />
        </button>
        <button
          type="button"
          onClick={handleZoomIn}
          disabled={!canZoomIn}
          title={t('uiLibrary.timelineControls.zoomIn', 'Zoom in')}
          aria-label={t('uiLibrary.timelineControls.zoomIn', 'Zoom in')}
          className="rounded p-1 text-foreground-subtle transition-colors hover:bg-background/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ZoomIn size={13} />
        </button>
      </div>

      <span className="text-[9px] text-foreground-subtle">{zoomLabel(viewSpan)}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function zoomLabel(spanMs: number): string {
  const h = spanMs / 3600_000
  if (h >= 24) return '24h'
  if (h >= 1) return `${Math.round(h)}h`
  const m = spanMs / 60_000
  return `${Math.round(m)}m`
}
