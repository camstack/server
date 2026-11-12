import { type ReactElement, type ReactNode, useState } from 'react'
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
  /** Every move, while the thumb travels. */
  readonly onChange?: (value: number) => void
  /** Once, where the thumb was let go: the value a command is sent with. */
  readonly onCommit?: (value: number) => void
  /** The value written on the thumb (vertical) or beside the track (horizontal); null hides it. */
  readonly valueLabel?: (value: number) => string | null
  readonly testId?: string
}

/** Thumb travel of the vertical track, in px: its height minus the thumb. */
const VERTICAL_TRAVEL_PX = 96

interface Draft {
  readonly shown: number
  readonly move: (value: number) => void
  readonly commit: () => void
}

/** The value under the thumb while it moves; committed once, on release. */
function useDraft({ value, onChange, onCommit }: CardSliderProps): Draft {
  const [draft, setDraft] = useState<number | null>(null)
  return {
    shown: draft ?? value,
    move: (next) => {
      setDraft(next)
      onChange?.(next)
    },
    commit: () => {
      if (draft === null) return
      setDraft(null)
      onCommit?.(draft)
    },
  }
}

function GatedSlider({
  vertical,
  props,
  draft,
}: {
  readonly vertical: boolean
  readonly props: CardSliderProps
  readonly draft: Draft
}): ReactElement {
  const gating = useCardGating()
  const { min, max, step = 1, ariaLabel, disabled, testId } = props
  return (
    <Slider
      aria-label={ariaLabel}
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      min={min}
      max={max}
      step={step}
      value={draft.shown}
      disabled={disabled === true || gating.blocked}
      title={gating.blocked ? (gating.reason ?? undefined) : undefined}
      data-testid={testId}
      onChange={(e) => draft.move(Number(e.currentTarget.value))}
      onPointerUp={draft.commit}
      onKeyUp={draft.commit}
      onBlur={draft.commit}
      className={cn(
        vertical ? 'h-28 w-6 [writing-mode:vertical-lr] [direction:rtl]' : 'w-full',
        gating.blocked && 'dc-gated',
      )}
    />
  )
}

const fraction = (value: number, min: number, max: number): number =>
  max === min ? 0 : Math.min(1, Math.max(0, (value - min) / (max - min)))

/** A level in the scene's bottom zone: its name, the track, the value. */
export function HorizontalSlider(
  props: CardSliderProps & { readonly label?: ReactNode },
): ReactElement {
  const draft = useDraft(props)
  const shownLabel = props.valueLabel?.(draft.shown) ?? null
  return (
    <label className="flex w-full max-w-72 items-center gap-2 text-xs text-foreground-muted">
      {props.label === undefined ? null : <span className="shrink-0">{props.label}</span>}
      <GatedSlider vertical={false} props={props} draft={draft} />
      {shownLabel === null ? null : (
        <output className="w-10 shrink-0 text-right font-semibold tabular-nums text-primary">
          {shownLabel}
        </output>
      )}
    </label>
  )
}

/** A level in one of the scene's side columns, its value riding on the thumb. */
export function VerticalSlider(props: CardSliderProps): ReactElement {
  const draft = useDraft(props)
  const shownLabel = props.valueLabel?.(draft.shown) ?? null
  const top = (1 - fraction(draft.shown, props.min, props.max)) * VERTICAL_TRAVEL_PX
  return (
    <div className="relative flex h-28 w-12 justify-center">
      <GatedSlider vertical props={props} draft={draft} />
      {shownLabel === null ? null : (
        <output
          className="pointer-events-none absolute left-9 whitespace-nowrap rounded-md bg-primary/10 px-1.5 text-xs font-semibold tabular-nums text-primary"
          style={{ top }} // ui-check-ok: computed geometry, the thumb's height on the track
        >
          {shownLabel}
        </output>
      )}
    </div>
  )
}
