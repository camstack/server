/**
 * Card grid for `/integrations`. The table stays the default; this is the
 * other layout. Each card carries the same facts as a table row (icon, name,
 * provider, status, device count) and the same actions (expand, open).
 * Integrations have no node of their own — the list is a hub record — so the
 * card does not invent one.
 */
import { Button, cn, IconButton, Input, StatusBadge } from '@camstack/ui-library'
import { ChevronDown, ChevronRight, Search } from 'lucide-react'
import { type ReactElement, type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ProviderIcon } from '../shared/ProviderIcon'
import type { Integration } from './integration-columns'

export interface IntegrationGridProps {
  readonly rows: readonly Integration[]
  readonly isExpanded: (integration: Integration) => boolean
  readonly onToggleExpand: (addonId: string) => void
  readonly onOpen: (integration: Integration) => void
  readonly renderExpanded: (integration: Integration) => ReactNode
  readonly searchPlaceholder: string
  readonly emptyLabel: string
}

export function IntegrationGrid({
  rows,
  isExpanded,
  onToggleExpand,
  onOpen,
  renderExpanded,
  searchPlaceholder,
  emptyLabel,
}: IntegrationGridProps): ReactElement {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length === 0) return rows
    return rows.filter((row) => `${row.name} ${row.addonId}`.toLowerCase().includes(q))
  }, [query, rows])

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
      {filtered.length === 0 ? (
        <p className="py-8 text-center text-xs text-foreground-subtle">{emptyLabel}</p>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3 lg:grid-cols-3">
          {filtered.map((integration) => (
            <IntegrationCard
              key={integration.id}
              integration={integration}
              expanded={isExpanded(integration)}
              onToggleExpand={onToggleExpand}
              onOpen={onOpen}
              renderExpanded={renderExpanded}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface IntegrationCardProps {
  readonly integration: Integration
  readonly expanded: boolean
  readonly onToggleExpand: (addonId: string) => void
  readonly onOpen: (integration: Integration) => void
  readonly renderExpanded: (integration: Integration) => ReactNode
}

function IntegrationCard({
  integration,
  expanded,
  onToggleExpand,
  onOpen,
  renderExpanded,
}: IntegrationCardProps): ReactElement {
  const { t } = useTranslation()
  const expandLabel = expanded
    ? t('integrations.integrationColumns.collapse', 'Collapse')
    : t('integrations.integrationColumns.expand', 'Expand')
  return (
    <article
      data-testid={`integration-card-${integration.id}`}
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-surface p-3',
        expanded && 'sm:col-span-2 lg:col-span-3',
      )}
    >
      <div className="flex items-start gap-2">
        <ProviderIcon type={integration.addonId} size="md" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold text-foreground">{integration.name}</p>
          <p className="truncate text-[10px] text-foreground-subtle">{integration.addonId}</p>
        </div>
        <StatusBadge status={integration.status} className="shrink-0" />
      </div>
      <p className="text-[11px] text-foreground-muted">
        {t('integrations.integrationColumns.deviceCount', { count: integration.deviceCount })}
      </p>
      <div className="flex flex-wrap items-center justify-end gap-1">
        <IconButton
          type="button"
          variant="ghost"
          size="sm"
          icon={expanded ? ChevronDown : ChevronRight}
          aria-label={expandLabel}
          aria-expanded={expanded}
          onClick={() => onToggleExpand(integration.addonId)}
        />
        <Button type="button" variant="outline" size="sm" onClick={() => onOpen(integration)}>
          {t('integrations.open', 'Open')}
        </Button>
      </div>
      {expanded ? renderExpanded(integration) : null}
    </article>
  )
}
