import type { ReactElement } from 'react'
import { cn } from '../../../lib/cn'
import { Slider } from '../../../primitives/slider'
import { useCardGating } from '../shell/gating'

export interface CardSliderProps {
  readonly value: number
  readonly min: number
  readonly max: number
  readonly step?: number
  readonly ariaLabel: string
  readonly disabled?: boolean
  readonly onChange: (value: number) => void
  readonly testId?: string
}

function GatedSlider({
  vertical,
  value,
  min,
  max,
  step = 1,
  ariaLabel,
  disabled,
  onChange,
  testId,
}: CardSliderProps & { readonly vertical: boolean }): ReactElement {
  const gating = useCardGating()
  return (
    <Slider
      aria-label={ariaLabel}
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled === true || gating.blocked}
      title={gating.blocked ? (gating.reason ?? undefined) : undefined}
      data-testid={testId}
      onChange={(e) => onChange(Number(e.currentTarget.value))}
      className={cn(
        vertical ? 'h-28 w-6 [writing-mode:vertical-lr] [direction:rtl]' : 'w-full max-w-64',
        gating.blocked && 'dc-gated',
      )}
    />
  )
}

/** A level in the scene's bottom zone. */
export function HorizontalSlider(props: CardSliderProps): ReactElement {
  return <GatedSlider {...props} vertical={false} />
}

/** A level in one of the scene's side columns. */
export function VerticalSlider(props: CardSliderProps): ReactElement {
  return <GatedSlider {...props} vertical />
}
