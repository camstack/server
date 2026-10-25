import {
  type SelectHTMLAttributes,
  forwardRef,
  type ForwardRefExoticComponent,
  type RefAttributes,
} from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '../lib/cn'

export interface SelectOption {
  value: string
  label: string
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options: SelectOption[]
}

/**
 * A native `<select>` styled to match the rest of the field set.
 *
 * `appearance-none` plus an explicit `bg-surface` / `text-foreground` is what
 * makes it match — and it is also what USED to make a disabled one a lie. A
 * browser greys a disabled control by rendering its own background and text
 * colour; all three of those are overridden here, so a `disabled` dropdown
 * looked exactly like a live one and simply ignored the click. That is the
 * whole of the "the language selector does not open" report of 2026-08-15:
 * the AI section's switch was off, every control under it was correctly inert,
 * and nothing on screen said so.
 *
 * `disabled:` classes belong HERE and not on each call site: there are dozens
 * of `<Select disabled>` in this app and the one that gets forgotten is the one
 * that generates the ticket. Guarded by `disabled-affordance.test.tsx`.
 */
export const Select: ForwardRefExoticComponent<SelectProps & RefAttributes<HTMLSelectElement>> =
  forwardRef<HTMLSelectElement, SelectProps>(({ className, options, disabled, ...props }, ref) => {
    return (
      <div className="relative w-full">
        <select
          ref={ref}
          disabled={disabled}
          className={cn(
            'h-7 w-full px-2.5 text-xs bg-surface border border-border rounded-md text-foreground appearance-none pr-7 focus:outline-none focus:ring-1 focus:ring-primary',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            className,
          )}
          {...props}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {/* The chevron travels with the field: an arrow at full strength over a
            dimmed control reads as "this one is still clickable". */}
        <div
          className={cn(
            'absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-foreground-muted',
            disabled === true ? 'opacity-50' : '',
          )}
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </div>
      </div>
    )
  })

Select.displayName = 'Select'
