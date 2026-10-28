/**
 * Card grid for `/integrations`. The table stays the default; this is the
 * other layout. One card per providing ADDON (its friendly name as the title)
 * that has at least one integration instance: the card says how many
 * integrations the addon has and how many devices they hold together, and the
 * whole card opens the addon's integration page. The cards are split into a
 * `Providers` and a `System` block; an empty block is not shown.
 */
import { type ReactElement, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Search } from 'lucide-react'
import { Button, Input, StatusBadge } from '@camstack/ui-library'
import type { IntegrationAddonGroup } from '../../lib/integration-addon-groups'
import { ProviderIcon } from '../shared/ProviderIcon'
import { IntegrationSection } from './integration-section'

export interface IntegrationGridProps {
  readonly providers: readonly IntegrationAddonGroup[]
  readonly system: readonly IntegrationAddonGroup[]
  readonly onOpen: (group: IntegrationAddonGroup) => void
  readonly searchPlaceholder: string
  readonly emptyLabel: string
}

export function IntegrationGrid({
  providers,
  system,
  onOpen,
  searchPlaceholder,
  emptyLabel,
}: IntegrationGridProps): ReactElement {
  const [query, setQuery] = useState('')
  const matching = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matches = (group: IntegrationAddonGroup): boolean =>
      q.length === 0 ||
      `${group.name} ${group.addonId} ${group.instances.map((i) => i.name).join(' ')}`
        .toLowerCase()
        .includes(q)
    return { providers: providers.filter(matches), system: system.filter(matches) }
  }, [query, providers, system])
  const nothingFound = matching.providers.length === 0 && matching.system.length === 0

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground-subtle"
          aria-hidden
        />
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          className="pl-8"
        />
      </div>
      {nothingFound ? (
        <p className="py-8 text-center text-xs text-foreground-subtle">{emptyLabel}</p>
      ) : (
        <div className="space-y-4">
          {matching.providers.length > 0 && (
            <IntegrationSection kind="providers">
              <CardGrid groups={matching.providers} onOpen={onOpen} />
            </IntegrationSection>
          )}
          {matching.system.length > 0 && (
            <IntegrationSection kind="system">
              <CardGrid groups={matching.system} onOpen={onOpen} />
            </IntegrationSection>
          )}
        </div>
      )}
    </div>
  )
}

interface CardGridProps {
  readonly groups: readonly IntegrationAddonGroup[]
  readonly onOpen: (group: IntegrationAddonGroup) => void
}

function CardGrid({ groups, onOpen }: CardGridProps): ReactElement {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3 lg:grid-cols-3">
      {groups.map((group) => (
        <AddonCard key={group.addonId} group={group} onOpen={onOpen} />
      ))}
    </div>
  )
}

interface AddonCardProps {
  readonly group: IntegrationAddonGroup
  readonly onOpen: (group: IntegrationAddonGroup) => void
}

function AddonCard({ group, onOpen }: AddonCardProps): ReactElement {
  const { t } = useTranslation()
  const openLabel = t('integrations.openNamed', {
    name: group.name,
    defaultValue: 'Open {{name}}',
  })
  return (
    <article
      data-testid={`integration-card-${group.addonId}`}
      className="relative flex min-w-0 items-stretch gap-3 overflow-x-clip rounded-lg border border-border bg-surface p-3"
    >
      <Button
        type="button"
        variant="ghost"
        aria-label={openLabel}
        onClick={() => onOpen(group)}
        className="absolute inset-0 z-0 h-auto w-auto rounded-lg p-0 focus-visible:ring-2 focus-visible:ring-primary"
      />
      <div className="pointer-events-none relative z-10 flex w-20 shrink-0 items-center justify-center">
        <ProviderIcon type={group.addonId} size="xl" />
      </div>
      <div className="pointer-events-none relative z-10 grid min-w-0 flex-1 grid-rows-[1fr_auto_1fr] gap-1">
        <p className="min-w-0 self-start truncate text-sm font-semibold text-foreground">
          {group.name}
        </p>
        <p className="text-xs text-foreground-muted">
          {t('integrations.addonCard.summary', {
            integrations: t('integrations.addonCard.integrationCount', {
              count: group.instanceCount,
            }),
            devices: t('integrations.integrationColumns.deviceCount', { count: group.deviceCount }),
            defaultValue: '{{integrations}} · {{devices}}',
          })}
        </p>
        <StatusBadge status={group.status} className="shrink-0 self-end justify-self-start" />
      </div>
    </article>
  )
}
