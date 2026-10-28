import {
  type InputHTMLAttributes,
  type ReactNode,
  forwardRef,
  useCallback,
  useRef,
  type ForwardRefExoticComponent,
  type RefAttributes,
} from 'react'
import { cva } from 'class-variance-authority'
import { cn } from '../lib/cn'
import { useSearchFieldHotkey } from '../hotkeys/use-search-field-hotkey'

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
  /**
   * ⌘F / Ctrl+F and ⌘K / Ctrl+K focus this field instead of the browser's find.
   * On by default for `type="search"`; pass it for a search field of another type,
   * or `false` to opt out.
   */
  searchHotkey?: boolean
}

export const Input: ForwardRefExoticComponent<InputProps & RefAttributes<HTMLInputElement>> =
  forwardRef<HTMLInputElement, InputProps>(
    ({ className, state, leftSlot, rightSlot, searchHotkey, ...props }, ref) => {
      const innerRef = useRef<HTMLInputElement | null>(null)
      const setRef = useCallback(
        (node: HTMLInputElement | null) => {
          innerRef.current = node
          if (typeof ref === 'function') ref(node)
          else if (ref) ref.current = node
        },
        [ref],
      )
      useSearchFieldHotkey(innerRef, { enabled: searchHotkey ?? props.type === 'search' })
      if (leftSlot || rightSlot) {
        return (
          <div className={cn('relative flex items-center', className)}>
            {leftSlot && (
              <div className="absolute left-2.5 flex items-center text-foreground-subtle pointer-events-none">
                {leftSlot}
              </div>
            )}
            <input
              ref={setRef}
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

      return <input ref={setRef} className={cn(inputVariants({ state }), className)} {...props} />
    },
  )

Input.displayName = 'Input'
