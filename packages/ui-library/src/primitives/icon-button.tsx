import {
  type ButtonHTMLAttributes,
  forwardRef,
  type ForwardRefExoticComponent,
  type RefAttributes,
} from 'react'
import { cva } from 'class-variance-authority'
import { type LucideIcon } from 'lucide-react'
import { cn } from '../lib/cn'

const iconButtonVariants = cva(
  'inline-flex items-center justify-center rounded-md font-medium transition-colors cursor-pointer disabled:opacity-50 disabled:pointer-events-none',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground hover:bg-primary/90',
        secondary: 'bg-surface text-foreground hover:bg-surface-hover',
        ghost: 'hover:bg-surface-hover text-foreground-muted',
        danger: 'bg-danger text-white hover:bg-danger/90',
        outline: 'border border-border bg-transparent hover:bg-surface-hover',
      },
      size: {
        sm: 'h-7 w-7',
        md: 'h-8 w-8',
        lg: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'sm',
    },
  },
)

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'
  size?: 'sm' | 'md' | 'lg'
  icon: LucideIcon
  'aria-label': string
}

export const IconButton: ForwardRefExoticComponent<
  IconButtonProps & RefAttributes<HTMLButtonElement>
> = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, variant, size, icon: Icon, ...props }, ref) => {
    return (
      <button ref={ref} className={cn(iconButtonVariants({ variant, size }), className)} {...props}>
        <Icon className="h-4 w-4" aria-hidden="true" />
      </button>
    )
  },
)

IconButton.displayName = 'IconButton'
