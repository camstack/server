import { useRef, useState, type MouseEvent, type PointerEvent, type JSX } from 'react'
import { useUiText } from '../../contexts/ui-text'
import type { PlaybackSpan } from './recording-spans'
import { pctForMs } from './recording-timeline-model'

interface CoverageTrackProps {
  readonly windowFrom: number
  readonly windowTo: number
  readonly spans: readonly PlaybackSpan[]
  /** Last-seeked position to mark with the playhead, or null. */
  readonly playheadMs: number | null
  /** Called with the absolute ms a click maps to within the window. */
  readonly onSeek: (clickMs: number) => void
  /**
   * Drag-scrub callbacks (R9, frame-push mode). When `onScrubEnd` is
   * provided the track switches to pointer-driven scrubbing: pointer-down
   * begins a drag, moves report the hovered epoch, release commits it —
   * a motionless press+release behaves like a seek. `onSeek` is then
   * suppressed (the pointer flow owns the gesture). Omit all three for the
   * classic click-to-seek behaviour.
   */
  readonly onScrubStart?: () => void
  readonly onScrubMove?: (ms: number) => void
  readonly onScrubEnd?: (ms: number) => void
}

// Continuous recorded-coverage track over the selected time window. Recorded
// spans are filled bars; the background shows as the gap. Clicking anywhere
// reports the wall-clock ms under the cursor (the parent clamps it into a
// playable span). A thin playhead marks the active position.
// D4: a tooltip shows the absolute date+time while hovering the track.
export function CoverageTrack({
  windowFrom,
  windowTo,
  spans,
  playheadMs,
  onSeek,
  onScrubStart,
  onScrubMove,
  onScrubEnd,
}: CoverageTrackProps): JSX.Element | null {
  const t = useUiText()
  // D4: hover tooltip state.
  const [hoverInfo, setHoverInfo] = useState<{ xPct: number; ms: number } | null>(null)
  // R9: drag-scrub state — active while the pointer is captured.
  const scrubEnabled = Boolean(onScrubEnd)
  const [dragging, setDragging] = useState(false)
  /** Last epoch reported during the drag — commit target on cancel/release. */
  const lastDragMsRef = useRef<number | null>(null)

  const msFromEvent = (e: MouseEvent<HTMLDivElement>): number | null => {
    const rect = e.currentTarget.getBoundingClientRect()
    if (rect.width <= 0) return null
    const ratio = (e.clientX - rect.left) / rect.width
    const clamped = Math.min(1, Math.max(0, ratio))
    return windowFrom + clamped * (windowTo - windowFrom)
  }

  const handleClick = (e: MouseEvent<HTMLDivElement>): void => {
    // In scrub mode the pointer handlers own the gesture (a motionless
    // press+release already committed on pointer-up) — don't double-fire.
    if (scrubEnabled) return
    const ms = msFromEvent(e)
    if (ms === null) return
    onSeek(ms)
  }

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (!scrubEnabled) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
    onScrubStart?.()
    const ms = msFromEvent(e)
    if (ms !== null) {
      lastDragMsRef.current = ms
      onScrubMove?.(ms)
    }
  }

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (!scrubEnabled || !dragging) return
    const ms = msFromEvent(e)
    if (ms === null) return
    lastDragMsRef.current = ms
    onScrubMove?.(ms)
  }

  const handlePointerUp = (e: PointerEvent<HTMLDivElement>): void => {
    if (!scrubEnabled || !dragging) return
    setDragging(false)
    const ms = msFromEvent(e) ?? lastDragMsRef.current
    lastDragMsRef.current = null
    if (ms !== null) onScrubEnd?.(ms)
  }

  const handlePointerCancel = (): void => {
    if (!dragging) return
    setDragging(false)
    const ms = lastDragMsRef.current
    lastDragMsRef.current = null
    if (ms !== null) onScrubEnd?.(ms)
  }

  const handleMouseMove = (e: MouseEvent<HTMLDivElement>): void => {
    const ms = msFromEvent(e)
    if (ms === null) return
    const rect = e.currentTarget.getBoundingClientRect()
    const xPct = rect.width > 0 ? ((e.clientX - rect.left) / rect.width) * 100 : 0
    setHoverInfo({ xPct, ms })
  }

  const handleMouseLeave = (): void => {
    setHoverInfo(null)
  }

  // Format the hovered timestamp as a full date+time label.
  const hoverLabel =
    hoverInfo !== null
      ? new Date(hoverInfo.ms).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      : null

  return (
    <div className="relative">
      <div
        data-testid="coverage-track"
        data-scrubbing={dragging ? 'true' : 'false'}
        onClick={handleClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        className={`relative h-5 overflow-hidden rounded bg-background/40 ${scrubEnabled ? 'cursor-ew-resize touch-none select-none' : 'cursor-pointer'}`}
        role="group"
        aria-label={t('uiLibrary.coverageTrack.ariaLabel', 'Recorded coverage timeline')}
      >
        {spans.map((s) => {
          const left = pctForMs(s.startMs, windowFrom, windowTo)
          const right = pctForMs(s.endMs, windowFrom, windowTo)
          return (
            <div
              key={`${s.startMs}-${s.endMs}`}
              data-testid="coverage-band"
              className="absolute inset-y-0 bg-gradient-to-b from-primary to-primary/80"
              style={{ left: `${left}%`, width: `${Math.max(0.5, right - left)}%` }}
            />
          )
        })}
        {playheadMs !== null ? (
          <div
            data-testid="coverage-playhead"
            className="absolute inset-y-[-2px] w-0.5 bg-amber-500 shadow-[0_0_6px] shadow-amber-500"
            style={{ left: `${pctForMs(playheadMs, windowFrom, windowTo)}%` }}
          />
        ) : null}
      </div>

      {/* D4: Hover timestamp tooltip — sits below the track, follows the cursor. */}
      {hoverInfo !== null && hoverLabel !== null ? (
        <div
          data-testid="coverage-hover-tooltip"
          className="pointer-events-none absolute top-full z-10 mt-0.5 -translate-x-1/2 rounded bg-popover px-1.5 py-0.5 text-[9px] text-popover-foreground shadow"
          style={{ left: `${hoverInfo.xPct}%` }}
        >
          {hoverLabel}
        </div>
      ) : null}
    </div>
  )
}
