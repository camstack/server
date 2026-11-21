import type { ReactElement } from 'react'
import { cn } from '../../../lib/cn'
import { Button } from '../../../primitives/button'
import type { CardGlyph } from '../icons'
import { useCardGating } from '../shell/gating'
import { CardIcon } from './CardIcon'

export interface ButtonGroupOption {
  readonly id: string
  readonly label: string
  /** `actions` mode: this one command is unavailable now (already on, busy). */
  readonly disabled?: boolean
  readonly glyph?: CardGlyph
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
  /**
   * `choice` (default): mutually exclusive chips, one pressed. `actions`: one
   * joined strip of commands, none pressed; `value` is ignored.
   */
  readonly mode?: 'choice' | 'actions'
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
  mode = 'choice',
}: ButtonGroupProps): ReactElement {
  const shell = useCardGating()
  const gating = actuates ? shell : { blocked: false, reason: null }
  const off = disabled === true || gating.blocked
  if (mode === 'actions') {
    return (
      <div
        role="group"
        aria-label={ariaLabel}
        data-testid={testId}
        className={cn(
          'inline-flex overflow-hidden rounded-md border border-border',
          gating.blocked && 'dc-gated',
        )}
      >
        {options.map((o) => (
          <Button
            key={o.id}
            type="button"
            variant="unstyled"
            disabled={off || o.disabled === true}
            title={gating.blocked ? (gating.reason ?? undefined) : undefined}
            onClick={() => onChange(o.id)}
            className="inline-flex items-center gap-1 whitespace-nowrap border-l border-border bg-surface px-2.5 py-1.5 text-xs text-foreground transition-colors first:border-l-0 hover:bg-surface-hover disabled:pointer-events-none disabled:opacity-45"
          >
            {o.glyph === undefined ? null : <CardIcon glyph={o.glyph} className="h-3 w-3" />}
            {o.label}
          </Button>
        ))}
      </div>
    )
  }
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
