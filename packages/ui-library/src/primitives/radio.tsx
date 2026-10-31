import {
  type InputHTMLAttributes,
  forwardRef,
  type ForwardRefExoticComponent,
  type RefAttributes,
} from 'react'
import { cn } from '../lib/cn'

export interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {}

/** One radio button; group them with a shared `name`. */
export const Radio: ForwardRefExoticComponent<RadioProps & RefAttributes<HTMLInputElement>> =
  forwardRef<HTMLInputElement, RadioProps>(({ className, ...props }, ref) => (
    <input
      ref={ref}
      type="radio"
      className={cn('accent-primary disabled:opacity-50 disabled:cursor-not-allowed', className)}
      {...props}
    />
  ))

Radio.displayName = 'Radio'
