/**
 * The ONE table of Identity → Tokens & sessions (D819): a filter bar (search +
 * Status / Owner / Kind chips), the common `DataTable` (sortable columns, 25
 * rows a page, rows scrolling inside the table under a pinned header, sideways
 * inside its own wrapper on a phone) and — for the kinds the hub can revoke in
 * bulk — row selection with the bulk bar. The bulk OUTCOME is not drawn here:
 * it goes to the body's one notice region (`AccessSection`).
 *
 * Bulk targets are the selected rows that are ON SCREEN after the filter: a
 * row the filter hides is never revoked by a selection made before the filter
 * changed. The caller's own session is never selectable.
 */
import {
  Button,
  DataTable,
  DataTableFilterBar,
  ErrorBox,
  TABLE_SCROLL_MAX_H,
  useDataTableFilter,
  type DataTableFilterConfig,
  type DataTableFilterState,
} from '@camstack/ui-library'
import { Loader2, Trash2, X } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import { credentialColumns, statusLabel, type CredentialRowAction } from './credential-columns'
import type { CredentialRow, CredentialStatus } from './credential-row'
import { countLabel, nounFor, type BulkNoun, type BulkRevoke } from './use-bulk-revoke'
import { useTranslation } from 'react-i18next'

export const CREDENTIAL_PAGE_SIZE = 25

export interface CredentialBulk {
  readonly revoke: BulkRevoke
  readonly noun: BulkNoun
  /** Rows a bulk revoke may include. The caller's session never is. */
  readonly isSelectable: (row: CredentialRow) => boolean
  /** One-click selection helpers ("Select expired") — they select, never revoke. */
  readonly quickSelect?: readonly {
    readonly label: string
    readonly match: (row: CredentialRow) => boolean
  }[]
}

export interface CredentialTableProps {
  readonly rows: readonly CredentialRow[]
  /** "share links" — names the search box and the pager for assistive tech. */
  readonly label: string
  readonly isLoading: boolean
  readonly loadError: string | null
  readonly emptyText: string
  readonly hideOwner?: boolean
  /** What an empty Expires cell says: "Never" for tokens, "—" for kinds with no expiry. */
  readonly expiresNone?: string
  readonly action?: CredentialRowAction
  /** Further per-row actions beside `action` (Rename, Delete …). */
  readonly extraActions?: readonly CredentialRowAction[]
  readonly bulk?: CredentialBulk
  /**
   * Status chips selected on mount (default: active + current). Clear filters
   * drops them so the operator can see expired / revoked rows.
   */
  readonly defaultStatus?: readonly CredentialStatus[]
}

const FILTER_CONFIG: DataTableFilterConfig<CredentialRow> = {
  searchText: (r) => [r.name, r.detail ?? '', r.ownerName, r.kind, r.scope ?? ''],
  facetGroups: [
    { id: 'status', value: (r) => r.status },
    { id: 'owner', value: (r) => r.ownerName },
    { id: 'kind', value: (r) => r.kind },
  ],
}

const GROUP_LABEL_KEY: Readonly<Record<string, string>> = {
  status: 'access.credentialTable.groupStatus',
  owner: 'access.credentialTable.groupOwner',
  kind: 'access.credentialTable.groupKind',
}

const neverCurrent = (row: CredentialRow): boolean => row.status !== 'current'

/** Default: only live credentials — expired / revoked stay one chip-toggle away. */
export const DEFAULT_CREDENTIAL_STATUS: readonly CredentialStatus[] = ['active', 'current']

export function CredentialTable({
  rows,
  label,
  isLoading,
  loadError,
  emptyText,
  hideOwner = false,
  expiresNone,
  action,
  extraActions,
  bulk,
  defaultStatus = DEFAULT_CREDENTIAL_STATUS,
}: CredentialTableProps): ReactNode {
  const { t } = useTranslation()
  // Mount-only — a later change of `defaultStatus` must not reset the chips.
  const [initialFilter] = useState<DataTableFilterState>(() =>
    defaultStatus.length === 0
      ? { search: '', facets: [] }
      : { search: '', facets: [], groups: { status: [...defaultStatus] } },
  )
  const filter = useDataTableFilter(rows, FILTER_CONFIG, initialFilter)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())

  const resolvedExpiresNone = expiresNone ?? t('access.credentialColumns.never')
  const columns = useMemo(
    () =>
      credentialColumns({
        hideOwner,
        expiresNone: resolvedExpiresNone,
        action: action ?? null,
        ...(extraActions !== undefined ? { extraActions } : {}),
      }),
    [hideOwner, resolvedExpiresNone, action, extraActions, t],
  )
  const selectable = useMemo(
    () =>
      bulk === undefined
        ? () => false
        : (row: CredentialRow) => neverCurrent(row) && bulk.isSelectable(row),
    [bulk],
  )
  const targets = useMemo(
    () => filter.rows.filter((r) => selected.has(r.id) && selectable(r)),
    [filter.rows, selected, selectable],
  )

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-4 text-xs text-foreground-subtle">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        {t('access.credentialTable.loading', { label })}
      </div>
    )
  }
  if (loadError !== null) {
    return (
      <ErrorBox
        title={t('access.credentialTable.couldNotLoad', 'Could not load {{label}}', { label })}
        message={loadError}
      />
    )
  }

  return (
    <div className="space-y-3">
      <DataTableFilterBar
        state={filter.state}
        facets={filter.facets}
        groups={filter.groups
          .filter((g) => !(hideOwner && g.id === 'owner'))
          .map((g) => ({
            ...g,
            label: GROUP_LABEL_KEY[g.id] === undefined ? g.id : t(GROUP_LABEL_KEY[g.id] as string),
            ...(g.id === 'status'
              ? {
                  facetLabel: (v: string) => statusLabel(v as CredentialStatus),
                }
              : {}),
          }))}
        labels={{
          searchPlaceholder: t('access.credentialTable.searchPlaceholder', { label }),
          searchLabel: t('access.credentialTable.searchLabel', { label }),
          facetsLabel: t('access.credentialTable.facetsLabel', { label }),
          clearLabel: t('access.credentialTable.clearFilters'),
        }}
        onSearch={filter.setSearch}
        onToggleFacet={filter.toggleFacet}
        onToggleGroupFacet={filter.toggleGroupFacet}
        onClear={filter.clear}
      />
      {bulk !== undefined && (
        <BulkBar
          bulk={bulk}
          shown={filter.rows.filter(selectable)}
          targets={targets}
          onSelect={setSelected}
        />
      )}
      <DataTable
        columns={columns}
        rows={filter.rows}
        rowKey={(r) => r.id}
        minWidthPx={hideOwner ? 760 : 860}
        maxBodyHeight={TABLE_SCROLL_MAX_H}
        defaultSort={{ columnKey: 'created', dir: 'desc' }}
        pageSize={CREDENTIAL_PAGE_SIZE}
        paginationLabels={{
          navLabel: t('access.credentialTable.pagesLabel', { label }),
          previous: t('access.credentialTable.previousPage'),
          next: t('access.credentialTable.nextPage'),
          range: (from, to, total) => t('access.credentialTable.range', { from, to, total }),
        }}
        emptyMessage={
          filter.active
            ? t('access.credentialTable.noMatchTheFilters', 'No {{label}} match the filters.', {
                label,
              })
            : emptyText
        }
        rowClassName={(r) =>
          r.status === 'revoked' || r.status === 'expired' ? 'opacity-70' : undefined
        }
        {...(bulk !== undefined
          ? {
              selection: {
                selected,
                onChange: setSelected,
                isSelectable: selectable,
                rowLabel: (r: CredentialRow) =>
                  t('access.credentialTable.rowLabel', { name: r.name, owner: r.ownerName }),
                pageLabel: t('access.credentialTable.pageLabel', { noun: nounFor(1, bulk.noun) }),
              },
            }
          : {})}
      />
    </div>
  )
}

function BulkBar({
  bulk,
  shown,
  targets,
  onSelect,
}: {
  readonly bulk: CredentialBulk
  readonly shown: readonly CredentialRow[]
  readonly targets: readonly CredentialRow[]
  readonly onSelect: (next: ReadonlySet<string>) => void
}): ReactNode {
  const { t } = useTranslation()
  const { revoke, noun } = bulk
  const quick = (bulk.quickSelect ?? [])
    .map((q) => ({ ...q, rows: shown.filter(q.match) }))
    .filter((q) => q.rows.length > 0)

  const run = async (): Promise<void> => {
    const done = await revoke.run(targets)
    if (done) onSelect(new Set())
  }

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="bulk-bar">
      {shown.length > 0 && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onSelect(new Set(shown.map((r) => r.id)))}
        >
          {t('access.credentialTable.selectAllShown', { count: shown.length })}
        </Button>
      )}
      {quick.map((q) => (
        <Button
          key={q.label}
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onSelect(new Set(q.rows.map((r) => r.id)))}
        >
          {q.label} ({String(q.rows.length)})
        </Button>
      ))}
      {targets.length > 0 && (
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="text-[11px] tabular-nums text-foreground" aria-live="polite">
            {t('access.credentialTable.selectedLabel', { what: countLabel(targets.length, noun) })}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={() => onSelect(new Set())}>
            <X className="h-3 w-3" aria-hidden />
            {t('access.credentialTable.clearSelection', 'Clear selection')}
          </Button>
          <Button
            type="button"
            variant="danger"
            size="sm"
            disabled={revoke.busy}
            onClick={() => void run()}
          >
            {revoke.busy ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            ) : (
              <Trash2 className="h-3 w-3" aria-hidden />
            )}
            {t('access.credentialTable.revoke', { what: countLabel(targets.length, noun) })}
          </Button>
        </div>
      )}
    </div>
  )
}
