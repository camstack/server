import type { ReactElement } from 'react'
import { cn } from '../../../lib/cn'
import { Button } from '../../../primitives/button'
import { useCardGating } from '../shell/gating'

export interface ButtonGroupOption {
  readonly id: string
  readonly label: string
}

export interface ButtonGroupProps {
  readonly options: readonly ButtonGroupOption[]
  readonly value: string | null
  readonly onChange: (id: string) => void
  readonly ariaLabel: string
  readonly disabled?: boolean
  /** False for a choice that only changes what is SHOWN (a tab): gating leaves it alone. */
  readonly actuates?: boolean
  readonly testId?: string
}

/** A row of mutually exclusive chips (presets, heat / cool / auto). */
export function ButtonGroup({
  options,
  value,
  onChange,
  ariaLabel,
  disabled,
  actuates = true,
  testId,
}: ButtonGroupProps): ReactElement {
  const shell = useCardGating()
  const gating = actuates ? shell : { blocked: false, reason: null }
  const off = disabled === true || gating.blocked
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      data-testid={testId}
      className={cn('flex flex-wrap justify-center gap-1.5', gating.blocked && 'dc-gated')}
    >
      {options.map((o) => (
        <Button
          key={o.id}
          type="button"
          variant="unstyled"
          role="radio"
          aria-checked={o.id === value}
          disabled={off}
          title={gating.blocked ? (gating.reason ?? undefined) : undefined}
          onClick={() => onChange(o.id)}
          className={cn(
            'rounded-md px-2.5 py-1 text-xs transition-colors disabled:pointer-events-none disabled:opacity-45',
            o.id === value
              ? 'bg-primary/10 font-semibold text-primary'
              : 'bg-surface-hover text-foreground-muted hover:text-foreground',
          )}
        >
          {o.label}
        </Button>
      ))}
    </div>
  )
}
