import {
  type ButtonHTMLAttributes,
  forwardRef,
  type ForwardRefExoticComponent,
  type RefAttributes,
} from 'react'
import { cn } from '../lib/cn'

export interface SwitchProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label?: string
}

export const Switch: ForwardRefExoticComponent<SwitchProps & RefAttributes<HTMLButtonElement>> =
  forwardRef<HTMLButtonElement, SwitchProps>(
    ({ className, checked, onCheckedChange, label, ...props }, ref) => {
      return (
        <button
          ref={ref}
          role="switch"
          aria-checked={checked}
          type="button"
          onClick={() => onCheckedChange(!checked)}
          className={cn('inline-flex items-center gap-2', className)}
          {...props}
        >
          <span
            className={cn(
              'w-8 h-4 rounded-full transition-colors',
              checked ? 'bg-primary' : 'bg-surface-hover',
            )}
          >
            <span
              className={cn(
                'block w-3.5 h-3.5 rounded-full bg-white transition-transform',
                checked ? 'translate-x-4' : 'translate-x-0.5',
              )}
            />
          </span>
          {label && <span className="text-xs text-foreground">{label}</span>}
        </button>
      )
    },
  )

Switch.displayName = 'Switch'
