import type { ReactElement } from 'react'
import { cn } from '../../../lib/cn'
import { LevelBar, type LevelTone } from './LevelBar'

export interface LevelRowProps {
  /** "Water", "Tank", "Food". */
  readonly label: string
  /** 0..100, or null when the device has not reported it: an empty bar and "—". */
  readonly percent: number | null
  /** Warning colour on the bar and the value: the level stops the device. */
  readonly warn?: boolean
  readonly testId?: string
}

/** A scene's level line under the drawing: label, bar, percentage. */
export function LevelRow({ label, percent, warn = false, testId }: LevelRowProps): ReactElement {
  const tone: LevelTone = warn ? 'warning' : 'info'
  return (
    <div
      data-testid={testId}
      data-warn={warn}
      className="grid w-full max-w-65 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 text-xs"
    >
      <span className={warn ? 'text-warning' : 'text-foreground-muted'}>{label}</span>
      <LevelBar percent={percent ?? 0} tone={tone} ariaLabel={label} />
      <b className={cn('font-semibold tabular-nums', warn ? 'text-warning' : 'text-foreground')}>
        {percent === null ? '—' : `${Math.round(percent)}%`}
      </b>
    </div>
  )
}
