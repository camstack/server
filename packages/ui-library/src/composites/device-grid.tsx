import { type ReactNode, type JSX } from 'react'
import { cn } from '../lib/cn'

export interface DeviceGridProps {
  /** Grid items */
  children: ReactNode
  /** Minimum card width in pixels (default 220) */
  minCardWidth?: number
  /** Gap between cards in Tailwind spacing units (default 3) */
  gap?: number
  /** Additional CSS classes */
  className?: string
}

export function DeviceGrid({
  children,
  minCardWidth = 220,
  gap = 3,
  className,
}: DeviceGridProps): JSX.Element {
  return (
    <div
      className={cn('p-4 overflow-y-auto flex-1 content-start', className)}
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fill, minmax(${minCardWidth}px, 1fr))`,
        gap: `${gap * 4}px`,
      }}
    >
      {children}
    </div>
  )
}
