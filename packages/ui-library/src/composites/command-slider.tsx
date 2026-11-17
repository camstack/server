/**
 * CommandSlider — a range input that sends a device command once, on release.
 *
 * It renders the served value, except during the gesture and its trailing
 * commit, where the thumb stays under the hand (`useDragValue`). Use it for any
 * slider that sends a command: a slider that sends on every move and renders
 * the served value snaps back while it is dragged.
 */
import type { ReactElement, ReactNode } from 'react'
import { useDragValue } from '../hooks/use-drag-value'
import { Slider, type SliderProps } from '../primitives/slider'

export interface CommandSliderProps
  extends Omit<
    SliderProps,
    'value' | 'defaultValue' | 'onChange' | 'onPointerUp' | 'onPointerCancel' | 'onKeyUp' | 'onBlur'
  > {
  /** The value the hub serves. */
  readonly value: number
  /** Sends the command with the released value. */
  readonly onCommit: (value: number) => void
  /** Drawn after the track with the value the thumb shows (the "45%" beside it). */
  readonly valueLabel?: (shown: number) => ReactNode
  readonly settleMs?: number
}

export function CommandSlider({
  value,
  onCommit,
  valueLabel,
  settleMs,
  ...rest
}: CommandSliderProps): ReactElement {
  const drag = useDragValue({ served: value, onCommit, settleMs })
  return (
    <>
      <Slider {...rest} {...drag.sliderProps} />
      {valueLabel?.(drag.shown)}
    </>
  )
}
