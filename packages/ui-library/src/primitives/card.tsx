import {
  type HTMLAttributes,
  forwardRef,
  type ForwardRefExoticComponent,
  type RefAttributes,
} from 'react'
import { cva } from 'class-variance-authority'
import { cn } from '../lib/cn'

const cardVariants = cva('rounded-lg p-3', {
  variants: {
    variant: {
      flat: 'bg-surface',
      bordered: 'bg-surface border border-border',
    },
  },
  defaultVariants: {
    variant: 'bordered',
  },
})

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?: 'flat' | 'bordered'
}

export const Card: ForwardRefExoticComponent<CardProps & RefAttributes<HTMLDivElement>> =
  forwardRef<HTMLDivElement, CardProps>(({ className, variant, ...props }, ref) => {
    return <div ref={ref} className={cn(cardVariants({ variant }), className)} {...props} />
  })

Card.displayName = 'Card'
