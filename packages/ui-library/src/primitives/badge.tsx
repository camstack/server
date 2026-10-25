import {
  type HTMLAttributes,
  type ReactNode,
  forwardRef,
  type ForwardRefExoticComponent,
  type RefAttributes,
} from 'react'
import { cva } from 'class-variance-authority'
import { cn } from '../lib/cn'

/**
 * Three looks, one palette:
 * - `solid`   — the legacy ~15% tint (reads weak over photos; kept for existing callers);
 * - `fill`    — an opaque `*-fill` background with its `*-on` text (WCAG AA, both themes);
 * - `outline` — a border over a transparent background.
 */
const badgeVariants = cva(
  'inline-flex items-center rounded-full font-medium [&>svg]:shrink-0 [&>svg]:size-3',
  {
    variants: {
      variant: {
        default: 'bg-surface-hover text-foreground',
        success: 'bg-success/15 text-success',
        warning: 'bg-warning/15 text-warning',
        danger: 'bg-danger/15 text-danger',
        info: 'bg-info/15 text-info',
        primary: 'bg-primary/15 text-primary',
        neutral: 'bg-surface-hover text-foreground-muted',
      },
      styleVariant: {
        solid: '',
        fill: '',
        outline: 'border bg-transparent',
      },
      size: {
        sm: 'text-[10px] leading-4 px-1.5 py-0',
        md: 'text-xs px-2 py-0.5',
      },
      hasIcon: {
        true: 'gap-1',
        false: '',
      },
      dashed: {
        true: 'border-dashed',
        false: '',
      },
    },
    compoundVariants: [
      {
        variant: 'default',
        styleVariant: 'fill',
        class: 'bg-neutral-fill text-neutral-on',
      },
      {
        variant: 'neutral',
        styleVariant: 'fill',
        class: 'bg-neutral-fill text-neutral-on',
      },
      {
        variant: 'success',
        styleVariant: 'fill',
        class: 'bg-success-fill text-success-on',
      },
      {
        variant: 'warning',
        styleVariant: 'fill',
        class: 'bg-warning-fill text-warning-on',
      },
      {
        variant: 'danger',
        styleVariant: 'fill',
        class: 'bg-danger-fill text-danger-on',
      },
      {
        variant: 'info',
        styleVariant: 'fill',
        class: 'bg-info-fill text-info-on',
      },
      {
        variant: 'primary',
        styleVariant: 'fill',
        class: 'bg-primary-fill text-primary-on',
      },
    ],
    defaultVariants: {
      variant: 'default',
      styleVariant: 'solid',
      size: 'md',
      hasIcon: false,
      dashed: false,
    },
  },
)

export type BadgeVariant =
  | 'default'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'primary'
  | 'neutral'
export type BadgeStyle = 'solid' | 'fill' | 'outline'
export type BadgeSize = 'sm' | 'md'

export interface BadgeProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'style'> {
  variant?: BadgeVariant
  /** `solid` (default, a light tint), `fill` (opaque, AA text) or `outline`. */
  style?: BadgeStyle
  size?: BadgeSize
  /** A leading 12 px glyph; a badge never carries meaning by colour alone. */
  icon?: ReactNode
  /** Dashed border (outline only) — a hint for "approximate" / provisional. */
  dashed?: boolean
}

export const Badge: ForwardRefExoticComponent<BadgeProps & RefAttributes<HTMLSpanElement>> =
  forwardRef<HTMLSpanElement, BadgeProps>(
    ({ className, variant, style, size, icon, dashed, children, ...props }, ref) => {
      return (
        <span
          ref={ref}
          className={cn(
            badgeVariants({
              variant,
              styleVariant: style,
              size,
              hasIcon: icon !== undefined && icon !== null,
              dashed: dashed === true && style === 'outline',
            }),
            className,
          )}
          {...props}
        >
          {icon}
          {children}
        </span>
      )
    },
  )

Badge.displayName = 'Badge'
