/**
 * SectionCard — the app's section card: `SECTION_CARD` chrome, a
 * `SECTION_HEADER` strip with an uppercase `TEXT_SECTION_LABEL` heading, an
 * optional icon and right-aligned header actions. The body is the caller's
 * (pad it with `SECTION_BODY` or render a divided list / table edge to edge).
 * One card component for every settings-style page (device Customize, Pipeline
 * Load balancing) instead of a per-page copy. Owns no data.
 */
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { SECTION_CARD, SECTION_HEADER, TEXT_SECTION_LABEL } from '../lib/responsive'

export interface SectionCardProps {
  /** The heading's DOM id; the section is labelled by it. */
  readonly headingId: string
  readonly title: string
  readonly icon?: LucideIcon
  /** Controls at the right of the header (a switch, "+ Add"). */
  readonly actions?: ReactNode
  readonly testId?: string
  readonly children: ReactNode
}

export function SectionCard({
  headingId,
  title,
  icon: Icon,
  actions,
  testId,
  children,
}: SectionCardProps): ReactNode {
  return (
    <section aria-labelledby={headingId} className={SECTION_CARD} data-testid={testId}>
      <header className={`${SECTION_HEADER} flex min-h-9 flex-wrap items-center gap-2`}>
        {Icon !== undefined && (
          <Icon className="h-3.5 w-3.5 shrink-0 text-foreground-subtle" aria-hidden />
        )}
        <h2 id={headingId} className={`${TEXT_SECTION_LABEL} min-w-0 flex-1`}>
          {title}
        </h2>
        {actions}
      </header>
      {children}
    </section>
  )
}
