/**
 * The API explorer's method list (planning#595): every method the hub serves,
 * searchable, sorted by path so a router's methods sit together, with a menu
 * per router and chips for kind, tier and source. A row click selects it.
 */
import {
  Badge,
  type BadgeVariant,
  type DataColumn,
  DataTable,
  type DataTableFilterConfig,
  DataTableFilterBar,
  TABLE_SCROLL_MAX_H,
  useDataTableFilter,
} from '@camstack/ui-library'
import type { ApiCatalogMethod } from '@camstack/types'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

export interface ApiMethodTableProps {
  readonly methods: readonly ApiCatalogMethod[]
  readonly selectedPath: string | null
  readonly onSelect: (path: string) => void
}

const FILTER_CONFIG: DataTableFilterConfig<ApiCatalogMethod> = {
  searchText: (m) => [m.path, m.scope?.capName ?? ''],
  facetGroups: [
    { id: 'router', value: (m) => m.router },
    { id: 'kind', value: (m) => m.kind },
    { id: 'tier', value: (m) => m.tier },
    { id: 'source', value: (m) => m.source },
  ],
}

const KIND_VARIANT: Readonly<Record<ApiCatalogMethod['kind'], BadgeVariant>> = {
  query: 'info',
  mutation: 'warning',
  subscription: 'neutral',
}

const TIER_VARIANT: Readonly<Record<ApiCatalogMethod['tier'], BadgeVariant>> = {
  public: 'success',
  protected: 'neutral',
  admin: 'primary',
}

export interface KindBadgeProps {
  readonly kind: ApiCatalogMethod['kind']
}

export function KindBadge({ kind }: KindBadgeProps): ReactNode {
  const { t } = useTranslation()
  return (
    <Badge variant={KIND_VARIANT[kind]} size="sm">
      {t(`system.apiExplorer.kind.${kind}`)}
    </Badge>
  )
}

export interface TierBadgeProps {
  readonly tier: ApiCatalogMethod['tier']
}

export function TierBadge({ tier }: TierBadgeProps): ReactNode {
  const { t } = useTranslation()
  return (
    <Badge variant={TIER_VARIANT[tier]} style="outline" size="sm">
      {t(`system.apiExplorer.tier.${tier}`)}
    </Badge>
  )
}

export function ApiMethodTable({ methods, selectedPath, onSelect }: ApiMethodTableProps): ReactNode {
  const { t } = useTranslation()
  const filter = useDataTableFilter(methods, FILTER_CONFIG)

  const groupLabel = (id: string): string => t(`system.apiExplorer.group.${id}`)
  const facetLabel = (groupId: string) => (value: string) =>
    groupId === 'router' ? value : t(`system.apiExplorer.${groupId}.${value}`)

  const columns: readonly DataColumn<ApiCatalogMethod>[] = [
    {
      key: 'path',
      header: t('system.apiExplorer.column.method'),
      sortValue: (m) => m.path,
      render: (m) => (
        <span className="font-mono text-xs">
          <span className="text-foreground-muted">{m.router}.</span>
          <span className="text-foreground">{m.method}</span>
        </span>
      ),
    },
    {
      key: 'kind',
      header: t('system.apiExplorer.column.kind'),
      sortValue: (m) => m.kind,
      render: (m) => <KindBadge kind={m.kind} />,
    },
    {
      key: 'tier',
      header: t('system.apiExplorer.column.tier'),
      sortValue: (m) => m.tier,
      render: (m) => <TierBadge tier={m.tier} />,
    },
    {
      key: 'scope',
      header: t('system.apiExplorer.column.scope'),
      sortValue: (m) => (m.scope === null ? null : `${m.scope.capName}:${m.scope.access}`),
      render: (m) =>
        m.scope === null ? (
          <span className="text-xs text-foreground-subtle">{t('system.apiExplorer.coreRoute')}</span>
        ) : (
          <span className="font-mono text-xs text-foreground-muted">
            {m.scope.capName} · {m.scope.access}
          </span>
        ),
    },
  ]

  return (
    <div className="space-y-3">
      <DataTableFilterBar
        state={filter.state}
        facets={filter.facets}
        groups={filter.groups.map((g) => ({
          ...g,
          label: groupLabel(g.id),
          facetLabel: facetLabel(g.id),
          ...(g.id === 'router' ? { display: 'menu' as const } : {}),
        }))}
        labels={{
          searchPlaceholder: t('system.apiExplorer.searchPlaceholder'),
          searchLabel: t('system.apiExplorer.searchLabel'),
          facetsLabel: t('system.apiExplorer.facetsLabel'),
          clearLabel: t('system.apiExplorer.clearFilters'),
        }}
        onSearch={filter.setSearch}
        onToggleFacet={filter.toggleFacet}
        onToggleGroupFacet={filter.toggleGroupFacet}
        onClear={filter.clear}
      />
      <DataTable
        columns={columns}
        rows={filter.rows}
        rowKey={(m) => m.path}
        onRowClick={(m) => onSelect(m.path)}
        rowClassName={(m) => (m.path === selectedPath ? 'bg-primary/10' : undefined)}
        minWidthPx={560}
        maxBodyHeight={TABLE_SCROLL_MAX_H}
        defaultSort={{ columnKey: 'path', dir: 'asc' }}
        emptyMessage={
          filter.active ? t('system.apiExplorer.noMatch') : t('system.apiExplorer.noMethods')
        }
      />
    </div>
  )
}
