/**
 * Actions — the named things the installation can do, run by hand, by a
 * camera, or by an automation's Then step.
 *
 * The list is `actions.list` (every `action-source` provider, live). An
 * internal action opens in the editor beside its Runs panel; an addon's is
 * read-only there. Selection lives in the URL (`?action=`, `?new=1`).
 */

import type { ActionEntry } from '@camstack/types'
import {
  Badge,
  type BadgeVariant,
  Button,
  type DataColumn,
  EmptyState,
  ErrorBox,
  Skeleton,
  TABLE_SCROLL_MAX_H,
  useActionsList,
  useActionsRun,
  useActionsUpdate,
  useItemFormUrl,
  TaggedDataTable,
} from '@camstack/ui-library'
import { actionSearchText, actionTags } from '../tag-accessors'
import { useQueryClient } from '@tanstack/react-query'
import { ListChecks, Play, Plus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { formatRelativeTime } from '../../../components/device/hero/format'
import { QuickEditDialog } from '../shared/QuickEditDialog'
import { actionQuickEditInput, quickEditValuesOf } from '../shared/quick-edit-inputs'
import { BuildQuickModal } from '../shared/BuildQuickModal'
import { ActionExporters } from '../shared/quick-bodies/ActionExporters'
import { ActionQuickBody } from '../shared/quick-bodies/ActionQuickBody'
import { ActionEditor } from './ActionEditor'

const POLL_MS = 5_000

export interface ActionsTabProps {
  /** Header "New action" from the Build page: open the editor once, then clear. */
  readonly createRequested?: boolean
  readonly onCreateConsumed?: () => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface StatusView {
  readonly variant: BadgeVariant
  readonly label: string
}

function useStatusView(): (entry: ActionEntry) => StatusView {
  const { t } = useTranslation()
  return (entry) => {
    if (entry.status.isRunning) {
      return { variant: 'info', label: t('actions.status.running', 'Running') }
    }
    if (entry.status.lastError !== null) {
      return { variant: 'danger', label: t('actions.status.failed', 'Failed') }
    }
    if (entry.status.lastRunAt === null) {
      return {
        variant: 'neutral',
        label: t('actions.status.neverRan', 'Never ran'),
      }
    }
    return { variant: 'success', label: t('actions.status.ok', 'OK') }
  }
}

export function ActionsTab({ createRequested = false, onCreateConsumed }: ActionsTabProps) {
  const { t } = useTranslation()
  const [params] = useSearchParams()
  const queryClient = useQueryClient()
  const statusView = useStatusView()
  const { state, openNew, openEdit, close } = useItemFormUrl({
    editKey: 'action',
    newKey: 'new',
    push: true,
  })
  const list = useActionsList({}, { refetchInterval: POLL_MS })
  const run = useActionsRun({
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [['actions']] }),
  })

  /** The action whose Quick edit modal is open (row action, or right after a create). */
  const [quickEditId, setQuickEditId] = useState<string | null>(null)
  /** The action whose quick modal (row click) is open. */
  const [quickModalId, setQuickModalId] = useState<string | null>(null)
  const modalUpdate = useActionsUpdate({
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [['actions']] }),
  })
  const quickUpdate = useActionsUpdate({
    onSuccess: () => {
      setQuickEditId(null)
      void queryClient.invalidateQueries({ queryKey: [['actions']] })
    },
  })

  useEffect(() => {
    if (!createRequested) return
    openNew()
    onCreateConsumed?.()
  }, [createRequested, onCreateConsumed, openNew])

  const entries: readonly ActionEntry[] = list.data ?? []
  const editing =
    state.mode === 'edit' ? (entries.find((entry) => entry.id === state.id) ?? null) : null

  const columns: DataColumn<ActionEntry>[] = useMemo(
    () => [
      {
        mobile: 'primary',
        key: 'name',
        header: t('actions.list.name', 'Name'),
        render: (entry) => <span className="font-medium">{entry.name}</span>,
        sortValue: (entry) => entry.name,
      },
      {
        mobile: 'detail',
        key: 'source',
        header: t('actions.list.source', 'Source'),
        render: (entry) =>
          entry.readOnly ? (
            <Badge variant="info">{entry.addonId}</Badge>
          ) : (
            <Badge variant="primary">{t('actions.source.internal', 'Internal')}</Badge>
          ),
        sortValue: (entry) => entry.addonId,
      },
      {
        mobile: 'hidden',
        key: 'lastRun',
        header: t('actions.list.lastRun', 'Last run'),
        render: (entry) =>
          entry.status.lastRunAt === null ? (
            <span className="text-foreground-subtle">{'-'}</span>
          ) : (
            formatRelativeTime(entry.status.lastRunAt)
          ),
        sortValue: (entry) => entry.status.lastRunAt,
      },
      {
        mobile: 'detail',
        key: 'status',
        header: t('actions.list.status', 'Status'),
        render: (entry) => {
          const view = statusView(entry)
          return (
            <span title={entry.status.lastError ?? undefined}>
              <Badge variant={view.variant}>{view.label}</Badge>
            </span>
          )
        },
        notSortableReason: t('actions.list.statusNotSortable', 'Derived from the latest run'),
      },
      {
        mobile: 'keep',
        key: 'run',
        align: 'right',
        render: (entry) => (
          <span className="inline-flex items-center justify-end gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={run.isPending || entry.status.isRunning}
              aria-label={t('actions.list.runAria', 'Run {{name}}', {
                name: entry.name,
              })}
              onClick={(e) => {
                e.stopPropagation()
                run.mutate({ actionId: entry.id })
              }}
            >
              <Play className="h-4 w-4" /> {t('actions.list.run', 'Run')}
            </Button>
          </span>
        ),
        notSortableReason: t('actions.list.runNotSortable', 'A control'),
      },
    ],
    [run, statusView, t],
  )

  const quickEditing =
    quickEditId === null ? null : (entries.find((entry) => entry.id === quickEditId) ?? null)
  const quickEditDialog =
    quickEditing === null ? null : (
      <QuickEditDialog
        subject={quickEditValuesOf(quickEditing)}
        subjectKey={quickEditing.id}
        saving={quickUpdate.isPending}
        error={quickUpdate.error === null ? null : errorMessage(quickUpdate.error)}
        onSave={(values) => {
          const check = actionQuickEditInput(quickEditing, values)
          if (check.ok)
            quickUpdate.mutate({
              actionId: quickEditing.id,
              action: check.input,
            })
        }}
        onClose={() => {
          quickUpdate.reset()
          setQuickEditId(null)
        }}
      />
    )

  const modalEntry =
    quickModalId === null ? null : (entries.find((entry) => entry.id === quickModalId) ?? null)
  const quickModal =
    modalEntry === null ? null : (
      <BuildQuickModal
        subjectKey={modalEntry.id}
        name={modalEntry.name}
        tags={modalEntry.tags ?? []}
        readOnly={modalEntry.readOnly}
        saving={modalUpdate.isPending}
        error={modalUpdate.error === null ? null : errorMessage(modalUpdate.error)}
        onSave={(values) => {
          const check = actionQuickEditInput(modalEntry, values)
          if (check.ok) modalUpdate.mutate({ actionId: modalEntry.id, action: check.input })
        }}
        openLabel={t('build.quickModal.openAction', 'Open action')}
        onOpen={() => {
          setQuickModalId(null)
          openEdit(modalEntry.id)
        }}
        onClose={() => {
          modalUpdate.reset()
          setQuickModalId(null)
        }}
        exporters={<ActionExporters actionId={modalEntry.id} />}
      >
        <ActionQuickBody entry={modalEntry} />
      </BuildQuickModal>
    )

  if (state.mode !== 'closed') {
    return (
      <>
        <ActionEditor
          key={editing?.id ?? 'new'}
          entry={editing}
          onClose={close}
          onSaved={(id) => {
            openEdit(id)
            // A new action is named and tagged straight away, in the shared modal.
            setQuickEditId(id)
          }}
          onQuickEdit={editing === null ? undefined : () => setQuickEditId(editing.id)}
          preset={state.mode === 'new' ? params.get('preset') : null}
        />
        {quickEditDialog}
      </>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-foreground-subtle">
        {t(
          'actions.list.hint',
          'Actions are things this installation can do. Run one here, link it to a camera, or use it in an automation.',
        )}
      </p>
      {run.error != null && <ErrorBox message={errorMessage(run.error)} />}
      {list.data === undefined ? (
        list.error != null ? (
          <ErrorBox
            title={t('actions.list.couldNotRead', 'Could not read the actions')}
            message={errorMessage(list.error)}
            onRetry={() => void list.refetch()}
          />
        ) : (
          <Skeleton className="h-24 w-full" />
        )
      ) : entries.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title={t('actions.list.emptyTitle', 'No actions yet')}
          description={t(
            'actions.list.emptyDescription',
            'An action is a short list of commands, such as feeding the dog, that you can reuse.',
          )}
          action={
            <Button onClick={openNew}>
              <Plus className="h-4 w-4" /> {t('actions.list.new', 'New action')}
            </Button>
          }
        />
      ) : (
        <>
          {list.error != null && (
            <ErrorBox
              title={t('actions.list.couldNotRead', 'Could not read the actions')}
              message={errorMessage(list.error)}
              onRetry={() => void list.refetch()}
            />
          )}
          <TaggedDataTable
            section="actions"
            getTags={actionTags}
            searchText={actionSearchText}
            searchLabel={t('actions.list.search', 'Search actions')}
            columns={columns}
            rows={entries}
            rowKey={(entry) => entry.id}
            pageSize={25}
            maxBodyHeight={TABLE_SCROLL_MAX_H}
            emptyMessage={t('actions.list.emptyTitle', 'No actions yet')}
            onRowClick={(entry) => setQuickModalId(entry.id)}
          />
        </>
      )}
      {quickEditDialog}
      {quickModal}
    </div>
  )
}
