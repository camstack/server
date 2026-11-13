import type { ReactElement, ReactNode } from 'react'
import { cn } from '../../../lib/cn'
import type { CardGlyph } from '../icons'
import { CardIcon } from './CardIcon'

export interface ValueChipProps {
  readonly glyph?: CardGlyph
  readonly children: ReactNode
  readonly tone?: 'default' | 'danger'
  readonly className?: string
  readonly 'data-testid'?: string
}

/** A small read-only pill (integration name, an offline note, a reading). */
export function ValueChip({
  glyph,
  children,
  tone = 'default',
  className,
  'data-testid': testId,
}: ValueChipProps): ReactElement {
  return (
    <span
      data-testid={testId}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs',
        tone === 'danger' ? 'bg-danger/10 text-danger' : 'bg-surface-hover text-foreground-muted',
        className,
      )}
    >
      {glyph === undefined ? null : <CardIcon glyph={glyph} className="h-3 w-3" />}
      {children}
    </span>
  )
}
