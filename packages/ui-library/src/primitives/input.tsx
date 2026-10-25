import {
  type InputHTMLAttributes,
  type ReactNode,
  forwardRef,
  type ForwardRefExoticComponent,
  type RefAttributes,
} from 'react'
import { cva } from 'class-variance-authority'
import { cn } from '../lib/cn'

/**
 * `disabled:opacity-50 disabled:cursor-not-allowed` for the same reason as
 * `Select` — an explicit `bg-surface` / `text-foreground` overrides the greying
 * a browser would otherwise apply, leaving an inert field indistinguishable
 * from a live one. See `disabled-affordance.test.tsx`.
 */
const inputVariants = cva(
  'h-7 w-full px-2.5 text-xs bg-surface border rounded-md text-foreground placeholder:text-foreground-subtle focus:outline-none focus:ring-1 focus:ring-inset focus:ring-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
  {
    variants: {
      state: {
        default: 'border-border',
        error: 'border-danger',
      },
    },
    defaultVariants: {
      state: 'default',
    },
  },
)

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  state?: 'default' | 'error'
  leftSlot?: ReactNode
  rightSlot?: ReactNode
}

export const Input: ForwardRefExoticComponent<InputProps & RefAttributes<HTMLInputElement>> =
  forwardRef<HTMLInputElement, InputProps>(
    ({ className, state, leftSlot, rightSlot, ...props }, ref) => {
      if (leftSlot || rightSlot) {
        return (
          <div className={cn('relative flex items-center', className)}>
            {leftSlot && (
              <div className="absolute left-2.5 flex items-center text-foreground-subtle pointer-events-none">
                {leftSlot}
              </div>
            )}
            <input
              ref={ref}
              className={cn(
                inputVariants({ state }),
                leftSlot && 'pl-8',
                rightSlot && 'pr-8',
                className,
              )}
              {...props}
            />
            {rightSlot && (
              <div className="absolute right-2.5 flex items-center text-foreground-subtle">
                {rightSlot}
              </div>
            )}
          </div>
        )
      }

      return <input ref={ref} className={cn(inputVariants({ state }), className)} {...props} />
    },
  )

Input.displayName = 'Input'
