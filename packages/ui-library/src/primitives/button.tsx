import {
  type ButtonHTMLAttributes,
  forwardRef,
  type ForwardRefExoticComponent,
  type RefAttributes,
} from 'react'
import { cva } from 'class-variance-authority'
import { cn } from '../lib/cn'

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-md font-medium transition-colors cursor-pointer disabled:opacity-50 disabled:pointer-events-none',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary: 'bg-surface text-foreground hover:bg-surface-hover',
        ghost: 'hover:bg-surface-hover text-foreground-muted',
        danger: 'bg-danger text-white hover:bg-danger/90',
        // `text-foreground` is NOT optional: without it the variant inherits
        // whatever an ancestor happens to define, which on a light surface is
        // the UA default (white) — the label lays out and is invisible.
        outline: 'border border-border bg-transparent text-foreground hover:bg-surface-hover',
      },
      size: {
        sm: 'h-7 px-2.5 text-xs gap-1.5',
        md: 'h-8 px-3 text-sm gap-2',
        lg: 'h-9 px-4 text-sm gap-2',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'sm',
    },
  },
)

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'
  size?: 'sm' | 'md' | 'lg'
}

export const Button: ForwardRefExoticComponent<ButtonProps & RefAttributes<HTMLButtonElement>> =
  forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, ...props }, ref) => {
    return (
      <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
    )
  })

Button.displayName = 'Button'
