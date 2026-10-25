/**
 * Shared low-level primitives used across the Overview-tab adapters.
 *
 * Every primitive composes its layout from `@camstack/ui-library`'s
 * responsive tokens (`SECTION_*`, `TEXT_*`, `LIST_ROW`, …) — see
 * `packages/ui-library/src/lib/responsive.ts` for the three-tier
 * convention. Tweaking the token in one place updates every adapter
 * uniformly.
 *
 * Tier recap (matches `responsive.ts`):
 *   • L1 (<640px) — single column, smallest text, tight padding
 *   • L2 (sm 640–1023px) — 2-col grids, normal padding
 *   • L3 (lg+ ≥1024px) — 4-col grids, generous padding
 */
import type { ReactNode } from 'react'
import { LIST_ROW, TEXT_HINT } from '@camstack/ui-library'

export interface MiniStatProps {
  readonly label: string
  readonly value: string
  readonly warning?: boolean
}

export function MiniStat({ label, value, warning }: MiniStatProps) {
  return (
    <div className="min-w-0">
      <p className={`${TEXT_HINT} truncate`}>{label}</p>
      <p
        className={`text-[11px] font-medium truncate ${warning ? 'text-warning' : 'text-foreground'}`}
      >
        {value}
      </p>
    </div>
  )
}

export interface InfoRowProps {
  readonly label: string
  readonly value: ReactNode
  /**
   * `inline` (default) — label left, value right: the Overview Device Info
   * card. `stacked` — label above value: grid cells (Customize IdentityRow)
   * where the inline layout collapses into a header-looking strip.
   */
  readonly layout?: 'inline' | 'stacked'
}

export function InfoRow({ label, value, layout = 'inline' }: InfoRowProps) {
  if (layout === 'stacked') {
    return (
      <div className="min-w-0 flex flex-col gap-0.5 px-0.5">
        <span className="text-[11px] text-foreground-subtle">{label}</span>
        <div className="min-w-0 text-[11px] text-foreground">{value}</div>
      </div>
    )
  }
  return (
    <div className={`${LIST_ROW} flex items-start gap-2 sm:gap-3`}>
      <span className="w-20 sm:w-28 flex-shrink-0 text-[11px] text-foreground-subtle">{label}</span>
      <div className="flex-1 min-w-0 text-[11px] text-foreground">{value}</div>
    </div>
  )
}
