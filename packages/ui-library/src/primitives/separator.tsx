import {
  type HTMLAttributes,
  forwardRef,
  type ForwardRefExoticComponent,
  type RefAttributes,
} from 'react'
import { cva } from 'class-variance-authority'
import { cn } from '../lib/cn'

const separatorVariants = cva('', {
  variants: {
    orientation: {
      horizontal: 'h-px w-full bg-border-subtle',
      vertical: 'w-px h-full bg-border-subtle',
    },
  },
  defaultVariants: {
    orientation: 'horizontal',
  },
})

export interface SeparatorProps extends HTMLAttributes<HTMLDivElement> {
  orientation?: 'horizontal' | 'vertical'
}

export const Separator: ForwardRefExoticComponent<SeparatorProps & RefAttributes<HTMLDivElement>> =
  forwardRef<HTMLDivElement, SeparatorProps>(({ className, orientation, ...props }, ref) => {
    return (
      <div
        ref={ref}
        role="separator"
        aria-orientation={orientation ?? 'horizontal'}
        className={cn(separatorVariants({ orientation }), className)}
        {...props}
      />
    )
  })

Separator.displayName = 'Separator'
