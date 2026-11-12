import type { ReactElement } from 'react'
import { cn } from '../../../lib/cn'

export interface CardReading {
  readonly id: string
  readonly label: string
  /** Null when the device does not report it: drawn as a muted dash, never as zero. */
  readonly value: string | null
}

export interface CardReadingsProps {
  readonly items: readonly CardReading[]
  /** `end` for the scene's left column (it leans on the drawing), `start` for the right. */
  readonly align?: 'start' | 'end'
  readonly testId?: string
}

/** A side column of read-only values: the label small, the value under it. */
export function CardReadings({ items, align = 'start', testId }: CardReadingsProps): ReactElement {
  return (
    <dl
      data-testid={testId}
      className={cn(
        'grid w-full gap-2 text-xs text-foreground-muted',
        align === 'end' ? 'text-right' : 'text-left',
      )}
    >
      {items.map((item) => (
        <div key={item.id} data-reading={item.id} className="grid min-w-0">
          <dt className="truncate">{item.label}</dt>
          <dd
            className={cn(
              'tabular-nums',
              item.value === null
                ? 'text-sm text-foreground-muted'
                : 'text-base font-semibold text-foreground',
            )}
          >
            {item.value ?? '—'}
          </dd>
        </div>
      ))}
    </dl>
  )
}
