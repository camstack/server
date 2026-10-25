import {
  type LabelHTMLAttributes,
  forwardRef,
  type ForwardRefExoticComponent,
  type RefAttributes,
} from 'react'
import { cn } from '../lib/cn'

export interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {}

export const Label: ForwardRefExoticComponent<LabelProps & RefAttributes<HTMLLabelElement>> =
  forwardRef<HTMLLabelElement, LabelProps>(({ className, ...props }, ref) => {
    return (
      <label
        ref={ref}
        className={cn(
          'text-[10px] uppercase tracking-wider text-foreground-muted font-medium',
          className,
        )}
        {...props}
      />
    )
  })

Label.displayName = 'Label'
