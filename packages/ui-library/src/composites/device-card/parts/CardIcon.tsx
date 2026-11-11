import type { ReactElement } from 'react'
import { cn } from '../../../lib/cn'
import { CARD_ICONS, type CardGlyph } from '../icons'

export interface CardIconProps {
  readonly glyph: CardGlyph
  readonly className?: string
}

/** One glyph of the card's icon map, sized to the text beside it. */
export function CardIcon({ glyph, className }: CardIconProps): ReactElement {
  const Icon = CARD_ICONS[glyph]
  return <Icon className={cn('h-3.5 w-3.5 shrink-0', className)} aria-hidden />
}
