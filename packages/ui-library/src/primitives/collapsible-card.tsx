/**
 * CollapsibleCard — neutral card with a clickable header + optional
 * expanded body. Same visual language as `FormBuilder` sections so
 * every settings-style container in the app shares one style
 * (`rounded-lg border border-border bg-surface`, no shadow, no
 * coloured left accent).
 *
 * Used by `PipelineStep`; reusable for any "click to expand" settings
 * row where we want FormBuilder-matching chrome.
 */
import { type ReactNode, type JSX } from 'react'
import { ChevronRight, ChevronDown } from 'lucide-react'
import { cn } from '../lib/cn'

export interface CollapsibleCardProps {
  readonly expanded: boolean
  readonly onExpandedChange: (next: boolean) => void
  /** Rendered inside the clickable header row, to the right of the chevron. */
  readonly header: ReactNode
  /** Expanded body — rendered below a subtle divider when `expanded === true`. */
  readonly children?: ReactNode
  /** Dims the entire card — for steps flagged as disabled/inactive. */
  readonly dimmed?: boolean
  /** Hide the chevron (header still click-toggles). Useful for always-expanded views. */
  readonly hideChevron?: boolean
  readonly className?: string
}

export function CollapsibleCard({
  expanded,
  onExpandedChange,
  header,
  children,
  dimmed = false,
  hideChevron = false,
  className,
}: CollapsibleCardProps): JSX.Element {
  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-surface overflow-hidden',
        dimmed && 'opacity-[0.45]',
        className,
      )}
    >
      <div
        role="button"
        tabIndex={0}
        className="flex items-center gap-2.5 px-3 py-2.5 cursor-pointer select-none"
        onClick={() => onExpandedChange(!expanded)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onExpandedChange(!expanded)
          }
        }}
      >
        {!hideChevron && (
          <span className="text-foreground-subtle shrink-0">
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </span>
        )}
        {header}
      </div>
      {expanded && children && <div className="border-t border-border px-3 py-3">{children}</div>}
    </div>
  )
}
