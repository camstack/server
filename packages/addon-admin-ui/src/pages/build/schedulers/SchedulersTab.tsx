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
  DataTable,
  EmptyState,
  ErrorBox,
  Skeleton,
  Switch,
  TABLE_SCROLL_MAX_H,
  useItemFormUrl,
  useSchedulersGetStatus,
  useSchedulersList,
  useSchedulersSetEnabled,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { CalendarClock, Plus } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { formatRelativeTime } from '../../../components/device/hero/format'
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
  const { state, openNew, openEdit, close } = useItemFormUrl({
    editKey: 'scheduler',
    newKey: 'new',
  })
  const list = useSchedulersList({}, { refetchInterval: POLL_MS })
  const status = useSchedulersGetStatus({}, { refetchInterval: POLL_MS })
  const setEnabled = useSchedulersSetEnabled({
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [['schedulers']] }),
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
        key: 'name',
        header: t('schedulers.list.name', 'Name'),
        render: (entry) => <span className="font-medium">{entry.name}</span>,
        sortValue: (entry) => entry.name,
      },
      {
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
        key: 'profiles',
        header: t('schedulers.list.profiles', 'Profiles'),
        render: (entry) => String(entry.profiles.length),
        sortValue: (entry) => entry.profiles.length,
      },
      {
        key: 'priority',
        header: t('schedulers.list.priority', 'Priority'),
        render: (entry) => String(entry.priority),
        sortValue: (entry) => entry.priority,
      },
      {
        key: 'status',
        header: t('schedulers.list.status', 'Now'),
        render: (entry) => {
          const view = statusOf(entry)
          return <Badge variant={view.variant}>{view.label}</Badge>
        },
        notSortableReason: t('schedulers.list.statusNotSortable', 'Derived from the live hold'),
      },
      {
        key: 'updated',
        header: t('schedulers.list.updated', 'Updated'),
        render: (entry) => formatRelativeTime(entry.updatedAt),
        sortValue: (entry) => entry.updatedAt,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setEnabled, status.data, t],
  )

  if (state.mode !== 'closed') {
    return (
      <SchedulerEditor
        key={editing?.id ?? 'new'}
        entry={editing}
        onClose={close}
        onSaved={openEdit}
      />
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
        <DataTable
          columns={columns}
          rows={entries}
          rowKey={(entry) => entry.id}
          pageSize={25}
          maxBodyHeight={TABLE_SCROLL_MAX_H}
          emptyMessage={t('schedulers.list.emptyTitle', 'No schedulers yet')}
          onRowClick={(entry) => openEdit(entry.id)}
        />
      )}
    </div>
  )
}
