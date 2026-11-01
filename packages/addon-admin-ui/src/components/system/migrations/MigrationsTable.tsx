/**
 * Every migration the hub knows, in the common `DataTable`: id, owner, status,
 * level, body kind, applied-at. Filters (search, owner, status) sit outside the
 * table; a row opens its detail.
 */
import {
  DataTable,
  DataTableFilterBar,
  TABLE_SCROLL_MAX_H,
  useDataTableFilter,
  type DataColumn,
  type DataTableFilterConfig,
} from '@camstack/ui-library'
import { useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { MIGRATION_STATUS_LABEL, MigrationStatusBadge } from './MigrationStatusBadge'
import { statusRank, type MigrationRow, type MigrationRowStatus } from './migration-rows'

const FILTER_CONFIG: DataTableFilterConfig<MigrationRow> = {
  searchText: (r) => [r.id, r.owner, r.meta?.description ?? ''],
  facetGroups: [
    { id: 'owner', value: (r) => r.owner },
    { id: 'status', value: (r) => r.status },
  ],
}

export const MIGRATIONS_PAGE_SIZE = 25

export function formatApplied(ts: number | null): string {
  if (ts === null) return '—'
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
}

export interface MigrationsTableProps {
  readonly rows: readonly MigrationRow[]
  readonly onOpen: (id: string) => void
}

export function MigrationsTable({ rows, onOpen }: MigrationsTableProps): ReactNode {
  const { t } = useTranslation()
  const filter = useDataTableFilter(rows, FILTER_CONFIG)

  const columns = useMemo<DataColumn<MigrationRow>[]>(
    () => [
      {
        key: 'id',
        header: t('migrations.col.id', 'Migration'),
        sortValue: (r) => r.id,
        render: (r) => (
          <div className="min-w-0 max-w-[22rem]">
            <div className="truncate font-mono text-xs text-foreground" title={r.id}>
              {r.id}
            </div>
            {r.meta !== null && (
              <div
                className="truncate text-[10px] text-foreground-subtle"
                title={r.meta.description}
              >
                {r.meta.description}
              </div>
            )}
          </div>
        ),
      },
      {
        key: 'owner',
        header: t('migrations.col.owner', 'Owner'),
        sortValue: (r) => r.owner,
        render: (r) => r.owner,
      },
      {
        key: 'status',
        header: t('migrations.col.status', 'Status'),
        sortValue: (r) => statusRank(r.status),
        render: (r) => <MigrationStatusBadge status={r.status} />,
      },
      {
        key: 'level',
        header: t('migrations.col.level', 'Level'),
        sortValue: (r) => r.meta?.level ?? null,
        render: (r) => r.meta?.level ?? '—',
      },
      {
        key: 'body',
        header: t('migrations.col.body', 'Body'),
        sortValue: (r) => r.meta?.bodyKind ?? null,
        render: (r) => r.meta?.bodyKind ?? '—',
      },
      {
        key: 'applied',
        header: t('migrations.col.applied', 'Applied'),
        sortValue: (r) => r.appliedAt,
        render: (r) => <span className="text-foreground-subtle">{formatApplied(r.appliedAt)}</span>,
      },
    ],
    [t],
  )

  const label = t('migrations.label', 'migrations')
  return (
    <div className="space-y-3">
      <DataTableFilterBar
        state={filter.state}
        facets={filter.facets}
        groups={filter.groups.map((g) => ({
          ...g,
          label: g.id === 'owner' ? t('migrations.col.owner') : t('migrations.col.status'),
          ...(g.id === 'status'
            ? { facetLabel: (v: string) => t(MIGRATION_STATUS_LABEL[v as MigrationRowStatus]) }
            : {}),
        }))}
        labels={{
          searchPlaceholder: t('migrations.searchPlaceholder', 'Search migrations'),
          searchLabel: t('migrations.searchLabel', 'Search migrations'),
          facetsLabel: t('migrations.facetsLabel', 'Filter migrations'),
          clearLabel: t('migrations.clearFilters', 'Clear filters'),
        }}
        onSearch={filter.setSearch}
        onToggleFacet={filter.toggleFacet}
        onToggleGroupFacet={filter.toggleGroupFacet}
        onClear={filter.clear}
      />
      <DataTable
        columns={columns}
        rows={filter.rows}
        rowKey={(r) => r.id}
        minWidthPx={820}
        maxBodyHeight={TABLE_SCROLL_MAX_H}
        defaultSort={{ columnKey: 'status', dir: 'asc' }}
        pageSize={MIGRATIONS_PAGE_SIZE}
        onRowClick={(r) => onOpen(r.id)}
        paginationLabels={{
          navLabel: t('migrations.pagesLabel', 'Migration pages'),
          previous: t('migrations.previousPage', 'Previous'),
          next: t('migrations.nextPage', 'Next'),
          range: (from, to, total) =>
            t('migrations.range', '{{from}}–{{to}} of {{total}}', { from, to, total }),
        }}
        emptyMessage={
          filter.active
            ? t('migrations.noMatch', 'No {{label}} match the filters.', { label })
            : t('migrations.empty', 'No migrations.')
        }
      />
    </div>
  )
}
