/**
 * TimelineSlider — one 24 h day as a track with draggable markers.
 *
 * A marker is a point on the day (a scheduler point). Dragging, or the arrow
 * keys on a focused marker, moves it in whole `step` minutes and reports the
 * new minute of the day; the page decides what that means for its data. A
 * marker that is not `draggable` is only selectable. `bands` paint stretches of
 * the day (a hold's window) behind the markers.
 *
 * The pointer → minute mapping is the pure {@link minuteFromPointer}, so it is
 * tested without a layout engine.
 */
import { type JSX, type KeyboardEvent, type PointerEvent, useRef } from 'react'
import { cn } from '../lib/cn'

export const MINUTES_PER_DAY = 1440
const LAST_MINUTE = MINUTES_PER_DAY - 1
const HOUR_TICKS: readonly number[] = [0, 3, 6, 9, 12, 15, 18, 21, 24]

export type TimelineTone = 'primary' | 'success' | 'warning' | 'info' | 'neutral'

export interface TimelineMarker {
  readonly id: string
  /** Minute of the day, 0..1439. */
  readonly minute: number
  /** Short text on the marker (a time, `sunset -30m`). */
  readonly label: string
  readonly tone?: TimelineTone
  readonly draggable?: boolean
}

export interface TimelineBand {
  readonly id: string
  readonly fromMinute: number
  readonly toMinute: number
  readonly tone?: TimelineTone
}

export interface TimelineSliderProps {
  readonly markers: readonly TimelineMarker[]
  readonly bands?: readonly TimelineBand[]
  readonly selectedId?: string | null
  /** Minutes per drag / arrow step. Default 5. */
  readonly step?: number
  readonly ariaLabel: string
  readonly onSelect?: (id: string) => void
  readonly onMove?: (id: string, minute: number) => void
}

/** Keep a minute on the day. */
export function clampMinute(minute: number): number {
  return Math.min(LAST_MINUTE, Math.max(0, Math.round(minute)))
}

/** Round a minute to the nearest `step`, kept on the day. */
export function snapMinute(minute: number, step: number): number {
  const size = Math.max(1, Math.round(step))
  return clampMinute(Math.round(minute / size) * size)
}

/** The minute under a pointer at `clientX` on a track spanning `left`..`left + width`. */
export function minuteFromPointer(
  clientX: number,
  left: number,
  width: number,
  step: number,
): number {
  if (width <= 0) return 0
  const ratio = Math.min(1, Math.max(0, (clientX - left) / width))
  return snapMinute(ratio * MINUTES_PER_DAY, step)
}

const MARKER_TONE: Readonly<Record<TimelineTone, string>> = {
  primary: 'border-primary bg-primary text-primary-foreground',
  success: 'border-success bg-success text-primary-foreground',
  warning: 'border-warning bg-warning text-primary-foreground',
  info: 'border-info bg-info text-primary-foreground',
  neutral: 'border-border bg-surface-hover text-foreground',
}

const BAND_TONE: Readonly<Record<TimelineTone, string>> = {
  primary: 'bg-primary/20',
  success: 'bg-success/20',
  warning: 'bg-warning/20',
  info: 'bg-info/20',
  neutral: 'bg-surface-hover',
}

function percentOf(minute: number): string {
  return `${String((clampMinute(minute) / MINUTES_PER_DAY) * 100)}%`
}

function bandGeometry(band: TimelineBand): { left: string; width: string } {
  const span = ((band.toMinute - band.fromMinute) / MINUTES_PER_DAY) * 100
  return { left: percentOf(band.fromMinute), width: `${String(span)}%` }
}

export function TimelineSlider({
  markers,
  bands = [],
  selectedId = null,
  step = 5,
  ariaLabel,
  onSelect,
  onMove,
}: TimelineSliderProps): JSX.Element {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const dragging = useRef<string | null>(null)

  const moveTo = (id: string, clientX: number): void => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    onMove?.(id, minuteFromPointer(clientX, rect.left, rect.width, step))
  }

  const onPointerDown = (marker: TimelineMarker, event: PointerEvent<HTMLButtonElement>): void => {
    onSelect?.(marker.id)
    if (marker.draggable !== true) return
    dragging.current = marker.id
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onKeyDown = (marker: TimelineMarker, event: KeyboardEvent<HTMLButtonElement>): void => {
    if (marker.draggable !== true) return
    const size = event.shiftKey ? 60 : step
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      event.preventDefault()
      onMove?.(marker.id, clampMinute(marker.minute - size))
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault()
      onMove?.(marker.id, clampMinute(marker.minute + size))
    }
  }

  return (
    <div className="px-3 pb-6 pt-8" data-testid="timeline-slider">
      <div
        ref={trackRef}
        role="group"
        aria-label={ariaLabel}
        className="relative h-3 rounded-full bg-surface-hover"
      >
        {bands.map((band) => (
          <span
            key={band.id}
            className={cn('absolute inset-y-0 rounded-full', BAND_TONE[band.tone ?? 'primary'])}
            style={bandGeometry(band)} // ui-check-ok: computed geometry (percent of the day)
          />
        ))}
        {HOUR_TICKS.map((hour) => (
          <span
            key={hour}
            aria-hidden="true"
            className="absolute top-full mt-1 -translate-x-1/2 text-[10px] text-foreground-subtle"
            style={{ left: `${String((hour / 24) * 100)}%` }} // ui-check-ok: computed geometry (percent of the day)
          >
            {String(hour).padStart(2, '0')}
          </span>
        ))}
        {markers.map((marker) => {
          const selected = marker.id === selectedId
          return (
            <button // ui-check-ok: a draggable role=slider marker, not an action button
              key={marker.id}
              type="button"
              role="slider"
              aria-label={marker.label}
              aria-valuemin={0}
              aria-valuemax={LAST_MINUTE}
              aria-valuenow={marker.minute}
              aria-valuetext={marker.label}
              aria-orientation="horizontal"
              data-testid={`timeline-marker-${marker.id}`}
              className={cn(
                'absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 touch-none rounded-full border-2',
                'focus-visible:outline-2 focus-visible:outline-primary',
                marker.draggable === true ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
                MARKER_TONE[marker.tone ?? 'primary'],
                selected && 'ring-2 ring-foreground',
              )}
              style={{ left: percentOf(marker.minute) }} // ui-check-ok: computed geometry (percent of the day)
              onPointerDown={(event) => onPointerDown(marker, event)}
              onPointerMove={(event) => {
                if (dragging.current === marker.id) moveTo(marker.id, event.clientX)
              }}
              onPointerUp={(event) => {
                if (dragging.current === marker.id) {
                  dragging.current = null
                  event.currentTarget.releasePointerCapture(event.pointerId)
                }
              }}
              onKeyDown={(event) => onKeyDown(marker, event)}
            >
              <span className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-surface px-1 text-[10px] text-foreground">
                {marker.label}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
