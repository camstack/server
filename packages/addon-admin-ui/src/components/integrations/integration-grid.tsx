/**
 * Card grid for `/integrations`. The table stays the default; this is the
 * other layout. Each card carries the same facts as a table row (icon, name,
 * provider, status, device count). Integrations have no node of their own —
 * the list is a hub record — so the card does not invent one.
 *
 * The summary is one open control. Expand stays a separate action above it
 * and does not navigate.
 */
import { type MouseEvent, type ReactElement, type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Search } from 'lucide-react'
import { Button, cn, IconButton, Input, StatusBadge } from '@camstack/ui-library'
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
  return (
    <article
      data-testid={`integration-card-${integration.id}`}
      className={cn(
        'flex min-w-0 flex-col gap-2 overflow-x-clip rounded-lg border border-border bg-surface p-3',
        expanded && 'sm:col-span-2 lg:col-span-3',
      )}
    >
      <IntegrationCardSummary
        integration={integration}
        expanded={expanded}
        onToggleExpand={onToggleExpand}
        onOpen={onOpen}
      />
      {expanded ? <div className="min-w-0">{renderExpanded(integration)}</div> : null}
    </article>
  )
}

interface IntegrationCardSummaryProps {
  readonly integration: Integration
  readonly expanded: boolean
  readonly onToggleExpand: (addonId: string) => void
  readonly onOpen: (integration: Integration) => void
}

function IntegrationCardSummary({
  integration,
  expanded,
  onToggleExpand,
  onOpen,
}: IntegrationCardSummaryProps): ReactElement {
  const { t } = useTranslation()
  const expandLabel = expanded
    ? t('integrations.integrationColumns.collapse', 'Collapse')
    : t('integrations.integrationColumns.expand', 'Expand')
  const openLabel = t('integrations.openNamed', {
    name: integration.name,
    defaultValue: 'Open {{name}}',
  })
  return (
    <div className="relative flex min-w-0 items-stretch gap-3">
      <Button
        type="button"
        variant="ghost"
        aria-label={openLabel}
        onClick={() => onOpen(integration)}
        className="absolute inset-0 z-0 h-auto w-auto rounded-lg p-0 focus-visible:ring-2 focus-visible:ring-primary"
      />
      <IntegrationIdentity integration={integration} />
      <div className="pointer-events-none relative z-10 flex min-w-0 flex-1 flex-col items-start gap-1.5">
        <StatusBadge status={integration.status} className="shrink-0" />
        <p className="text-[11px] text-foreground-muted">
          {t('integrations.integrationColumns.deviceCount', { count: integration.deviceCount })}
        </p>
        <div className="pointer-events-auto mt-auto self-end">
          <IconButton
            type="button"
            variant="ghost"
            size="sm"
            icon={expanded ? ChevronDown : ChevronRight}
            aria-label={expandLabel}
            aria-expanded={expanded}
            onClick={(event) => onExpandClick(event, integration.addonId, onToggleExpand)}
          />
        </div>
      </div>
    </div>
  )
}

interface IntegrationIdentityProps {
  readonly integration: Integration
}

function IntegrationIdentity({ integration }: IntegrationIdentityProps): ReactElement {
  return (
    <div className="pointer-events-none relative z-10 flex w-28 shrink-0 flex-col items-center gap-1 lg:w-24">
      <ProviderIcon type={integration.addonId} size="xl" />
      <p className="w-full text-center text-xs font-semibold text-foreground">{integration.name}</p>
      <ProviderId addonId={integration.addonId} />
    </div>
  )
}

interface ProviderIdProps {
  readonly addonId: string
}

/** Break after a hyphen so a long addon id stays readable in the icon column. */
function ProviderId({ addonId }: ProviderIdProps): ReactElement {
  const parts = addonId.split('-')
  return (
    <p className="w-full text-center text-[10px] leading-tight text-foreground-subtle">
      {parts.map((part, index) => (
        <span key={`${part}-${String(index)}`}>
          {index > 0 ? (
            <>
              -<wbr />
            </>
          ) : null}
          {part}
        </span>
      ))}
    </p>
  )
}

function onExpandClick(
  event: MouseEvent<HTMLButtonElement>,
  addonId: string,
  onToggleExpand: (addonId: string) => void,
): void {
  event.stopPropagation()
  onToggleExpand(addonId)
}
