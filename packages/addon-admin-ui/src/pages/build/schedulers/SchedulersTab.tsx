/**
 * Schedulers — timelines of edge and hold points that perform actions over the
 * day. The list is `schedulers.list` with where each hold stands
 * (`schedulers.getStatus`); selection lives in the URL (`?scheduler=`, `?new=1`).
 */
import type { Scheduler, SchedulerStatus } from '@camstack/types'
import {
  Badge,
  type BadgeVariant,
  Button,
  type DataColumn,
  EmptyState,
  ErrorBox,
  Skeleton,
  Switch,
  TABLE_SCROLL_MAX_H,
  useItemFormUrl,
  useSchedulersGetStatus,
  useSchedulersList,
  useSchedulersSetEnabled,
  useSchedulersUpdate,
  TaggedDataTable,
} from '@camstack/ui-library'
import { schedulerSearchText, schedulerTags } from '../tag-accessors'
import { useQueryClient } from '@tanstack/react-query'
import { CalendarClock, Plus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatRelativeTime } from '../../../components/device/hero/format'
import { QuickEditDialog } from '../shared/QuickEditDialog'
import { quickEditValuesOf, schedulerQuickEditInput } from '../shared/quick-edit-inputs'
import { BuildQuickModal } from '../shared/BuildQuickModal'
import { runEditorPath } from '../shared/quick-runs'
import { useNavigate } from 'react-router-dom'
import { SchedulerQuickBody } from '../shared/quick-bodies/SchedulerQuickBody'
import { SchedulerEditor } from './SchedulerEditor'

const POLL_MS = 5_000

export interface SchedulersTabProps {
  /** Header "New scheduler" from the Build page: open the editor once, then clear. */
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

export function SchedulersTab({ createRequested = false, onCreateConsumed }: SchedulersTabProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { state, openNew, openEdit, close } = useItemFormUrl({
    editKey: 'scheduler',
    newKey: 'new',
    push: true,
  })
  const list = useSchedulersList({}, { refetchInterval: POLL_MS })
  const status = useSchedulersGetStatus({}, { refetchInterval: POLL_MS })
  const setEnabled = useSchedulersSetEnabled({
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [['schedulers']] }),
  })

  /** The scheduler whose Quick edit modal is open (row action, or right after a create). */
  const [quickEditId, setQuickEditId] = useState<string | null>(null)
  /** The scheduler whose quick modal (row click) is open. */
  const [quickModalId, setQuickModalId] = useState<string | null>(null)
  const modalUpdate = useSchedulersUpdate({
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [['schedulers']] }),
  })
  const quickUpdate = useSchedulersUpdate({
    onSuccess: () => {
      setQuickEditId(null)
      void queryClient.invalidateQueries({ queryKey: [['schedulers']] })
    },
  })

  useEffect(() => {
    if (!createRequested) return
    openNew()
    onCreateConsumed?.()
  }, [createRequested, onCreateConsumed, openNew])

  const entries: readonly Scheduler[] = list.data ?? []
  const editing =
    state.mode === 'edit' ? (entries.find((entry) => entry.id === state.id) ?? null) : null

  const statusOf = (entry: Scheduler): StatusView => {
    if (!entry.enabled) return { variant: 'neutral', label: t('schedulers.status.off', 'Off') }
    const mine: SchedulerStatus | undefined = status.data?.find((s) => s.schedulerId === entry.id)
    if (mine === undefined) return { variant: 'neutral', label: '-' }
    if (mine.hold === null)
      return { variant: 'neutral', label: t('schedulers.status.idle', 'Idle') }
    if (mine.hold.suspendedInactive)
      return {
        variant: 'warning',
        label: t('schedulers.status.paused', 'Paused'),
      }
    if (mine.hold.targets.some((target) => target.status === 'gave-up'))
      return {
        variant: 'danger',
        label: t('schedulers.status.gaveUp', 'Gave up'),
      }
    return {
      variant: 'success',
      label: t('schedulers.status.holding', 'Holding'),
    }
  }

  const columns: DataColumn<Scheduler>[] = useMemo(
    () => [
      {
        mobile: 'primary',
        key: 'name',
        header: t('schedulers.list.name', 'Name'),
        render: (entry) => <span className="font-medium">{entry.name}</span>,
        sortValue: (entry) => entry.name,
      },
      {
        mobile: 'keep',
        key: 'enabled',
        header: t('schedulers.list.enabled', 'Enabled'),
        render: (entry) => (
          <span onClick={(e) => e.stopPropagation()}>
            <Switch
              checked={entry.enabled}
              disabled={setEnabled.isPending}
              aria-label={t('schedulers.list.enabledAria', 'Enable {{name}}', {
                name: entry.name,
              })}
              onCheckedChange={(enabled) => setEnabled.mutate({ schedulerId: entry.id, enabled })}
            />
          </span>
        ),
        sortValue: (entry) => Number(entry.enabled),
      },
      {
        mobile: 'hidden',
        key: 'profiles',
        header: t('schedulers.list.profiles', 'Profiles'),
        render: (entry) => String(entry.profiles.length),
        sortValue: (entry) => entry.profiles.length,
      },
      {
        mobile: 'hidden',
        key: 'priority',
        header: t('schedulers.list.priority', 'Priority'),
        render: (entry) => String(entry.priority),
        sortValue: (entry) => entry.priority,
      },
      {
        mobile: 'detail',
        key: 'status',
        header: t('schedulers.list.status', 'Now'),
        render: (entry) => {
          const view = statusOf(entry)
          return <Badge variant={view.variant}>{view.label}</Badge>
        },
        notSortableReason: t('schedulers.list.statusNotSortable', 'Derived from the live hold'),
      },
      {
        mobile: 'hidden',
        key: 'updated',
        header: t('schedulers.list.updated', 'Updated'),
        render: (entry) => formatRelativeTime(entry.updatedAt),
        sortValue: (entry) => entry.updatedAt,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setEnabled, status.data, t],
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
          const check = schedulerQuickEditInput(quickEditing, values)
          quickUpdate.mutate({
            schedulerId: quickEditing.id,
            scheduler: check,
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
        enabled={modalEntry.enabled}
        enabledBusy={setEnabled.isPending}
        onEnabledChange={(enabled) => setEnabled.mutate({ schedulerId: modalEntry.id, enabled })}
        saving={modalUpdate.isPending}
        error={modalUpdate.error === null ? null : errorMessage(modalUpdate.error)}
        onSave={(values) =>
          modalUpdate.mutate({
            schedulerId: modalEntry.id,
            scheduler: schedulerQuickEditInput(modalEntry, values),
          })
        }
        openLabel={t('build.quickModal.openScheduler', 'Open scheduler')}
        onOpen={() => {
          setQuickModalId(null)
          openEdit(modalEntry.id)
        }}
        onClose={() => {
          modalUpdate.reset()
          setQuickModalId(null)
        }}
      >
        <SchedulerQuickBody
          scheduler={modalEntry}
          onOpenRun={(runId) => {
            setQuickModalId(null)
            void navigate(runEditorPath('schedulers', 'scheduler', modalEntry.id, runId))
          }}
        />
      </BuildQuickModal>
    )

  if (state.mode !== 'closed') {
    return (
      <>
        <SchedulerEditor
          key={editing?.id ?? 'new'}
          entry={editing}
          onClose={close}
          onSaved={(id) => {
            openEdit(id)
            // A new scheduler is named and tagged straight away, in the shared modal.
            setQuickEditId(id)
          }}
          onQuickEdit={editing === null ? undefined : () => setQuickEditId(editing.id)}
        />
        {quickEditDialog}
      </>
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-foreground-subtle">
        {t(
          'schedulers.list.hint',
          'A scheduler does things over the day: run something at a time or at sunset, or keep a device in a state for a stretch of time.',
        )}
      </p>
      {setEnabled.error != null && <ErrorBox message={errorMessage(setEnabled.error)} />}
      {list.data === undefined ? (
        list.error != null ? (
          <ErrorBox
            title={t('schedulers.list.couldNotRead', 'Could not read the schedulers')}
            message={errorMessage(list.error)}
            onRetry={() => void list.refetch()}
          />
        ) : (
          <Skeleton className="h-24 w-full" />
        )
      ) : entries.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title={t('schedulers.list.emptyTitle', 'No schedulers yet')}
          description={t(
            'schedulers.list.emptyDescription',
            'A scheduler turns the garden lights on at sunset and off at 23:00, every day or only on some days.',
          )}
          action={
            <Button onClick={openNew}>
              <Plus className="h-4 w-4" /> {t('schedulers.list.new', 'New scheduler')}
            </Button>
          }
        />
      ) : (
        <TaggedDataTable
          section="schedulers"
          getTags={schedulerTags}
          searchText={schedulerSearchText}
          searchLabel={t('schedulers.list.search', 'Search schedulers')}
          columns={columns}
          rows={entries}
          rowKey={(entry) => entry.id}
          pageSize={25}
          maxBodyHeight={TABLE_SCROLL_MAX_H}
          emptyMessage={t('schedulers.list.emptyTitle', 'No schedulers yet')}
          onRowClick={(entry) => setQuickModalId(entry.id)}
        />
      )}
      {quickEditDialog}
      {quickModal}
    </div>
  )
}
