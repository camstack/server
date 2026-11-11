import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

export interface HeroCardAProps {
  readonly title: string
  /**
   * Draw the title in the top row. Default true; a host whose own header
   * already names the device (the viewer's device screen) passes false, and the
   * top row keeps only the chips.
   */
  readonly showTitle?: boolean
  /** Inline chips next to the title (brand, power, state). Never wrap: the row clips. */
  readonly chips?: ReactNode
  /** The HeroScene. */
  readonly scene: ReactNode
  /** Controls / facts under the scene. */
  readonly rows?: ReactNode
  /** Foot, left: consumable chips. */
  readonly footChips?: ReactNode
  /** Foot, right: the history action. */
  readonly footAction?: ReactNode
  /** The utility section: a divided block at the very bottom of the card (`HeroUtilityGrid`). */
  readonly utility?: ReactNode
  readonly className?: string
}

/**
 * Layout A hero shell: one-line top row, scene, rows slot, foot. The top row is
 * `nowrap` — the title ellipsises, the chips stay whole and the overflow clips;
 * it is never two lines.
 */
export function HeroCardA({
  title,
  showTitle = true,
  chips,
  scene,
  rows,
  footChips,
  footAction,
  utility,
  className,
}: HeroCardAProps): ReactNode {
  const hasFoot = footChips !== undefined || footAction !== undefined
  const hasTop = showTitle || chips !== undefined
  return (
    <section
      data-testid="hero-card-a"
      className={cn(
        'flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4',
        className,
      )}
    >
      {hasTop ? (
        <div
          data-testid="hero-card-top"
          className={cn(
            'flex min-w-0 flex-nowrap items-center gap-1.5 overflow-hidden whitespace-nowrap',
            !showTitle && 'justify-end',
          )}
        >
          {showTitle ? (
            <h3 className="min-w-0 flex-1 truncate text-base font-semibold text-foreground">
              {title}
            </h3>
          ) : null}
          {chips !== undefined ? (
            <div className="flex shrink-0 flex-nowrap items-center gap-1.5">{chips}</div>
          ) : null}
        </div>
      ) : null}
      {scene}
      {rows !== undefined ? <div className="flex flex-col gap-2">{rows}</div> : null}
      {hasFoot ? (
        <div
          data-testid="hero-card-foot"
          className="flex min-w-0 flex-nowrap items-center gap-1.5 overflow-hidden"
        >
          <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-hidden">
            {footChips}
          </div>
          {footAction !== undefined ? <div className="shrink-0">{footAction}</div> : null}
        </div>
      ) : null}
      {utility !== undefined ? (
        <div data-testid="hero-card-utility" className="border-t border-border pt-3">
          {utility}
        </div>
      ) : null}
    </section>
  )
}
