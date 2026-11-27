/**
 * System → Jobs (`/system/jobs`, planning#719): every job the hub's ledger
 * holds, for admins. One `DataTable` with a State / Kind / Owner filter; the
 * Activity panel in the shell shows the same rows compactly and links here.
 * `jobs` has no live event, so the list polls.
 */
import {
  DataTable,
  DataTableFilterBar,
  ErrorBox,
  TABLE_SCROLL_MAX_H,
  useDataTableFilter,
  useJobsList,
  type DataColumn,
  type DataTableFilterConfig,
} from '@camstack/ui-library'
import type { Job } from '@camstack/types'
import { Activity } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AdminPage } from '../../components/AdminPage'
import { useUserNames } from '../../components/access/AccessSection'
import { JobActions, JobProgress, JobStateBadge } from '../../components/activity/job-parts'
import { jobKindLabelKey, jobStateLabelKey, sortJobs } from '../../components/activity/job-model'
import i18n from '../../i18n/index'

export const JOBS_PAGE_SIZE = 25
const JOBS_POLL_MS = 5_000
const JOBS_LIMIT = 500

interface JobRow {
  readonly job: Job
  readonly title: string
  readonly kindLabel: string
  readonly ownerLabel: string
}

const FILTER_CONFIG: DataTableFilterConfig<JobRow> = {
  searchText: (r) => [r.title, r.kindLabel, r.ownerLabel, r.job.failure?.message ?? ''],
  facetGroups: [
    { id: 'state', value: (r) => r.job.state },
    { id: 'kind', value: (r) => r.kindLabel },
    { id: 'owner', value: (r) => r.ownerLabel },
  ],
}

function toRow(job: Job, names: ReadonlyMap<string, string>): JobRow {
  const kindLabel = i18n.t(jobKindLabelKey(job), { defaultValue: job.kind })
  return {
    job,
    title: i18n.exists(job.titleKey) ? i18n.t(job.titleKey, job.titleParams) : kindLabel,
    kindLabel,
    ownerLabel:
      job.ownerUserId === 'system'
        ? i18n.t('activity.ownerSystem')
        : (names.get(job.ownerUserId) ?? job.ownerUserId),
  }
}

const when = (ts: number | null, none: string): string =>
  ts === null ? none : new Date(ts).toLocaleString()

function jobColumns(): readonly DataColumn<JobRow>[] {
  return [
    {
      key: 'job',
      mobile: 'primary',
      header: i18n.t('jobs.col.job'),
      sortValue: (r) => r.title.toLowerCase(),
      render: (r) => (
        <div className="min-w-0 max-w-[22rem]">
          <div className="truncate font-medium text-foreground" title={r.title}>
            {r.title}
          </div>
          {r.kindLabel !== r.title && (
            <div className="truncate text-[10px] text-foreground-subtle">{r.kindLabel}</div>
          )}
          {r.job.failure !== null && (
            <div className="truncate text-[10px] text-danger" title={r.job.failure.message}>
              {r.job.failure.message}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'state',
      mobile: 'keep',
      header: i18n.t('jobs.col.state'),
      sortValue: (r) => i18n.t(jobStateLabelKey(r.job.state)),
      render: (r) => <JobStateBadge state={r.job.state} />,
    },
    {
      key: 'progress',
      mobile: 'detail',
      header: i18n.t('jobs.col.progress'),
      width: 'w-56',
      notSortableReason: i18n.t('jobs.col.progress'),
      render: (r) => <JobProgress job={r.job} />,
    },
    {
      key: 'owner',
      mobile: 'detail',
      header: i18n.t('jobs.col.owner'),
      sortValue: (r) => r.ownerLabel.toLowerCase(),
      render: (r) => r.ownerLabel,
    },
    {
      key: 'started',
      mobile: 'detail',
      header: i18n.t('jobs.col.started'),
      sortValue: (r) => r.job.createdAt,
      render: (r) => when(r.job.createdAt, '—'),
    },
    {
      key: 'finished',
      mobile: 'hidden',
      header: i18n.t('jobs.col.finished'),
      sortValue: (r) => r.job.finishedAt,
      render: (r) => when(r.job.finishedAt, i18n.t('jobs.notFinished')),
    },
    {
      key: 'actions',
      mobile: 'keep',
      header: '',
      align: 'right',
      notSortableReason: i18n.t('jobs.col.actions'),
      render: (r) => <JobActions job={r.job} />,
    },
  ]
}

export function JobsPage(): ReactNode {
  const { t } = useTranslation()
  const names = useUserNames()
  const list = useJobsList(
    { includeDismissed: true, limit: JOBS_LIMIT },
    { refetchInterval: JOBS_POLL_MS },
  )
  const rows = useMemo(
    () => sortJobs(list.data ?? []).map((j) => toRow(j, names)),
    [list.data, names],
  )
  const filter = useDataTableFilter(rows, FILTER_CONFIG)
  const columns = useMemo(() => jobColumns(), [t])

  return (
    <AdminPage icon={Activity} title={t('jobs.title')} subtitle={t('jobs.subtitle')}>
      {list.isError ? (
        <ErrorBox title={t('jobs.loadFailed')} message={list.error.message} />
      ) : (
        <div className="space-y-3">
          <DataTableFilterBar
            state={filter.state}
            facets={filter.facets}
            groups={filter.groups.map((g) => ({
              ...g,
              label: t(`jobs.group${g.id.charAt(0).toUpperCase()}${g.id.slice(1)}`),
              ...(g.id === 'state' ? { facetLabel: (v: string) => t(`activity.state.${v}`) } : {}),
            }))}
            labels={{
              searchPlaceholder: t('jobs.search'),
              searchLabel: t('jobs.search'),
              facetsLabel: t('jobs.filters'),
              clearLabel: t('jobs.clearFilters'),
            }}
            onSearch={filter.setSearch}
            onToggleFacet={filter.toggleFacet}
            onToggleGroupFacet={filter.toggleGroupFacet}
            onClear={filter.clear}
          />
          <DataTable
            columns={columns}
            rows={filter.rows}
            rowKey={(r) => r.job.jobId}
            minWidthPx={860}
            maxBodyHeight={TABLE_SCROLL_MAX_H}
            pageSize={JOBS_PAGE_SIZE}
            paginationLabels={{
              navLabel: t('jobs.pages'),
              previous: t('jobs.previous'),
              next: t('jobs.next'),
              range: (from, to, total) => t('jobs.range', { from, to, total }),
            }}
            emptyMessage={filter.active ? t('jobs.emptyFiltered') : t('jobs.empty')}
          />
        </div>
      )}
    </AdminPage>
  )
}
