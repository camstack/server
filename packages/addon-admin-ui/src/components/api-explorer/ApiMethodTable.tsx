/**
 * The API explorer's method list (planning#595): every method the hub serves,
 * split into collapsible macro groups (`lib/api-method-groups.ts`) with counts,
 * searchable across all of them, with tier and source filters. The call kind is
 * a small neutral badge next to the name, not a column or a filter. A row click
 * selects the method.
 */
import {
  Badge,
  type BadgeVariant,
  CollapsibleCard,
  type DataColumn,
  DataTable,
  type DataTableFilterConfig,
  DataTableFilterBar,
  TABLE_SCROLL_MAX_H,
  useDataTableFilter,
} from '@camstack/ui-library'
import type { ApiCatalogMethod } from '@camstack/types'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { type ApiGroupId, groupMethods } from '../../lib/api-method-groups'

export interface ApiMethodTableProps {
  readonly methods: readonly ApiCatalogMethod[]
  readonly selectedPath: string | null
  readonly onSelect: (path: string) => void
}

const FILTER_CONFIG: DataTableFilterConfig<ApiCatalogMethod> = {
  searchText: (m) => [m.path, m.scope?.capName ?? '', m.description ?? ''],
  facetGroups: [
    { id: 'tier', value: (m) => m.tier },
    { id: 'source', value: (m) => m.source },
  ],
}

const TIER_VARIANT: Readonly<Record<ApiCatalogMethod['tier'], BadgeVariant>> = {
  public: 'success',
  protected: 'neutral',
  admin: 'primary',
}

export interface KindBadgeProps {
  readonly kind: ApiCatalogMethod['kind']
}

/** The call type, deliberately quiet: one neutral outline for every kind. */
export function KindBadge({ kind }: KindBadgeProps): ReactNode {
  const { t } = useTranslation()
  return (
    <Badge variant="neutral" style="outline" size="sm">
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

export function ApiMethodTable({
  methods,
  selectedPath,
  onSelect,
}: ApiMethodTableProps): ReactNode {
  const { t } = useTranslation()
  const filter = useDataTableFilter(methods, FILTER_CONFIG)
  const [toggled, setToggled] = useState<Readonly<Record<string, boolean>>>({})
  const totals = useMemo(
    () => new Map(groupMethods(methods).map((g) => [g.id, g.methods.length])),
    [methods],
  )
  const groups = useMemo(() => groupMethods(filter.rows), [filter.rows])
  const selectedGroup = useMemo(
    () => groupMethods(methods.filter((m) => m.path === selectedPath))[0]?.id ?? null,
    [methods, selectedPath],
  )

  const groupLabel = (id: string): string => t(`system.apiExplorer.group.${id}`)
  const facetLabel = (groupId: string) => (value: string) =>
    t(`system.apiExplorer.${groupId}.${value}`)
  // A search opens every group that matched; otherwise only the selected method's group.
  const isOpen = (id: ApiGroupId): boolean => toggled[id] ?? (filter.active || id === selectedGroup)

  const columns: readonly DataColumn<ApiCatalogMethod>[] = [
    {
      key: 'path',
      header: t('system.apiExplorer.column.method'),
      sortValue: (m) => m.path,
      render: (m) => (
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-xs">
              <span className="text-foreground-muted">{m.router}.</span>
              <span className="text-foreground">{m.method}</span>
            </span>
            <KindBadge kind={m.kind} />
          </span>
          {m.description !== null && (
            <span className="block max-w-xs truncate text-xs text-foreground-muted">
              {m.description}
            </span>
          )}
        </span>
      ),
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
          <span className="text-xs text-foreground-subtle">
            {t('system.apiExplorer.coreRoute')}
          </span>
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
      {groups.length === 0 ? (
        <p className="py-6 text-center text-sm text-foreground-muted">
          {filter.active ? t('system.apiExplorer.noMatch') : t('system.apiExplorer.noMethods')}
        </p>
      ) : (
        groups.map((group) => (
          <CollapsibleCard
            key={group.id}
            expanded={isOpen(group.id)}
            onExpandedChange={(next) => setToggled((prev) => ({ ...prev, [group.id]: next }))}
            header={
              <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                <span className="truncate text-sm font-medium text-foreground">
                  {t(`system.apiExplorer.macro.${group.id}`)}
                </span>
                <Badge variant="neutral" size="sm">
                  {filter.active
                    ? t('system.apiExplorer.macroCount', {
                        shown: group.methods.length,
                        total: totals.get(group.id) ?? group.methods.length,
                      })
                    : group.methods.length}
                </Badge>
              </span>
            }
          >
            <DataTable
              columns={columns}
              rows={group.methods}
              rowKey={(m) => m.path}
              onRowClick={(m) => onSelect(m.path)}
              rowClassName={(m) => (m.path === selectedPath ? 'bg-primary/10' : undefined)}
              minWidthPx={480}
              maxBodyHeight={TABLE_SCROLL_MAX_H}
              defaultSort={{ columnKey: 'path', dir: 'asc' }}
              emptyMessage={t('system.apiExplorer.noMatch')}
            />
          </CollapsibleCard>
        ))
      )}
    </div>
  )
}
