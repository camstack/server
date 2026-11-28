/**
 * The Activity entry of the shell (planning#719): an icon button with a badge
 * (running + unseen finished, from `jobs.getSummary`) that opens a panel with
 * the caller's jobs (`jobs.list`). A user sees their own jobs, an admin all of
 * them — the hub decides, this only draws. `jobs` has no live event, so the
 * badge polls slowly and the open panel polls faster.
 *
 * Same placements as `AlertBell`: `icon` in the mobile top bar, `sidebar` in
 * the desktop sidebar row.
 */
import {
  EmptyState,
  ErrorBox,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
  useJobsGetSummary,
  useJobsList,
} from '@dominevo/ui-library'
import type { Job } from '@dominevo/types'
import { Activity } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../contexts/auth-context'
import { formatTimeAgo } from '../ui/AlertBell'
import { activityBadgeCount, sortJobs } from './job-model'
import {
  JobActions,
  JobOwner,
  JobProgress,
  JobStateBadge,
  useJobKindLabel,
  useJobTitle,
} from './job-parts'

export const ACTIVITY_SUMMARY_POLL_MS = 15_000
export const ACTIVITY_LIST_POLL_MS = 4_000
const PANEL_LIMIT = 30

export interface ActivityButtonProps {
  readonly variant?: 'icon' | 'sidebar'
  readonly compact?: boolean
}

function ActivityRow({
  job,
  showOwner,
}: {
  readonly job: Job
  readonly showOwner: boolean
}): ReactNode {
  const { t } = useTranslation()
  const title = useJobTitle(job)
  const kind = useJobKindLabel(job)
  const when = job.finishedAt ?? job.createdAt
  return (
    <li className="space-y-1.5 border-b border-border px-3 py-2.5 last:border-b-0">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-semibold text-foreground" title={title}>
            {title}
          </div>
          <div className="truncate text-[10px] text-foreground-subtle">
            {kind !== title && kind}
            {showOwner && (
              <>
                {kind !== title && ' · '}
                <JobOwner job={job} />
              </>
            )}
          </div>
        </div>
        <JobStateBadge state={job.state} />
      </div>
      <JobProgress job={job} />
      {job.failure !== null && (
        <div className="line-clamp-2 text-[10px] text-danger">{job.failure.message}</div>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] text-foreground-subtle">
          {job.finishedAt === null
            ? t('activity.startedAgo', { when: formatTimeAgo(when) })
            : t('activity.finishedAgo', { when: formatTimeAgo(when) })}
        </span>
        <JobActions job={job} />
      </div>
    </li>
  )
}

function ActivityPanel({ isAdmin }: { readonly isAdmin: boolean }): ReactNode {
  const { t } = useTranslation()
  const list = useJobsList(
    { includeDismissed: false, limit: PANEL_LIMIT },
    { refetchInterval: ACTIVITY_LIST_POLL_MS },
  )
  const jobs = useMemo(() => sortJobs(list.data ?? []), [list.data])
  return (
    <div className="flex w-[min(24rem,calc(100vw-1rem))] max-w-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
        <span className="text-[12px] font-semibold text-foreground">{t('activity.title')}</span>
        {isAdmin && (
          <Link to="/system/jobs" className="text-[10px] text-primary hover:underline">
            {t('activity.viewAll')}
          </Link>
        )}
      </div>
      <div className="max-h-[60vh] overflow-y-auto">
        {list.isLoading && (
          <div className="space-y-2 p-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        )}
        {list.isError && (
          <div className="p-3">
            <ErrorBox title={t('activity.loadFailed')} message={list.error.message} />
          </div>
        )}
        {list.data !== undefined && jobs.length === 0 && (
          <EmptyState icon={Activity} title={t('activity.empty')} />
        )}
        {jobs.length > 0 && (
          <ul>
            {jobs.map((job) => (
              <ActivityRow key={job.jobId} job={job} showOwner={isAdmin} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

export function ActivityButton({
  variant = 'icon',
  compact = false,
}: ActivityButtonProps = {}): ReactNode {
  const { t } = useTranslation()
  const { user } = useAuth()
  const isAdmin = user?.isAdmin === true
  const [open, setOpen] = useState(false)
  const summary = useJobsGetSummary({}, { refetchInterval: ACTIVITY_SUMMARY_POLL_MS })
  const count = activityBadgeCount(summary.data)
  const label = count > 0 ? t('activity.buttonCount', { count }) : t('activity.title')
  const badge = count > 99 ? '99+' : String(count)

  return (
    <Popover open={open} onOpenChange={setOpen} className="block">
      {variant === 'sidebar' ? (
        <PopoverTrigger
          className={`flex w-full items-center gap-2.5 rounded-md ${compact ? 'justify-center px-0 py-2' : 'px-2.5 py-1.5'} text-[12px] text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground`}
          title={compact ? label : undefined}
          aria-label={label}
        >
          <span className="relative inline-flex shrink-0">
            <Activity className="h-3.5 w-3.5" />
            {compact && count > 0 && (
              <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-primary" />
            )}
          </span>
          {!compact && <span className="flex-1 text-left">{t('activity.title')}</span>}
          {!compact && count > 0 && (
            <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-bold leading-none text-primary-foreground">
              {badge}
            </span>
          )}
        </PopoverTrigger>
      ) : (
        <PopoverTrigger
          className="relative rounded-md p-1.5 text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
          aria-label={label}
        >
          <Activity className="h-4.5 w-4.5" />
          {count > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-bold leading-none text-primary-foreground">
              {badge}
            </span>
          )}
        </PopoverTrigger>
      )}
      <PopoverContent align={variant === 'sidebar' ? 'start' : 'end'} className="p-0">
        {open && <ActivityPanel isAdmin={isAdmin} />}
      </PopoverContent>
    </Popover>
  )
}
