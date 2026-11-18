import type { ReactElement } from 'react'
import { cn } from '../../../lib/cn'
import { DIAL_GEOMETRY, DIAL_TONE_CLASS, type DialTone } from './Dial'

export interface ArcGaugeProps {
  /** 0..100; null when not reported: the track alone, never an empty fill read as 0. */
  readonly percent: number | null
  /** The reading in the centre ("23%", or "—"). */
  readonly text: string
  /** What it measures, under the reading ("CPU"). */
  readonly label: string
  readonly tone?: DialTone
  readonly testId?: string
}

const { size, center, radius, arc, startDeg } = DIAL_GEOMETRY

/**
 * A read-only share on the card's arc: the same 270 degree track as the
 * {@link Dial}, filled up to `percent`, with no thumb. Several sit side by side
 * in one scene, so it is smaller than a dial: between 80 px and 128 px.
 */
export function ArcGauge({
  percent,
  text,
  label,
  tone = 'primary',
  testId,
}: ArcGaugeProps): ReactElement {
  const fraction = percent === null ? null : Math.min(1, Math.max(0, percent / 100))
  return (
    <div
      className="@container relative aspect-square w-full min-w-20 max-w-32"
      data-testid={testId}
    >
      <svg
        viewBox={`0 0 ${size} ${size}`}
        className={cn('absolute inset-0 h-full w-full', DIAL_TONE_CLASS[tone])}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent === null ? undefined : Math.round(percent)}
        aria-valuetext={text}
      >
        <circle
          cx={center}
          cy={center}
          r={radius}
          strokeWidth={10}
          fill="none"
          className="text-border"
          stroke="currentColor"
          strokeLinecap="round"
          strokeDasharray={`${arc} 400`}
          transform={`rotate(${startDeg} ${center} ${center})`}
        />
        {fraction === null || fraction === 0 ? null : (
          <circle
            cx={center}
            cy={center}
            r={radius}
            strokeWidth={10}
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeDasharray={`${fraction * arc} 400`}
            transform={`rotate(${startDeg} ${center} ${center})`}
          />
        )}
      </svg>
      <div className="absolute inset-0 grid place-content-center justify-items-center">
        <b className="text-base font-semibold tabular-nums text-foreground @[7rem]:text-xl">
          {text}
        </b>
        <small className="text-xs text-foreground-muted">{label}</small>
      </div>
    </div>
  )
}
