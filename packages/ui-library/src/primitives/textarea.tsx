import {
  type TextareaHTMLAttributes,
  forwardRef,
  type ForwardRefExoticComponent,
  type RefAttributes,
} from 'react'
import { cn } from '../lib/cn'

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  state?: 'default' | 'error'
}

/** Multi-line text field, drawn like `Input` (same border, focus ring and disabled affordance). */
export const Textarea: ForwardRefExoticComponent<
  TextareaProps & RefAttributes<HTMLTextAreaElement>
> = forwardRef<HTMLTextAreaElement, TextareaProps>(({ className, state, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      'w-full px-2.5 py-1.5 text-xs bg-surface border rounded-md text-foreground placeholder:text-foreground-subtle focus:outline-none focus:ring-1 focus:ring-inset focus:ring-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
      state === 'error' ? 'border-danger' : 'border-border',
      className,
    )}
    {...props}
  />
))

Textarea.displayName = 'Textarea'
