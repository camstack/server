import {
  type InputHTMLAttributes,
  forwardRef,
  type ForwardRefExoticComponent,
  type RefAttributes,
} from 'react'
import { cn } from '../lib/cn'

export interface SliderProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {}

/** A range slider (`min`, `max`, `step`, `value`, `onChange`). Carries an `aria-label` at the call site. */
export const Slider: ForwardRefExoticComponent<SliderProps & RefAttributes<HTMLInputElement>> =
  forwardRef<HTMLInputElement, SliderProps>(({ className, ...props }, ref) => (
    <input
      ref={ref}
      type="range"
      className={cn('accent-primary disabled:opacity-50 disabled:cursor-not-allowed', className)}
      {...props}
    />
  ))

Slider.displayName = 'Slider'
