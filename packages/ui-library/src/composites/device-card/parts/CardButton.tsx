import type { ButtonHTMLAttributes, ReactElement } from 'react'
import { cn } from '../../../lib/cn'
import { Button } from '../../../primitives/button'
import type { CardGlyph } from '../icons'
import { useCardGating } from '../shell/gating'
import { CardIcon } from './CardIcon'

export type CardButtonTone = 'default' | 'primary' | 'on' | 'danger'

export interface CardButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly tone?: CardButtonTone
  readonly glyph?: CardGlyph
  /** False for a control that only READS (a popover opener): gating leaves it alone. */
  readonly actuates?: boolean
}

const TONE: Readonly<Record<CardButtonTone, string>> = {
  default: 'border-border bg-surface text-foreground hover:bg-surface-hover',
  primary: 'border-primary bg-primary text-primary-foreground hover:bg-primary/90',
  on: 'border-primary bg-primary/10 text-primary',
  danger: 'border-danger bg-danger/10 font-semibold text-danger',
}

const BASE =
  'inline-flex min-h-9 min-w-11 items-center justify-center gap-1 whitespace-nowrap rounded-lg border px-2.5 py-2 text-sm transition-colors disabled:pointer-events-none disabled:opacity-45'

/** The card button's classes, for the one trigger that must be its own element (a menu). */
export function cardButtonClass(tone: CardButtonTone, blocked: boolean, extra?: string): string {
  return cn(BASE, TONE[tone], blocked && 'dc-gated', extra)
}

/**
 * The card's one button. A button that actuates obeys the shell's gating: when
 * the card is blocked it is disabled and its title says why.
 */
export function CardButton({
  tone = 'default',
  glyph,
  actuates = true,
  className,
  children,
  disabled,
  title,
  ...rest
}: CardButtonProps): ReactElement {
  const gating = useCardGating()
  const blocked = actuates && gating.blocked
  return (
    <Button
      type="button"
      variant="unstyled"
      {...rest}
      disabled={disabled === true || blocked}
      title={blocked ? (gating.reason ?? undefined) : title}
      className={cardButtonClass(tone, blocked, className)}
    >
      {glyph === undefined ? null : <CardIcon glyph={glyph} />}
      {children}
    </Button>
  )
}
