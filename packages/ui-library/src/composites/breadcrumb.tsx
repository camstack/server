import React from 'react'
import { ChevronRight } from 'lucide-react'
import { type JSX } from 'react'

export interface BreadcrumbItem {
  /** Display label */
  label: string
  /** If provided, renders as a clickable link. Last item is never a link. */
  href?: string
  /** Click handler — used instead of href for SPA navigation */
  onClick?: () => void
}

export interface BreadcrumbProps {
  items: BreadcrumbItem[]
  className?: string
}

/**
 * Breadcrumb navigation component.
 *
 * Usage with react-router:
 * ```tsx
 * <Breadcrumb items={[
 *   { label: 'Integrations', onClick: () => navigate('/integrations') },
 *   { label: 'RTSP Cameras', onClick: () => navigate('/integrations/int_0001') },
 *   { label: 'Front Door' },
 * ]} />
 * ```
 */
export function Breadcrumb({ items, className }: BreadcrumbProps): JSX.Element {
  return (
    // Hidden below the `md` breakpoint: on phones the breadcrumb
    // duplicates the back-button context surfaced by the page header /
    // sidebar drawer and only consumes vertical space. Applied at the
    // component definition so every consumer inherits the behaviour
    // without a per-call-site wrapper. SSR-safe (CSS only, no
    // `useMediaQuery`).
    <nav
      className={`hidden md:flex items-center gap-1 text-[11px] text-foreground-subtle ${className ?? ''}`}
    >
      {items.map((item, i) => {
        const isLast = i === items.length - 1
        const isClickable = !isLast && (item.onClick || item.href)

        return (
          <React.Fragment key={i}>
            {i > 0 && <ChevronRight className="h-3 w-3 flex-shrink-0" />}
            {isClickable ? (
              item.onClick ? (
                <button
                  type="button"
                  onClick={item.onClick}
                  className="hover:text-foreground transition-colors"
                >
                  {item.label}
                </button>
              ) : (
                <a href={item.href} className="hover:text-foreground transition-colors">
                  {item.label}
                </a>
              )
            ) : (
              <span className={isLast ? 'text-foreground font-medium' : ''}>{item.label}</span>
            )}
          </React.Fragment>
        )
      })}
    </nav>
  )
}
