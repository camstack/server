import type { EntryKindInfo, StorageKind } from '@camstack/types'
import { Loader2 } from 'lucide-react'
import { useCallback, useMemo, type JSX } from 'react'
import { trpc } from '../../trpc-react'
import { useRecordEntriesListEntryKinds } from '../../generated/system-hooks'
import { Badge } from '../../primitives/badge'
import { Button } from '../../primitives/button'
import { DataTable, TABLE_SCROLL_MAX_H, type DataColumn } from '../data-table'
import { DataTableFilterBar } from '../data-table-filter-bar'
import { useDataTableFilter } from '../use-data-table-filter'
import { EmptyState } from '../empty-state'
import { ErrorBox } from '../error-box'
import { RecordEntriesPanel } from '../record-entries/record-entries-panel'
import { StorageRecordsPanel } from '../storage-records/storage-records-panel'
import { useUiText, type UiTextFn } from '../../contexts/ui-text'
import { useUrlQueryParam } from '../../hooks/use-url-query'
import {
  buildDataRecordRows,
  DATA_RECORD_FACET_GROUPS,
  dataRecordKey,
  dataRecordSearchText,
  type DataRecordRow,
} from './data-records-model'

export const DATA_RECORDS_OWNER_PARAM = 'recordsOwner'
export const DATA_RECORDS_KIND_PARAM = 'recordsKind'

function formatBytes(n: number | null): string {
  if (n === null) return '—'
  if (n < 1024) return `${n} B`
  // i18n-ignore-start: IEC unit symbols, the same in every language
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`
  // i18n-ignore-end
}

function groupLabel(id: string, t: UiTextFn): string {
  switch (id) {
    case 'kind':
      return t('uiLibrary.dataRecords.facetKind', 'Kind')
    case 'owner':
      return t('uiLibrary.dataRecords.facetOwner', 'Owner')
    case 'type':
      return t('uiLibrary.dataRecords.facetType', 'Type')
    case 'database':
      return t('uiLibrary.dataRecords.facetDatabase', 'Database')
    case 'class':
      return t('uiLibrary.dataRecords.facetClass', 'Class')
    case 'state':
      return t('uiLibrary.dataRecords.facetState', 'State')
    default:
      return t('uiLibrary.dataRecords.facetContents', 'Contents')
  }
}

function facetCaption(groupId: string, value: string, t: UiTextFn): string {
  if (groupId === 'type') {
    return value === 'entry'
      ? t('uiLibrary.dataRecords.typeEntry', 'Entries (editable)')
      : t('uiLibrary.dataRecords.typeRecord', 'Records (read-only)')
  }
  if (groupId === 'contents') {
    if (value === 'has-rows') return t('uiLibrary.dataRecords.contentsHasRows', 'Has rows')
    if (value === 'empty') return t('uiLibrary.dataRecords.contentsEmpty', 'Empty')
    return t('uiLibrary.dataRecords.contentsUnknown', 'Count unknown')
  }
  return value
}

interface DetailProps {
  readonly kind: StorageKind
  readonly entryKinds: readonly EntryKindInfo[] | undefined
  readonly entryKindsPending: boolean
  readonly entryKindsError: string | null
}

/** Entry kinds open the editable list; every other kind opens the read-only preview. */
function KindDetail({
  kind,
  entryKinds,
  entryKindsPending,
  entryKindsError,
}: DetailProps): JSX.Element {
  const t = useUiText()
  if (!kind.entry) return <StorageRecordsPanel kind={kind} />
  // The entry catalog is still asking: unanswered is not "not editable".
  if (entryKindsPending) {
    return (
      <div className="flex justify-center py-8 text-foreground-subtle">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    )
  }
  if (entryKindsError !== null) return <ErrorBox message={entryKindsError} />
  const info = entryKinds?.find((e) => dataRecordKey(e) === dataRecordKey(kind))
  if (info === undefined) {
    return (
      <ErrorBox
        message={t(
          'uiLibrary.dataRecords.entryKindMissing',
          'This entry kind is not served by the entries service.',
        )}
      />
    )
  }
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-foreground">{info.title}</h3>
      <RecordEntriesPanel kind={info} />
    </div>
  )
}

/**
 * System → Data → Records: every declared record kind in ONE table with
 * compact filters; an entry kind opens its editable list, any other kind its
 * read-only row preview. Selection is in `?recordsOwner=&recordsKind=`.
 */
export function DataRecordsHub(): JSX.Element {
  const t = useUiText()
  const kindsQuery = trpc.storageAdmin.listKinds.useQuery({}, { staleTime: 30_000 })
  const entryKindsQuery = useRecordEntriesListEntryKinds({}, { staleTime: 30_000 })
  const [ownerParam, setOwner] = useUrlQueryParam(DATA_RECORDS_OWNER_PARAM)
  const [kindParam, setKind] = useUrlQueryParam(DATA_RECORDS_KIND_PARAM)

  const entryKinds = entryKindsQuery.data?.kinds
  const rows = useMemo(
    () => buildDataRecordRows(kindsQuery.data?.kinds ?? [], entryKinds),
    [entryKinds, kindsQuery.data?.kinds],
  )

  const filter = useDataTableFilter(rows, {
    searchText: dataRecordSearchText,
    facetGroups: DATA_RECORD_FACET_GROUPS,
  })

  const active = useMemo((): StorageKind | null => {
    const match = rows.find((r) => r.kind.owner === ownerParam && r.kind.kind === kindParam)
    return match?.kind ?? null
  }, [kindParam, ownerParam, rows])

  const selectKind = useCallback(
    (k: StorageKind): void => {
      setOwner(k.owner)
      setKind(k.kind)
    },
    [setKind, setOwner],
  )

  const columns = useMemo((): readonly DataColumn<DataRecordRow>[] => {
    return [
      {
        key: 'kind',
        header: t('uiLibrary.dataRecords.colKind', 'Kind'),
        render: (row) => (
          <span className="flex flex-col">
            <span className="font-mono text-xs">{dataRecordKey(row.kind)}</span>
            {row.entryTitle !== null ? (
              <span className="text-[11px] text-foreground-subtle">{row.entryTitle}</span>
            ) : null}
          </span>
        ),
        sortValue: (row) => dataRecordKey(row.kind),
      },
      {
        key: 'type',
        header: t('uiLibrary.dataRecords.colType', 'Type'),
        nowrap: true,
        render: (row) =>
          row.kind.entry ? (
            <Badge variant="info">{t('uiLibrary.dataRecords.badgeEntry', 'Entry')}</Badge>
          ) : (
            <Badge variant="neutral">{t('uiLibrary.dataRecords.badgeRecord', 'Record')}</Badge>
          ),
        sortValue: (row) => (row.kind.entry ? 'entry' : 'record'),
      },
      {
        key: 'database',
        header: t('uiLibrary.dataRecords.colDatabase', 'DB'),
        nowrap: true,
        render: (row) => (
          <Badge variant="neutral" style="outline">
            {row.kind.database}
          </Badge>
        ),
        sortValue: (row) => row.kind.database,
      },
      {
        key: 'class',
        header: t('uiLibrary.dataRecords.colClass', 'Class'),
        nowrap: true,
        render: (row) => <span className="text-xs text-foreground-muted">{row.kind.class}</span>,
        sortValue: (row) => row.kind.class,
      },
      {
        key: 'state',
        header: t('uiLibrary.dataRecords.colState', 'State'),
        nowrap: true,
        render: (row) => (
          <Badge variant={row.kind.state === 'declared' ? 'default' : 'neutral'}>
            {row.kind.state}
          </Badge>
        ),
        sortValue: (row) => row.kind.state,
      },
      {
        key: 'rows',
        header: t('uiLibrary.dataRecords.colRows', 'Rows'),
        align: 'right',
        nowrap: true,
        render: (row) => (
          <span className="font-mono text-xs tabular-nums">
            {row.kind.rows === null ? '—' : row.kind.rows}
          </span>
        ),
        sortValue: (row) => row.kind.rows ?? -1,
      },
      {
        key: 'bytes',
        header: t('uiLibrary.dataRecords.colSize', 'Est. size'),
        align: 'right',
        nowrap: true,
        render: (row) => (
          <span className="text-xs text-foreground-subtle">
            {formatBytes(row.kind.bytesEstimate)}
          </span>
        ),
        sortValue: (row) => row.kind.bytesEstimate ?? -1,
      },
      {
        key: 'open',
        header: '',
        align: 'right',
        nowrap: true,
        render: (row) => {
          const selected = active !== null && dataRecordKey(active) === dataRecordKey(row.kind)
          return (
            <Button
              type="button"
              size="sm"
              variant={selected ? 'primary' : 'outline'}
              onClick={() => selectKind(row.kind)}
            >
              {row.kind.entry
                ? t('uiLibrary.dataRecords.manage', 'Manage')
                : t('uiLibrary.dataRecords.viewRows', 'View rows')}
            </Button>
          )
        },
        notSortableReason: t('uiLibrary.dataRecords.actionColumn', 'Actions'),
      },
    ]
  }, [active, selectKind, t])

  if (kindsQuery.isError) {
    return (
      <ErrorBox
        message={
          kindsQuery.error instanceof Error
            ? kindsQuery.error.message
            : t('uiLibrary.dataRecords.kindsFailed', 'Could not load record kinds')
        }
      />
    )
  }

  if (kindsQuery.isPending) {
    return (
      <div className="flex justify-center py-10 text-foreground-subtle">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        title={t('uiLibrary.dataRecords.noKindsTitle', 'No record kinds')}
        description={t(
          'uiLibrary.dataRecords.noKindsDescription',
          'No addon has declared a record kind on this hub yet.',
        )}
      />
    )
  }

  return (
    <div className="space-y-4">
      <DataTableFilterBar
        state={filter.state}
        facets={filter.facets}
        groups={filter.groups.map((g) => ({
          ...g,
          label: groupLabel(g.id, t),
          display: 'menu' as const,
          facetLabel: (value: string) => facetCaption(g.id, value, t),
        }))}
        labels={{
          searchPlaceholder: t('uiLibrary.dataRecords.search', 'Search kinds…'),
          searchLabel: t('uiLibrary.dataRecords.searchLabel', 'Search record kinds'),
          facetsLabel: t('uiLibrary.dataRecords.facetsLabel', 'Filter record kinds'),
          clearLabel: t('uiLibrary.dataRecords.clearFilters', 'Clear filters'),
        }}
        onSearch={filter.setSearch}
        onToggleFacet={filter.toggleFacet}
        onToggleGroupFacet={filter.toggleGroupFacet}
        onClear={filter.clear}
      />
      <DataTable
        columns={columns}
        rows={filter.rows}
        rowKey={(r) => dataRecordKey(r.kind)}
        maxBodyHeight={TABLE_SCROLL_MAX_H}
        defaultSort={{ columnKey: 'kind', dir: 'asc' }}
        emptyMessage={t('uiLibrary.dataRecords.noMatch', 'No kinds match the filter')}
      />
      {active !== null ? (
        <KindDetail
          kind={active}
          entryKinds={entryKinds}
          entryKindsPending={entryKindsQuery.isPending}
          entryKindsError={
            entryKindsQuery.isError
              ? entryKindsQuery.error instanceof Error
                ? entryKindsQuery.error.message
                : t('uiLibrary.dataRecords.entryKindsFailed', 'Could not load entry kinds')
              : null
          }
        />
      ) : null}
    </div>
  )
}
