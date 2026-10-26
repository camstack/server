/**
 * ViewSwitch — a segmented table | grid (or any two-or-more) choice.
 *
 * The parent owns `value` and `onChange`. A control with one option is not
 * rendered. It remembers nothing: the page stores the choice.
 */
import { type JSX } from 'react'
import { type LucideIcon } from 'lucide-react'
import { cn } from '../lib/cn'

export interface ViewSwitchOption<T extends string> {
  readonly id: T
  readonly label: string
  readonly icon?: LucideIcon
}

export interface ViewSwitchProps<T extends string> {
  readonly options: readonly ViewSwitchOption<T>[]
  readonly value: T
  readonly onChange: (id: T) => void
  /** Names the group for assistive tech ("Layout"). */
  readonly ariaLabel: string
  readonly className?: string
  /** Prefix for `data-testid` on the group (`${testId}`) and each option (`${testId}-${id}`). */
  readonly testId?: string
}

export function ViewSwitch<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
  testId,
}: ViewSwitchProps<T>): JSX.Element | null {
  if (options.length < 2) return null
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      data-testid={testId}
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-background p-0.5',
        className,
      )}
    >
      {options.map((option) => {
        const active = value === option.id
        const Icon = option.icon
        return (
          <button // ui-check-ok: segmented view switch; Button padding fights the segment
            key={option.id}
            type="button"
            role="radio"
            aria-checked={active}
            data-testid={testId === undefined ? undefined : `${testId}-${option.id}`}
            onClick={() => onChange(option.id)}
            className={cn(
              'inline-flex h-7 items-center gap-1 whitespace-nowrap rounded px-2 text-xs font-medium transition-colors',
              active
                ? 'bg-primary/10 text-primary'
                : 'text-foreground-subtle hover:bg-surface-hover hover:text-foreground',
            )}
          >
            {Icon !== undefined ? <Icon className="h-3.5 w-3.5" aria-hidden /> : null}
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
