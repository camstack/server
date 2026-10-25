import {
  type InputHTMLAttributes,
  forwardRef,
  type ForwardRefExoticComponent,
  type RefAttributes,
} from 'react'
import { cn } from '../lib/cn'

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {}

export const Checkbox: ForwardRefExoticComponent<CheckboxProps & RefAttributes<HTMLInputElement>> =
  forwardRef<HTMLInputElement, CheckboxProps>(({ className, ...props }, ref) => {
    return (
      <input
        ref={ref}
        type="checkbox"
        className={cn('w-3.5 h-3.5 rounded-sm border border-border accent-primary', className)}
        {...props}
      />
    )
  })

Checkbox.displayName = 'Checkbox'
