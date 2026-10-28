/**
 * One titled block of the Integrations page: `Providers` or `System`. Both the
 * grid and the table view put their rows inside one, so the two views split the
 * list the same way. A block with no rows is not rendered by the caller.
 */
import { type ReactElement, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { TEXT_SECTION_LABEL } from '@camstack/ui-library'

export type IntegrationSectionKind = 'providers' | 'system'

export interface IntegrationSectionProps {
  readonly kind: IntegrationSectionKind
  readonly children: ReactNode
}

export function IntegrationSection({ kind, children }: IntegrationSectionProps): ReactElement {
  const { t } = useTranslation()
  const headingId = `integrations-section-${kind}`
  const title =
    kind === 'providers'
      ? t('integrations.sections.providers', 'Providers')
      : t('integrations.sections.system', 'System')
  return (
    <section aria-labelledby={headingId} data-testid={headingId} className="min-w-0 space-y-2">
      <h2 id={headingId} className={TEXT_SECTION_LABEL}>
        {title}
      </h2>
      {children}
    </section>
  )
}
