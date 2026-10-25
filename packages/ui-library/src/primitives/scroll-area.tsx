import {
  type HTMLAttributes,
  forwardRef,
  type ForwardRefExoticComponent,
  type RefAttributes,
} from 'react'
import { cn } from '../lib/cn'

export interface ScrollAreaProps extends HTMLAttributes<HTMLDivElement> {}

export const ScrollArea: ForwardRefExoticComponent<
  ScrollAreaProps & RefAttributes<HTMLDivElement>
> = forwardRef<HTMLDivElement, ScrollAreaProps>(({ className, ...props }, ref) => {
  return (
    <div
      ref={ref}
      className={cn(
        'overflow-auto [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-surface-hover [&::-webkit-scrollbar-thumb]:rounded-full',
        className,
      )}
      {...props}
    />
  )
})

ScrollArea.displayName = 'ScrollArea'
