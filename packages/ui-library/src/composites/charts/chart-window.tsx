/**
 * The window toggle every chart of the family uses: a small segmented control
 * of presets. Pure display — the parent owns `value` and `onChange`. A control
 * with one option is not rendered.
 */
import { type JSX } from 'react'
import { cn } from '../../lib/cn'

export interface ChartWindowOption<TId extends string> {
  readonly id: TId
  readonly label: string
}

export interface ChartWindowToggleProps<TId extends string> {
  readonly options: readonly ChartWindowOption<TId>[]
  readonly value: TId
  readonly onChange: (id: TId) => void
  /** Names the group for assistive tech ("Time window"). */
  readonly ariaLabel: string
  readonly className?: string
}

export function ChartWindowToggle<TId extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
}: ChartWindowToggleProps<TId>): JSX.Element | null {
  if (options.length < 2) return null
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex items-center gap-0.5 border border-border rounded-md p-0.5 bg-background',
        className,
      )}
    >
      {options.map(({ id, label }) => {
        const active = value === id
        return (
          <button // ui-check-ok: the library's segmented window toggle; Button sizes fight the 10px segment
            key={id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(id)}
            className={cn(
              'px-2 py-0.5 rounded text-[10px] font-medium transition-colors',
              active
                ? 'bg-primary/10 text-primary'
                : 'text-foreground-subtle hover:text-foreground',
            )}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}
