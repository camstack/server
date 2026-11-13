import type { IconKey } from '@camstack/types'
import type { ReactElement } from 'react'
import { cn } from '../../../lib/cn'
import { useDisplayIconResolver } from '../../icon-glyphs'

export interface ReadingValueProps {
  /** The quantity's icon beside the value (the server's id); `null` = none. */
  readonly icon: IconKey | null
  readonly value: string
  readonly unit: string | null
  /** A word, not a number: drawn smaller and allowed to wrap. */
  readonly text?: boolean
}

/** One reading, big: the quantity's icon, the value, the unit small and muted. */
export function ReadingValue({
  icon,
  value,
  unit,
  text = false,
}: ReadingValueProps): ReactElement {
  const resolve = useDisplayIconResolver()
  const Glyph = icon === null ? undefined : resolve(icon)
  return (
    <div className="flex min-w-0 max-w-full items-center gap-3" data-testid="dc-reading">
      {Glyph === undefined ? null : <Glyph className="size-10 shrink-0" aria-hidden />}
      <div className="flex min-w-0 items-baseline gap-1 text-foreground">
        <span
          data-testid="dc-reading-value"
          className={cn(
            'min-w-0 font-semibold leading-none tabular-nums',
            text ? 'break-words text-center text-4xl' : 'text-6xl',
          )}
        >
          {value}
        </span>
        {unit === null ? null : (
          <span className="text-xl font-semibold text-foreground-muted">{unit}</span>
        )}
      </div>
    </div>
  )
}
