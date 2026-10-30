/**
 * DisclosureChevron — the expand / collapse marker of a disclosure header.
 *
 * One glyph for every collapsible region (accordion sections, picker groups,
 * log toggles): a lucide ChevronRight (collapsed) / ChevronDown (expanded) at
 * `h-4 w-4`, the same marker `CollapsibleCard` draws. A text glyph (▸ / ▾) at
 * `text-xs` was too small to read as a control and is refused by
 * `scripts/check-no-glyph-chevrons.ts`.
 *
 * Decorative: the clickable header owns the semantics (`<button
 * aria-expanded>`), so the icon is `aria-hidden`.
 */
import { type JSX } from 'react'
import { ChevronRight, ChevronDown } from 'lucide-react'
import { cn } from '../lib/cn'

export interface DisclosureChevronProps {
  readonly expanded: boolean
  readonly className?: string
}

export function DisclosureChevron({ expanded, className }: DisclosureChevronProps): JSX.Element {
  const Icon = expanded ? ChevronDown : ChevronRight
  return (
    <Icon aria-hidden="true" className={cn('h-4 w-4 shrink-0 text-foreground-subtle', className)} />
  )
}
