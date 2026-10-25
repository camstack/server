import type { EntryKindInfo, EntryView } from '@camstack/types'
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import { useCallback, useMemo, useState, type JSX, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '../../primitives/button'
import { EmptyState } from '../empty-state'
import { ErrorBox } from '../error-box'
import { DataTable, TABLE_SCROLL_MAX_H, type DataColumn } from '../data-table'
import { ItemFormDialog } from '../item-form-dialog'
import { useItemFormUrl } from '../use-item-form-url'
import { useConfirm } from '../confirm-dialog'
import {
  useRecordEntriesDeleteEntry,
  useRecordEntriesListEntries,
  useRecordEntriesPutEntry,
} from '../../generated/system-hooks'
import { useUiText } from '../../contexts/ui-text'
import { EntryJsonSchemaForm } from './entry-json-schema-form'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function defaultBody(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema['properties']
  if (!isRecord(properties)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, node] of Object.entries(properties)) {
    if (!isRecord(node)) continue
    if (node['default'] !== undefined) {
      out[key] = node['default']
      continue
    }
    if (node['type'] === 'boolean') out[key] = false
    else if (node['type'] === 'object') out[key] = {}
  }
  return out
}

export interface RecordEntriesPanelProps {
  readonly kind: EntryKindInfo
  /**
   * Extra per-row buttons, drawn before Edit / Delete — for a kind whose rows
   * carry an action of their own (a broker's Sign in / Sign out).
   */
  readonly rowActions?: (entry: EntryView) => ReactNode
  /** Extra columns, drawn between Updated and the actions. */
  readonly extraColumns?: readonly DataColumn<EntryView>[]
  /** Draw the Updated column (default). A kind whose rows say more than a date drops it. */
  readonly showUpdated?: boolean
  /** The table's floor width (`DataTable.minWidthPx`); a kind with few columns lowers it so a phone does not scroll. */
  readonly minWidthPx?: number
}

export function RecordEntriesPanel({
  kind,
  rowActions,
  extraColumns = [],
  showUpdated = true,
  minWidthPx,
}: RecordEntriesPanelProps): JSX.Element {
  const t = useUiText()
  const queryClient = useQueryClient()
  const confirm = useConfirm()
  const formUrl = useItemFormUrl({ newKey: 'entryNew', editKey: 'entryEdit' })

  const listQuery = useRecordEntriesListEntries(
    { owner: kind.owner, kind: kind.kind },
    { staleTime: 15_000 },
  )

  const putMutation = useRecordEntriesPutEntry({
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [['recordEntries']] })
      formUrl.close()
    },
  })

  const deleteMutation = useRecordEntriesDeleteEntry({
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [['recordEntries']] })
    },
  })

  const entries = listQuery.data?.entries ?? []
  const editing = useMemo((): EntryView | null => {
    const st = formUrl.state
    if (st.mode !== 'edit') return null
    return entries.find((e) => e.id === st.id) ?? null
  }, [entries, formUrl.state])

  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [saveError, setSaveError] = useState<string | null>(null)

  const openNew = useCallback((): void => {
    setDraft(defaultBody(kind.fields))
    setSaveError(null)
    formUrl.openNew()
  }, [formUrl, kind.fields])

  const openEdit = useCallback(
    (entry: EntryView): void => {
      setDraft({ ...entry.data })
      setSaveError(null)
      formUrl.openEdit(entry.id)
    },
    [formUrl],
  )

  const onDelete = useCallback(
    async (entry: EntryView): Promise<void> => {
      const ok = await confirm({
        title: t('uiLibrary.recordEntries.deleteTitle', 'Delete entry'),
        message: t('uiLibrary.recordEntries.deleteDescription', 'Remove "{{name}}" permanently?', {
          name: entry.name,
        }),
        confirmLabel: t('uiLibrary.recordEntries.deleteConfirm', 'Delete'),
        variant: 'danger',
      })
      if (!ok) return
      await deleteMutation.mutateAsync({
        owner: kind.owner,
        kind: kind.kind,
        id: entry.id,
      })
    },
    [confirm, deleteMutation, kind.kind, kind.owner, t],
  )

  const columns = useMemo((): readonly DataColumn<EntryView>[] => {
    return [
      {
        key: 'name',
        header: t('uiLibrary.recordEntries.colName', 'Name'),
        render: (row) => (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto max-w-full justify-start px-0 py-0 font-medium hover:underline"
            onClick={() => openEdit(row)}
          >
            <span className="truncate">{row.name}</span>
          </Button>
        ),
      },
      ...(showUpdated
        ? [
            {
              key: 'updated',
              header: t('uiLibrary.recordEntries.colUpdated', 'Updated'),
              nowrap: true,
              render: (row: EntryView) => (
                // Date only: the full time is in the title. A phone has no room for both
                // beside the row's actions.
                <span
                  className="text-[11px] text-foreground-subtle"
                  title={new Date(row.updatedAt).toLocaleString()}
                >
                  {new Date(row.updatedAt).toLocaleDateString()}
                </span>
              ),
            },
          ]
        : []),
      ...extraColumns,
      {
        key: 'actions',
        header: '',
        align: 'right',
        nowrap: true,
        // Shrink to the buttons, so a row's actions are not pushed off a phone.
        width: 'w-px',
        render: (row) => (
          <span className="flex justify-end gap-1">
            {rowActions?.(row)}
            <Button size="sm" variant="ghost" type="button" onClick={() => openEdit(row)}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => void onDelete(row)}>
              <Trash2 className="h-3.5 w-3.5 text-danger" />
            </Button>
          </span>
        ),
      },
    ]
  }, [extraColumns, onDelete, openEdit, rowActions, showUpdated, t])

  const dialogOpen = formUrl.state.mode !== 'closed'
  const dialogTitle =
    formUrl.state.mode === 'new'
      ? t('uiLibrary.recordEntries.addTitle', 'Add entry')
      : t('uiLibrary.recordEntries.editTitle', 'Edit entry')

  const onSave = async (): Promise<void> => {
    setSaveError(null)
    try {
      if (formUrl.state.mode === 'new') {
        await putMutation.mutateAsync({
          owner: kind.owner,
          kind: kind.kind,
          data: draft,
        })
      } else if (formUrl.state.mode === 'edit' && editing !== null) {
        await putMutation.mutateAsync({
          owner: kind.owner,
          kind: kind.kind,
          id: editing.id,
          data: draft,
          ifRev: editing.rev,
        })
      } else {
        setSaveError(t('uiLibrary.recordEntries.saveUnavailable', 'Nothing to save'))
        return
      }
    } catch (err: unknown) {
      setSaveError(
        err instanceof Error ? err.message : t('uiLibrary.recordEntries.saveFailed', 'Save failed'),
      )
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button type="button" size="sm" onClick={openNew}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          {t('uiLibrary.recordEntries.add', 'Add')}
        </Button>
      </div>

      {listQuery.isError && (
        <ErrorBox
          message={
            listQuery.error instanceof Error
              ? listQuery.error.message
              : t('uiLibrary.recordEntries.loadFailed', 'Could not load entries')
          }
        />
      )}

      {listQuery.isPending ? (
        <div className="flex justify-center py-8 text-foreground-subtle">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          title={t('uiLibrary.recordEntries.emptyTitle', 'No entries yet')}
          description={t(
            'uiLibrary.recordEntries.emptyDescription',
            'Add the first row for this kind.',
          )}
        />
      ) : (
        <DataTable
          {...(minWidthPx !== undefined ? { minWidthPx } : {})}
          columns={columns}
          rows={entries}
          rowKey={(r) => r.id}
          maxBodyHeight={TABLE_SCROLL_MAX_H}
          emptyMessage={t('uiLibrary.recordEntries.emptyTitle', 'No entries yet')}
        />
      )}

      <ItemFormDialog
        open={dialogOpen}
        onClose={formUrl.close}
        title={dialogTitle}
        error={saveError}
        footer={
          <Button
            type="button"
            size="sm"
            disabled={putMutation.isPending}
            onClick={() => void onSave()}
          >
            {putMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              t('uiLibrary.recordEntries.save', 'Save')
            )}
          </Button>
        }
      >
        <EntryJsonSchemaForm
          schema={kind.fields}
          secretPaths={kind.secretPaths}
          value={draft}
          onChange={setDraft}
          disabled={putMutation.isPending}
        />
      </ItemFormDialog>
    </div>
  )
}
