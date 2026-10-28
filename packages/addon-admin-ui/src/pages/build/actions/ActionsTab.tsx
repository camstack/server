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
  DataTable,
  EmptyState,
  ErrorBox,
  TABLE_SCROLL_MAX_H,
  useActionsList,
  useActionsRun,
  useItemFormUrl,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { ListChecks, Play, Plus } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { formatRelativeTime } from '../../../components/device/hero/format'
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
      return { variant: 'neutral', label: t('actions.status.neverRan', 'Never ran') }
    }
    return { variant: 'success', label: t('actions.status.ok', 'OK') }
  }
}

export function ActionsTab({ createRequested = false, onCreateConsumed }: ActionsTabProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const statusView = useStatusView()
  const { state, openNew, openEdit, close } = useItemFormUrl({ editKey: 'action', newKey: 'new' })
  const list = useActionsList({}, { refetchInterval: POLL_MS })
  const run = useActionsRun({
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [['actions']] }),
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
        key: 'name',
        header: t('actions.list.name', 'Name'),
        render: (entry) => <span className="font-medium">{entry.name}</span>,
        sortValue: (entry) => entry.name,
      },
      {
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
        key: 'run',
        align: 'right',
        render: (entry) => (
          <Button
            variant="outline"
            size="sm"
            disabled={run.isPending || entry.status.isRunning}
            aria-label={t('actions.list.runAria', 'Run {{name}}', { name: entry.name })}
            onClick={(e) => {
              e.stopPropagation()
              run.mutate({ actionId: entry.id })
            }}
          >
            <Play className="h-4 w-4" /> {t('actions.list.run', 'Run')}
          </Button>
        ),
        notSortableReason: t('actions.list.runNotSortable', 'A control'),
      },
    ],
    [run, statusView, t],
  )

  if (state.mode !== 'closed') {
    return (
      <ActionEditor key={editing?.id ?? 'new'} entry={editing} onClose={close} onSaved={openEdit} />
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
      {list.error != null && (
        <ErrorBox
          title={t('actions.list.couldNotRead', 'Could not read the actions')}
          message={errorMessage(list.error)}
          onRetry={() => void list.refetch()}
        />
      )}
      {run.error != null && <ErrorBox message={errorMessage(run.error)} />}
      {list.data !== undefined && entries.length === 0 ? (
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
        <DataTable
          columns={columns}
          rows={entries}
          rowKey={(entry) => entry.id}
          pageSize={25}
          maxBodyHeight={TABLE_SCROLL_MAX_H}
          emptyMessage={t('actions.list.loading', 'Loading actions…')}
          onRowClick={(entry) => openEdit(entry.id)}
        />
      )}
    </div>
  )
}
