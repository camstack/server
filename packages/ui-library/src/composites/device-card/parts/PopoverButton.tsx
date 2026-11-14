import type { ReactElement, ReactNode } from 'react'
import { cn } from '../../../lib/cn'
import type { CardGlyph } from '../icons'
import { usePopover } from '../shell/use-popover'
import { CardButton, type CardButtonTone } from './CardButton'
import { CardIcon } from './CardIcon'

export interface PopoverButtonProps {
  readonly glyph?: CardGlyph
  readonly label: ReactNode
  readonly ariaLabel: string
  readonly tone?: CardButtonTone
  readonly disabled?: boolean
  /** Which edge of the button the panel lines up with (default: start). */
  readonly align?: 'start' | 'end'
  readonly testId?: string
  /** Added to the trigger (a side column passes its compact size). */
  readonly buttonClassName?: string
  readonly children: ReactNode
}

/**
 * A card button that opens a small panel anchored under it (a colour palette,
 * an axis' sweep). One outside press or Escape closes it. The trigger obeys the
 * shell's gating like any card button.
 */
export function PopoverButton({
  glyph,
  label,
  ariaLabel,
  tone = 'default',
  disabled,
  align = 'start',
  testId,
  buttonClassName,
  children,
}: PopoverButtonProps): ReactElement {
  const pop = usePopover()
  return (
    <div ref={pop.rootRef} className="relative">
      <CardButton
        glyph={glyph}
        tone={tone}
        aria-label={ariaLabel}
        aria-haspopup="true"
        aria-expanded={pop.open}
        disabled={disabled}
        data-testid={testId}
        className={buttonClassName}
        onClick={pop.toggle}
      >
        {label}
        <CardIcon glyph="menu" className="h-3 w-3" />
      </CardButton>
      {pop.open ? (
        <div
          role="dialog" // ui-check-ok: an anchored in-card popover (card anatomy), not a modal
          aria-label={ariaLabel}
          data-testid={testId === undefined ? undefined : `${testId}-pop`}
          className={cn(
            'absolute top-full z-20 mt-1 flex min-w-44 flex-col gap-2 rounded-xl border border-border bg-surface p-3 text-sm text-foreground shadow-lg',
            align === 'end' ? 'right-0' : 'left-0',
          )}
        >
          {children}
        </div>
      ) : null}
    </div>
  )
}
