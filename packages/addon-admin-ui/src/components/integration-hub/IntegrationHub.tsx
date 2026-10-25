/**
 * `<IntegrationHub>` — the ONE base for a page that lists the integrations of a
 * kind and shows one at a time: Connectivity (device export, email, message
 * brokers), Network → Remote Access / Mesh Networks / TURN Servers, Identity →
 * Authentication, Logs → Destinations.
 *
 *   ┌ AdminPage header ──────────────────────────────────────────────┐
 *   │ ⚲ Title                                                          │
 *   │   subtitle                                                       │
 *   │ [◉ Alexa] [◉ HomeKit] [◉ Home Assistant] [+ Add export]          │  ← pills
 *   ├──────────────────────────────────────────────────────────────────┤
 *   │ the selected integration's body                                  │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * It replaced an accordion table (one collapsible row per addon, every body
 * stacked under its row). The operator asked for the app's usual page header
 * with the integrations as icon + name pills and the content switching below —
 * one integration on screen, its address in the URL (D774).
 *
 * What it owns: the header, the pills, which integration is on screen
 * (`?integration=`), the "that link named something not installed" notice, and
 * the loading / empty states. What a page owns: its groups and each entry's
 * body — usually `<AddonIntegrationBody>`.
 *
 * Loading is checked before emptiness and never collapses into it (D315): an
 * unanswered list is "Loading…", not "nothing installed".
 */
import { AlertTriangle, Plus, type LucideIcon } from 'lucide-react'
import { useMemo, type ReactElement, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Button, Card, EmptyState } from '@camstack/ui-library'

import { addonCatalogHref } from '../../lib/integration-hub-url'
import { useIntegrationSelection } from '../../hooks/useIntegrationSelection'
import { AdminPage } from '../AdminPage'
import { IntegrationPills } from './IntegrationPills'
import { IntegrationSectionContext } from './IntegrationSection'
import type { IntegrationGroup } from './types'
import { Trans, useTranslation } from 'react-i18next'

export interface IntegrationHubProps {
  readonly icon: LucideIcon
  readonly title: string
  readonly subtitle: ReactNode
  readonly groups: readonly IntegrationGroup[]
  /** True until every list the groups come from has answered. */
  readonly isLoading: boolean
  /** Copy for an answered page with nothing installed in any group. */
  readonly emptyTitle: string
  readonly emptyDescription: string
  /**
   * A pre-hub query param that named a GROUP (Connectivity's `?tab=<kind>`).
   * Honoured on arrival, dropped once an integration is chosen.
   */
  readonly legacyGroupParam?: string
  /** Extra content after the body (TURN's combined ICE list). */
  readonly trailing?: ReactNode
  /**
   * Under a `SectionedPage`: no second page title — only integration pills +
   * body (the parent shell already owns icon/title).
   */
  readonly embedded?: boolean
}

export function IntegrationHub({
  icon,
  title,
  subtitle,
  groups,
  isLoading,
  emptyTitle,
  emptyDescription,
  legacyGroupParam,
  trailing,
  embedded = false,
}: IntegrationHubProps): ReactElement {
  const { t } = useTranslation()
  const entries = useMemo(() => groups.flatMap((g) => g.entries), [groups])
  const ids = useMemo(() => entries.map((e) => e.id), [entries])
  const groupFirst = useMemo(() => {
    const out: Record<string, string> = {}
    for (const g of groups) {
      const first = g.entries[0]
      if (first !== undefined) out[g.id] = first.id
    }
    return out
  }, [groups])

  const selection = useIntegrationSelection({
    ids,
    answered: !isLoading,
    legacyGroupParam: legacyGroupParam ?? null,
    groupFirst,
  })
  const selected = entries.find((e) => e.id === selection.selectedId) ?? null

  const sectionContext = useMemo(
    () =>
      selected === null
        ? null
        : {
            integrationId: selected.id,
            requestedSection: selection.requestedSection,
            sectionHref: (section: string) => selection.hrefFor(selected.id, section),
          },
    [selected, selection],
  )

  const nav = isLoading ? null : (
    <IntegrationPills
      label={t('integrationHub.integrationHub.integrations', '{{title}} integrations', { title })}
      groups={groups}
      selectedId={selection.selectedId}
      hrefFor={(id) => selection.hrefFor(id)}
    />
  )

  const body = isLoading ? (
    <Card>
      <div className="p-6 text-sm text-foreground-subtle">{t('common.loading', 'Loading…')}</div>
    </Card>
  ) : (
    <>
      {selection.staleId !== null && (
        <StaleIntegrationNotice staleId={selection.staleId} shownName={selected?.name ?? null} />
      )}
      {selected !== null && sectionContext !== null ? (
        <IntegrationSectionContext.Provider value={sectionContext}>
          {/* Keyed by id: switching integration starts its body fresh, so
              no draft or toggle of one integration leaks into the next. */}
          <div
            key={selected.id}
            role="region"
            aria-label={selected.name}
            data-testid="integration-body"
          >
            {selected.render()}
          </div>
        </IntegrationSectionContext.Provider>
      ) : (
        <NothingInstalled groups={groups} title={emptyTitle} description={emptyDescription} />
      )}
      {trailing}
    </>
  )

  if (embedded) {
    return (
      <div className="space-y-3" data-testid="integration-hub-embedded">
        {nav}
        {body}
      </div>
    )
  }

  return (
    <AdminPage icon={icon} title={title} subtitle={subtitle} nav={nav}>
      {body}
    </AdminPage>
  )
}

function NothingInstalled({
  groups,
  title,
  description,
}: {
  readonly groups: readonly IntegrationGroup[]
  readonly title: string
  readonly description: string
}): ReactElement {
  const install = groups.find((g) => g.install !== undefined)?.install
  return (
    <Card>
      <EmptyState
        title={title}
        description={description}
        action={
          install ? (
            <Link to={addonCatalogHref(install.capability)}>
              <Button variant="primary" size="sm">
                <Plus className="mr-1 h-3.5 w-3.5" />
                {install.label}
              </Button>
            </Link>
          ) : undefined
        }
      />
    </Card>
  )
}

/**
 * "The link named an integration this hub does not have." The fallback to the
 * first integration is right — an empty page nobody can select away from would
 * be worse — but a silent one is not: a notification or a bookmark that names
 * an uninstalled exporter would otherwise show another exporter's settings
 * under a URL that says otherwise. Same rule as `StaleNodeNotice`.
 */
function StaleIntegrationNotice({
  staleId,
  shownName,
}: {
  readonly staleId: string
  readonly shownName: string | null
}): ReactElement {
  const { t } = useTranslation()
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-[11px] text-foreground-subtle"
    >
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
      <span>
        <Trans
          i18nKey="integrationHub.staleIntegration.notice"
          values={{ id: staleId }}
          components={{ mono: <span className="font-mono text-foreground" /> }}
        />
        {shownName !== null && (
          <>
            {' '}
            <Trans
              i18nKey="integrationHub.staleIntegration.showing"
              values={{ name: shownName }}
              components={{ b: <span className="font-medium text-foreground" /> }}
            />
          </>
        )}
      </span>
    </div>
  )
}
