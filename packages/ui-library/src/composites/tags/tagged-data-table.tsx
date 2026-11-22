/**
 * TaggedDataTable — a `DataTable` with the section's tag filter above it and a
 * Tags column (D1054). Flat: one table of the filtered rows. By tag: one table
 * per tag, a row with two tags in both, the untagged group last. Every BYS
 * section and any other tagged list uses this, so the filter, the search and
 * the grouping behave the same everywhere.
 */
import type { JSX } from 'react'
import { useUiText } from '../../contexts/ui-text'
import { type DataColumn, DataTable, type DataTableProps } from '../data-table'
import { DataTableFilterBar } from '../data-table-filter-bar'
import { TagChip, TagChipList } from './tag-chip'
import { TagViewSwitch, useTagMenuActions } from './tag-filter-bar'
import { TAG_FACET_GROUP, useTagFilter } from './use-tag-filter'
import { useTagRegistry } from './use-tag-registry'

export interface TaggedDataTableProps<T> extends Omit<DataTableProps<T>, 'rows' | 'columns'> {
  /** Names the remembered flat | by-tag view. */
  readonly section: string
  readonly rows: readonly T[]
  readonly columns: readonly DataColumn<T>[]
  /** Stable (memoised) accessors: they key the filter's memos. */
  readonly getTags: (row: T) => readonly string[] | undefined
  readonly searchText: (row: T) => readonly string[]
  /** Accessible name of the search box ("Search automations"). */
  readonly searchLabel: string
  /** Where the Tags column goes; default right after the first column. */
  readonly tagsColumnIndex?: number
}

export function TaggedDataTable<T>({
  section,
  rows,
  columns,
  getTags,
  searchText,
  searchLabel,
  tagsColumnIndex = 1,
  emptyMessage,
  ...tableProps
}: TaggedDataTableProps<T>): JSX.Element {
  const uiText = useUiText()
  const registry = useTagRegistry()
  const filter = useTagFilter({ section, rows, getTags, searchText })
  const actions = useTagMenuActions({
    registry,
    countOf: (name) => filter.tagFacets.find((facet) => facet.value === name)?.count,
    onRenamed: filter.followRename,
  })
  const hasTags = filter.tagFacets.length > 0

  const tagsColumn: DataColumn<T> = {
    key: 'tags',
    mobile: 'detail',
    header: uiText('uiLibrary.tags.column', 'Tags'),
    nowrap: false,
    render: (row) => <TagChipList tags={getTags(row)} entries={registry.entries} />,
    notSortableReason: uiText('uiLibrary.tags.columnNotSortable', 'A row can carry several tags'),
  }
  const allColumns = [
    ...columns.slice(0, tagsColumnIndex),
    tagsColumn,
    ...columns.slice(tagsColumnIndex),
  ]
  const empty =
    filter.filter.active && rows.length > 0
      ? uiText('uiLibrary.tags.noMatches', 'Nothing matches this filter.')
      : emptyMessage

  return (
    <div className="space-y-3">
      <DataTableFilterBar
        state={filter.filter.state}
        facets={[]}
        labels={{
          searchPlaceholder: uiText('uiLibrary.tags.searchPlaceholder', 'Search names and tags'),
          searchLabel,
          facetsLabel: uiText('uiLibrary.tags.filterLabel', 'Tags'),
          clearLabel: uiText('uiLibrary.tags.clear', 'Clear'),
        }}
        onSearch={filter.filter.setSearch}
        onToggleFacet={() => undefined}
        onClear={filter.filter.clear}
        groups={[
          {
            id: TAG_FACET_GROUP,
            label: uiText('uiLibrary.tags.filterLabel', 'Tags'),
            facets: filter.tagFacets,
            selected: filter.selected,
            display: 'menu',
            minFacets: 1,
            renderOption: actions.renderOption,
            optionActions: actions.optionActions,
          },
        ]}
        onToggleGroupFacet={filter.filter.toggleGroupFacet}
        trailing={
          <>
            {hasTags && <TagViewSwitch mode={filter.mode} onModeChange={filter.setMode} />}
            {actions.overlay}
          </>
        }
      />
      {filter.mode === 'grouped' && hasTags && filter.visible.length > 0 ? (
        <div className="space-y-4" data-testid={`tag-groups-${section}`}>
          {filter.groups.map((group) => (
            <section
              key={group.key}
              className="space-y-1.5"
              aria-label={group.tag ?? uiText('uiLibrary.tags.untagged', 'No tag')}
            >
              <h4 className="flex items-center gap-2 text-xs font-medium text-foreground-muted">
                {group.tag === null ? (
                  uiText('uiLibrary.tags.untagged', 'No tag')
                ) : (
                  <TagChip name={group.tag} entries={registry.entries} />
                )}
                <span className="tabular-nums text-foreground-subtle">{group.rows.length}</span>
              </h4>
              <DataTable<T> {...tableProps} columns={allColumns} rows={group.rows} />
            </section>
          ))}
        </div>
      ) : (
        <DataTable<T>
          {...tableProps}
          columns={allColumns}
          rows={filter.visible}
          emptyMessage={empty}
        />
      )}
    </div>
  )
}
