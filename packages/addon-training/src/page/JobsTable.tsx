/**
 * Training jobs as the library DataTable — one row per job; the selected row's
 * detail (timeline, log, result actions) sits under the table.
 */
import { useEffect, useMemo, useState, type JSX, type ReactNode } from 'react'
import type { TrainingJob } from '@camstack/types'
import {
  Badge,
  Button,
  DataTable,
  DataTableFilterBar,
  TABLE_SCROLL_MAX_H,
  useConfirm,
  useDataTableFilter,
  type AddonPageProps,
  type DataColumn,
  type DataTableFilterConfig,
} from '@camstack/ui-library'
import { JobDetail } from './JobDetail.js'
import { errorText } from './use-async.js'
import { useT, type TFn } from '../i18n/index.js'
import { formatCost, isJobState, isSettled, stateTone } from './view-model.js'

export interface JobsTableProps {
  readonly jobs: readonly TrainingJob[]
  readonly trpc: AddonPageProps['trpc']
  readonly onChanged: () => void
  readonly cameraName: (id: number) => string
  readonly collectionName: (id: string) => string
}

function stateLabelOf(t: TFn, value: string): string {
  return isJobState(value) ? t(`state.${value}`) : value
}

function filterConfigOf(t: TFn): DataTableFilterConfig<TrainingJob> {
  return {
    searchText: (j) => [
      j.name,
      j.id,
      j.request.baseModelId,
      j.request.gpuType,
      t(`state.${j.state}`),
      j.stage ?? '',
    ],
    facetValue: (j) => j.state,
  }
}

function ProgressCell({ job }: { readonly job: TrainingJob }): ReactNode {
  const { epoch, epochs } = job.progress
  if (epoch === null || epochs === null) {
    return <span className="text-foreground-subtle">—</span>
  }
  return (
    <span className="tabular-nums text-foreground">
      {epoch} / {epochs}
    </span>
  )
}

function CancelCell({
  job,
  trpc,
  onChanged,
}: {
  readonly job: TrainingJob
  readonly trpc: AddonPageProps['trpc']
  readonly onChanged: () => void
}): ReactNode {
  const { t } = useT()
  const confirm = useConfirm()
  const [error, setError] = useState<string | null>(null)
  if (isSettled(job.state) || job.state === 'cancelling') return null

  const cancel = async (): Promise<void> => {
    const ok = await confirm({
      title: t('jobs.cancelConfirm.title'),
      message: t('jobs.cancelConfirm.message'),
      confirmLabel: t('jobs.cancelConfirm.confirm'),
      variant: 'danger',
    })
    if (!ok) return
    try {
      await trpc.training.cancelJob.mutate({ id: job.id })
      onChanged()
    } catch (err: unknown) {
      setError(errorText(err))
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="danger" size="sm" onClick={() => void cancel()}>
        {t('common.cancel')}
      </Button>
      {error !== null && <span className="text-[10px] text-danger">{error}</span>}
    </div>
  )
}

export function JobsTable({
  jobs,
  trpc,
  onChanged,
  cameraName,
  collectionName,
}: JobsTableProps): JSX.Element {
  const { t, lang } = useT()
  const filterConfig = useMemo(() => filterConfigOf(t), [t])
  const filter = useDataTableFilter(jobs, filterConfig)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    if (filter.rows.length === 0) {
      setSelectedId(null)
      return
    }
    if (selectedId !== null && filter.rows.some((j) => j.id === selectedId)) return
    setSelectedId(filter.rows[0]?.id ?? null)
  }, [filter.rows, selectedId])

  const selected = useMemo(
    () => filter.rows.find((j) => j.id === selectedId) ?? null,
    [filter.rows, selectedId],
  )

  const columns: readonly DataColumn<TrainingJob>[] = useMemo(
    () => [
      {
        key: 'name',
        header: t('jobs.columns.name'),
        nowrap: false,
        sortValue: (j) => j.name,
        render: (j) => (
          <div className="flex min-w-0 flex-col gap-0.5" data-testid={`job-${j.id}`}>
            <span className="text-xs font-medium text-foreground break-words">{j.name}</span>
            <span className="text-[10px] text-foreground-subtle break-words">
              {j.request.baseModelId} · {j.request.gpuType}
            </span>
          </div>
        ),
      },
      {
        key: 'state',
        header: t('jobs.columns.state'),
        sortValue: (j) => j.state,
        render: (j) => (
          <span className="inline-flex flex-wrap items-center gap-1">
            <Badge variant={stateTone(j.state)}>{t(`state.${j.state}`)}</Badge>
            {j.stage !== null && !isSettled(j.state) && <Badge variant="info">{j.stage}</Badge>}
          </span>
        ),
      },
      {
        key: 'collections',
        header: t('jobs.columns.collections'),
        nowrap: false,
        notSortableReason: 'A list of collection names has no single order.',
        render: (j) => {
          const labels = j.request.selection.collectionIds.map((id) => collectionName(id))
          return (
            <span
              className="text-xs text-foreground break-words"
              data-testid={`job-collections-${j.id}`}
            >
              {labels.length > 0 ? labels.join(', ') : '—'}
            </span>
          )
        },
      },
      {
        key: 'progress',
        header: t('jobs.columns.progress'),
        sortValue: (j) => j.progress.epoch ?? -1,
        render: (j) => <ProgressCell job={j} />,
      },
      {
        key: 'cost',
        header: t('jobs.columns.cost'),
        align: 'right',
        sortValue: (j) => j.provider.costUsd,
        render: (j) => (
          <span className="font-mono text-[11px] tabular-nums">
            {formatCost(j.provider.costUsd, j.provider.costIsEstimate)} / ${j.maxCostUsd.toFixed(2)}
          </span>
        ),
      },
      {
        key: 'created',
        header: t('jobs.columns.created'),
        sortValue: (j) => j.createdAt,
        render: (j) => (
          <span className="text-[11px] text-foreground-muted tabular-nums">
            {new Date(j.createdAt).toLocaleString(lang)}
          </span>
        ),
      },
      {
        key: 'actions',
        align: 'right',
        render: (j) => <CancelCell job={j} trpc={trpc} onChanged={onChanged} />,
      },
    ],
    [collectionName, lang, onChanged, t, trpc],
  )

  return (
    <div className="space-y-3">
      <DataTableFilterBar
        state={filter.state}
        facets={filter.facets}
        facetLabel={(value) => stateLabelOf(t, value)}
        labels={{
          searchPlaceholder: t('jobs.filter.searchPlaceholder'),
          searchLabel: t('jobs.filter.searchLabel'),
          facetsLabel: t('jobs.filter.facetsLabel'),
          clearLabel: t('jobs.filter.clearLabel'),
        }}
        onSearch={filter.setSearch}
        onToggleFacet={filter.toggleFacet}
        onClear={filter.clear}
      />
      <DataTable
        columns={columns}
        rows={filter.rows}
        rowKey={(j) => j.id}
        minWidthPx={760}
        maxBodyHeight={TABLE_SCROLL_MAX_H}
        defaultSort={{ columnKey: 'created', dir: 'desc' }}
        emptyMessage={filter.active ? t('jobs.emptyFiltered') : t('jobs.emptyNone')}
        onRowClick={(j) => setSelectedId(j.id)}
        rowClassName={(j) => (j.id === selectedId ? 'bg-primary/[0.04]' : undefined)}
      />
      {selected !== null && (
        <JobDetail
          job={selected}
          trpc={trpc}
          onChanged={onChanged}
          cameraName={cameraName}
          collectionName={collectionName}
        />
      )}
    </div>
  )
}
