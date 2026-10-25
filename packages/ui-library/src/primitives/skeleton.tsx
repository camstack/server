import {
  type HTMLAttributes,
  forwardRef,
  type ForwardRefExoticComponent,
  type RefAttributes,
} from 'react'
import { cn } from '../lib/cn'

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {}

export const Skeleton: ForwardRefExoticComponent<SkeletonProps & RefAttributes<HTMLDivElement>> =
  forwardRef<HTMLDivElement, SkeletonProps>(({ className, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn('animate-pulse bg-surface-hover rounded-md h-4 w-full', className)}
        {...props}
      />
    )
  })

Skeleton.displayName = 'Skeleton'
