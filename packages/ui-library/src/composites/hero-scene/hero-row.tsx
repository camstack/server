import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { Button } from '../../primitives/button'
import { TONE_CLASS, TONE_FILL } from './scene-map'
import type { SceneTone } from './types'

export interface HeroRowLineProps {
  /** The row's label at the left ("Phase", "Mode"). */
  readonly label: string
  /** The value in the middle: words, a progress bar or a segmented control. */
  readonly children?: ReactNode
  /** The actions at the right. */
  readonly actions?: ReactNode
  readonly testId?: string
  readonly className?: string
}

/**
 * One row of a layout A hero: `label | value | actions`, on a fixed grid so every
 * row of every device lines up. An empty value or action zone leaves no gap.
 */
export function HeroRowLine({
  label,
  children,
  actions,
  testId,
  className,
}: HeroRowLineProps): ReactNode {
  return (
    <div
      data-testid={testId ?? 'hero-row'}
      className={cn(
        'grid min-h-11 grid-cols-[5.5rem_minmax(3.5rem,1fr)_minmax(min-content,auto)] items-center gap-x-2 rounded-lg bg-surface-hover py-1.5 pl-3 pr-1.5 sm:grid-cols-[6.5rem_minmax(3.5rem,1fr)_minmax(min-content,auto)]',
        className,
      )}
    >
      <span className="text-xs text-foreground-muted">{label}</span>
      <div className="min-w-0 text-sm text-foreground">{children}</div>
      <div className="flex flex-wrap items-center justify-end gap-1.5">{actions}</div>
    </div>
  )
}

export interface HeroProgressBarProps {
  /** 0..1. */
  readonly value: number
  readonly label: string
  readonly tone?: SceneTone
  readonly className?: string
}

/** The progress bar of a cycle or a timer: the scene's tone fills it. */
export function HeroProgressBar({
  value,
  label,
  tone = 'primary',
  className,
}: HeroProgressBarProps): ReactNode {
  return (
    <progress
      aria-label={label}
      max={1}
      value={Math.min(1, Math.max(0, value))}
      className={cn(
        'block h-1.5 w-full appearance-none overflow-hidden rounded-full [&::-moz-progress-bar]:bg-current [&::-webkit-progress-bar]:bg-surface-hover [&::-webkit-progress-value]:bg-current',
        TONE_CLASS[tone],
        className,
      )}
    />
  )
}

export interface HeroSegmentedProps {
  readonly label: string
  readonly options: readonly { readonly value: string; readonly label: string }[]
  readonly value: string | null
  readonly disabled?: boolean
  readonly tone?: SceneTone
  readonly onChange: (value: string) => void
}

/** A segmented control: the options of a mode or a speed, one pressed. */
export function HeroSegmented({
  label,
  options,
  value,
  disabled,
  tone = 'primary',
  onChange,
}: HeroSegmentedProps): ReactNode {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex max-w-full flex-nowrap gap-0.5 overflow-x-auto rounded-lg border border-border bg-surface p-0.5"
    >
      {options.map((option) => {
        const pressed = option.value === value
        return (
          <Button
            key={option.value}
            variant="unstyled"
            aria-pressed={pressed}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              'h-8 shrink-0 rounded-md px-2.5 text-xs',
              pressed
                ? cn('font-semibold', TONE_FILL[tone])
                : 'text-foreground-muted hover:text-foreground',
            )}
          >
            {option.label}
          </Button>
        )
      })}
    </div>
  )
}
