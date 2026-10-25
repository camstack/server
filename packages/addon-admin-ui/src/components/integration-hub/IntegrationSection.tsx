/**
 * One section of an integration's body — a panel, Settings, Activity — with a
 * heading that is also its deep link.
 *
 * `?section=<id>` brings the section into view. The body above it may still be
 * loading when it mounts (a device table, a settings schema), which pushes it
 * down after the first scroll; so it scrolls once on mount and once more
 * shortly after, unless the operator has started scrolling himself in between —
 * a page that yanks the viewport back from under a reader is worse than one
 * that lands a little short.
 *
 * The small link glyph after the title is the section's address, for the
 * operator who wants to paste "Alexa → Settings" into a message.
 */
import { Link2, type LucideIcon } from 'lucide-react'
import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { SectionCard, TEXT_SECTION_LABEL } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'

/** How long after mount the second, layout-settled scroll happens. */
const SETTLE_SCROLL_MS = 600

export interface IntegrationSectionContextValue {
  /** The integration on screen (resets the scroll when it changes). */
  readonly integrationId: string
  /** The section the URL asked for. */
  readonly requestedSection: string | null
  /** The relative href that opens this integration at `section`. */
  readonly sectionHref: (section: string) => string
}

export const IntegrationSectionContext = createContext<IntegrationSectionContextValue | null>(null)

interface IntegrationSectionProps {
  /** The `?section=` value that targets this section. */
  readonly id: string
  readonly title: string
  readonly icon?: LucideIcon
  /** Controls at the right of the heading (a segmented toggle, a refresh). */
  readonly actions?: ReactNode
  /**
   * `card` draws the section card chrome around the body — for a body that has
   * no frame of its own (Activity). Default: a bare heading over the body, for
   * bodies that already draw their own cards (the settings form, a table), so
   * they are not boxed twice.
   */
  readonly framed?: boolean
  readonly children: ReactNode
}

export function IntegrationSection({
  id,
  title,
  icon: Icon,
  actions,
  framed = false,
  children,
}: IntegrationSectionProps): ReactNode {
  const { t } = useTranslation()
  const ctx = useContext(IntegrationSectionContext)
  const ref = useRef<HTMLDivElement>(null)
  const headingId = `integration-section-${id}`
  useScrollWhenRequested(ref, ctx, id)

  const link =
    ctx !== null ? (
      <Link
        to={ctx.sectionHref(id)}
        aria-label={t('integrationHub.integrationSection.linkTo', 'Link to {{title}}', { title })}
        title={t('integrationHub.integrationSection.linkTo', 'Link to {{title}}', { title })}
        className="rounded p-0.5 text-foreground-subtle/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <Link2 className="h-3 w-3" aria-hidden />
      </Link>
    ) : null
  const trailing = (
    <>
      {link}
      {actions}
    </>
  )

  if (framed) {
    return (
      <div ref={ref} className="scroll-mt-4">
        <SectionCard headingId={headingId} title={title} icon={Icon} actions={trailing}>
          {children}
        </SectionCard>
      </div>
    )
  }
  return (
    <section ref={ref} aria-labelledby={headingId} className="scroll-mt-4 space-y-2">
      <header className="flex min-h-7 flex-wrap items-center gap-2 px-0.5">
        {Icon !== undefined && (
          <Icon className="h-3.5 w-3.5 shrink-0 text-foreground-subtle" aria-hidden />
        )}
        <h2 id={headingId} className={`${TEXT_SECTION_LABEL} min-w-0 flex-1`}>
          {title}
        </h2>
        {trailing}
      </header>
      {children}
    </section>
  )
}

function useScrollWhenRequested(
  ref: React.RefObject<HTMLElement | null>,
  ctx: IntegrationSectionContextValue | null,
  id: string,
): void {
  const requested = ctx?.requestedSection === id
  const integrationId = ctx?.integrationId
  useEffect(() => {
    if (!requested) return undefined
    const scroll = (): void => ref.current?.scrollIntoView?.({ block: 'start' })
    scroll()
    let operatorScrolled = false
    const cancel = (): void => {
      operatorScrolled = true
    }
    const events = ['wheel', 'touchmove', 'keydown'] as const
    for (const e of events) window.addEventListener(e, cancel, { once: true, passive: true })
    const timer = window.setTimeout(() => {
      if (!operatorScrolled) scroll()
    }, SETTLE_SCROLL_MS)
    return () => {
      window.clearTimeout(timer)
      for (const e of events) window.removeEventListener(e, cancel)
    }
  }, [requested, integrationId, ref])
}
