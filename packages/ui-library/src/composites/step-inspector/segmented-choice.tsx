/**
 * SegmentedChoice — a small, labelled single-choice group (a radiogroup of
 * buttons): which layer the inspector's settings edit ("All accelerators" /
 * "Only hub · NPU"). 36 px tall on a phone, 28 px from `md` up.
 */
import { cn } from '../../lib/cn'
import { type JSX } from 'react'

export interface SegmentedChoiceOption<T extends string> {
  readonly value: T
  readonly label: string
  /** Not pickable right now; `reason` is what the operator reads on hover. */
  readonly disabled?: boolean
  readonly reason?: string
}

export interface SegmentedChoiceProps<T extends string> {
  readonly label: string
  readonly options: readonly SegmentedChoiceOption<T>[]
  readonly value: T
  readonly onChange: (next: T) => void
}

export function SegmentedChoice<T extends string>({
  label,
  options,
  value,
  onChange,
}: SegmentedChoiceProps<T>): JSX.Element {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap items-center gap-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          disabled={option.disabled === true}
          title={option.disabled === true ? option.reason : undefined}
          onClick={() => onChange(option.value)}
          className={cn(
            'h-9 rounded-md border px-2.5 text-[11px] font-medium transition-colors md:h-7',
            value === option.value
              ? 'border-primary/50 bg-primary/15 text-primary'
              : 'border-border text-foreground-subtle hover:bg-surface-hover hover:text-foreground',
            option.disabled === true &&
              'cursor-not-allowed opacity-50 hover:bg-transparent hover:text-foreground-subtle',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
