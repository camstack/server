/**
 * The History page's series picker: search (device, room, metric, node) and
 * chip filters over every recorded series, multi-select up to 24.
 */
import { useMemo } from 'react'
import {
  DataTable,
  DataTableFilterBar,
  HISTORY_SELECTION_MAX,
  TABLE_SCROLL_MAX_H,
  useDataTableFilter,
  type DataColumn,
} from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'
import { candidateSearchText, type SeriesCandidate } from './history-page-model'

export interface SeriesPickerProps {
  readonly catalog: readonly SeriesCandidate[]
  readonly selected: ReadonlySet<string>
  readonly onChange: (next: ReadonlySet<string>) => void
  readonly loading: boolean
}

const KIND_DEVICE = 'device'
const KIND_NODE = 'node'

export function SeriesPicker({ catalog, selected, onChange, loading }: SeriesPickerProps) {
  const { t } = useTranslation()
  const filter = useDataTableFilter(catalog, {
    searchText: (c) => [candidateSearchText(c)],
    facetGroups: [
      { id: 'subject', value: (c) => (c.ref.subject.kind === 'device' ? KIND_DEVICE : KIND_NODE) },
      { id: 'room', value: (c) => c.location },
      { id: 'unit', value: (c) => c.info.unit ?? '' },
    ],
  })
  const columns = useMemo<DataColumn<SeriesCandidate>[]>(
    () => [
      {
        key: 'metric',
        header: t('history.picker.series', 'Series'),
        render: (c) => (
          <div className="min-w-0">
            <div className="truncate text-foreground">{c.metric}</div>
            <div className="truncate text-[10px] text-foreground-subtle">
              {c.location !== '' ? `${c.subjectName} · ${c.location}` : c.subjectName}
            </div>
          </div>
        ),
        sortValue: (c) => `${c.subjectName} ${c.metric}`,
      },
      {
        key: 'unit',
        header: t('history.picker.unit', 'Unit'),
        render: (c) => <span className="text-foreground-muted">{c.info.unit ?? '—'}</span>,
        sortValue: (c) => c.info.unit ?? '',
      },
    ],
    [t],
  )
  const atMax = selected.size >= HISTORY_SELECTION_MAX
  return (
    <div className="space-y-2 min-w-0">
      <DataTableFilterBar
        state={filter.state}
        facets={[]}
        groups={[
          {
            ...(filter.groups.find((g) => g.id === 'subject') ?? {
              id: 'subject',
              facets: [],
              selected: [],
            }),
            label: t('history.picker.subject', 'Source'),
            facetLabel: (v) =>
              v === KIND_DEVICE
                ? t('history.picker.devices', 'Devices')
                : t('history.picker.nodes', 'Nodes'),
          },
          {
            ...(filter.groups.find((g) => g.id === 'room') ?? {
              id: 'room',
              facets: [],
              selected: [],
            }),
            label: t('history.picker.room', 'Room'),
            facetLabel: (v) => (v === '' ? t('history.picker.noRoom', 'No room') : v),
          },
          {
            ...(filter.groups.find((g) => g.id === 'unit') ?? {
              id: 'unit',
              facets: [],
              selected: [],
            }),
            label: t('history.picker.metricType', 'Unit'),
            facetLabel: (v) => (v === '' ? t('history.picker.noUnit', 'States & counts') : v),
          },
        ]}
        labels={{
          searchPlaceholder: t('history.picker.search', 'Search device, room, metric or node…'),
          searchLabel: t('history.picker.searchLabel', 'Search series'),
          facetsLabel: t('history.picker.facets', 'Filters'),
          clearLabel: t('history.picker.clear', 'Clear'),
        }}
        onSearch={filter.setSearch}
        onToggleFacet={filter.toggleFacet}
        onToggleGroupFacet={filter.toggleGroupFacet}
        onClear={filter.clear}
      />
      <p className="text-[10px] text-foreground-subtle" aria-live="polite">
        {t('history.picker.count', '{{count}} of {{max}} selected', {
          count: selected.size,
          max: HISTORY_SELECTION_MAX,
        })}
      </p>
      <DataTable
        columns={columns}
        rows={filter.rows}
        rowKey={(c) => c.id}
        maxBodyHeight={TABLE_SCROLL_MAX_H}
        pageSize={50}
        defaultSort={{ columnKey: 'metric', dir: 'asc' }}
        emptyMessage={
          loading
            ? t('history.picker.loading', 'Reading the series of every device…')
            : filter.active
              ? t('history.picker.emptyFiltered', 'No series match these filters.')
              : t('history.picker.empty', 'Nothing is recorded yet.')
        }
        selection={{
          selected,
          onChange: (next) => {
            // Never past the cap: keep what was already selected, then add in order.
            const kept = [...next].filter((id) => selected.has(id))
            const added = [...next].filter((id) => !selected.has(id))
            onChange(new Set([...kept, ...added].slice(0, HISTORY_SELECTION_MAX)))
          },
          isSelectable: (c) => selected.has(c.id) || !atMax,
          rowLabel: (c) => `${c.subjectName} · ${c.metric}`,
          pageLabel: t('history.picker.selectPage', 'Select every series on this page'),
        }}
      />
    </div>
  )
}
