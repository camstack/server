/**
 * ActivitySection — the shared ops-log ("Activity") view.
 *
 * Merges the recordings ops-log (`recording.listOpsLog`) and the events
 * ops-log (`pipelineAnalytics.listOpsLog`) into one newest-first table with a
 * domain filter (all / recording / events). Columns: timestamp, domain, op,
 * reason, device, itemsAffected, bytesReclaimed.
 *
 * ## The table is the app's standard one, with the app's standard props
 *
 * `<DataTable>` is the admin UI's table (19 surfaces; the sibling Export tab,
 * Notification History, Processes and AI Usage all use it). This surface used
 * it already but skipped the three conventions
 * ([admin-patterns.md → Table conventions](../../../../../docs/ui/admin-patterns.md)) that
 * make a LIST of manageable items readable, and now carries all three:
 *
 *   - `maxBodyHeight={TABLE_SCROLL_MAX_H}` — the rows scroll inside the box
 *     and the header is pinned, so the domain filter stays reachable while an
 *     operator reads a few hundred prune rows. An ops log grows without
 *     bound; it is the case the cap exists for.
 *   - a table at every width — every question asked of this log is a
 *     per-column one ("which camera keeps getting pruned?", "what reclaimed
 *     the most?"), so the seven columns scroll sideways inside the box.
 *   - column `sortValue` + `defaultSort` — sorting is a property of the
 *     column, and it was simply missing. Each `sortValue` returns the RAW
 *     value (`r.at`, `r.bytesReclaimed`), never the rendered one: "9 MB"
 *     sorts after "1 GB" as text. The rows arrive newest-first and
 *     `defaultSort` opens on the same order, so an operator who cycles the
 *     `When` header back to "none" lands on what he started with.
 *
 * ## Empty is not broken, and broken does not read as empty
 *
 * The two reads fail independently. A silent merge would render one dead
 * query as a shorter list and no dead query at all as "No activity yet" —
 * both of which say "nothing happened" about work that may well have. So a
 * failed domain is NAMED: inline when the other domain still has rows, and as
 * the empty state's own framing when there is nothing to show. An operator
 * reading zero rows has to be able to tell "nothing was pruned" from "nobody
 * answered".
 */

import type { OpsLogDomain, OpsLogEntry } from '@camstack/types'
import type { DataColumn, TableSortState } from '@camstack/ui-library'
import {
  DataTable,
  EmptyState,
  TABLE_SCROLL_MAX_H,
  useDeviceManagerListAll,
  usePipelineAnalyticsListOpsLog,
  useRecordingArchiveListOpsLog,
  Button,
} from '@camstack/ui-library'
import { Activity, AlertTriangle, Loader2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { formatBytes } from '../../lib/format-size'
import { useTranslation } from 'react-i18next'

type DomainFilter = 'all' | OpsLogDomain

const DOMAIN_FILTERS: readonly { value: DomainFilter; labelKey: string }[] = [
  { value: 'all', labelKey: 'common.all' },
  { value: 'recording', labelKey: 'recordings.activitySection.domainRecordings' },
  { value: 'events', labelKey: 'common.events' },
]

const DOMAIN_STYLE: Record<OpsLogDomain, string> = {
  recording: 'bg-primary/10 text-primary',
  events: 'bg-violet-500/10 text-violet-400',
}

/** Newest first — the order the rows already arrive in, so cycling the `When`
 *  column back to "none" returns to the log's natural reading. */
const DEFAULT_SORT: TableSortState = { columnKey: 'at', dir: 'desc' }

function formatTimestamp(at: number): string {
  return new Date(at).toLocaleString()
}

export function ActivitySection() {
  const { t, i18n } = useTranslation()
  const [domain, setDomain] = useState<DomainFilter>('all')

  const {
    data: recRows,
    isLoading: recLoading,
    isError: recFailed,
  } = useRecordingArchiveListOpsLog({}, { refetchOnWindowFocus: false })
  const {
    data: evtRows,
    isLoading: evtLoading,
    isError: evtFailed,
  } = usePipelineAnalyticsListOpsLog({}, { refetchOnWindowFocus: false })
  // Every ops-log row is keyed by camera — cameras only, slim, and the query client's fleet window (D274) so the recordings-page sections share one fetch.
  const { data: devices } = useDeviceManagerListAll({ isCamera: true, projection: 'slim' })

  const cameraName = useMemo<ReadonlyMap<number, string>>(() => {
    const byId = new Map<number, string>()
    for (const d of devices ?? []) byId.set(d.id, d.name)
    return byId
  }, [devices])

  const rows = useMemo<readonly OpsLogEntry[]>(() => {
    const merged: OpsLogEntry[] = [...(recRows ?? []), ...(evtRows ?? [])]
    const filtered = domain === 'all' ? merged : merged.filter((r) => r.domain === domain)
    return filtered.toSorted((a, b) => b.at - a.at)
  }, [recRows, evtRows, domain])

  /** Which domains could not be read, in operator words. Empty = both answered. */
  const failedDomains = useMemo<readonly string[]>(() => {
    const failed: string[] = []
    if (recFailed && domain !== 'events')
      failed.push(t('recordings.activitySection.domainRecordings'))
    if (evtFailed && domain !== 'recording') failed.push(t('common.events'))
    return failed
  }, [recFailed, evtFailed, domain, t])
  const failedDomainNames = useMemo(
    () => new Intl.ListFormat(i18n.language, { type: 'conjunction' }).format(failedDomains),
    [failedDomains, i18n.language],
  )

  const columns = useMemo<readonly DataColumn<OpsLogEntry>[]>(
    () => [
      {
        key: 'at',
        header: t('recordings.activitySection.when', 'When'),
        nowrap: true,
        sortValue: (r) => r.at,
        render: (r) => (
          <span className="text-foreground-subtle tabular-nums">{formatTimestamp(r.at)}</span>
        ),
      },
      {
        key: 'domain',
        header: t('recordings.activitySection.domain', 'Domain'),
        sortValue: (r) => r.domain,
        render: (r) => (
          <span
            className={`inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium ${DOMAIN_STYLE[r.domain]}`}
          >
            {r.domain}
          </span>
        ),
      },
      {
        key: 'op',
        header: t('recordings.activitySection.operation', 'Operation'),
        sortValue: (r) => r.op,
        render: (r) => <span className="text-foreground">{r.op}</span>,
      },
      {
        key: 'reason',
        header: t('recordings.activitySection.reason', 'Reason'),
        sortValue: (r) => r.reason,
        render: (r) => <span className="text-foreground-subtle">{r.reason}</span>,
      },
      {
        key: 'device',
        header: t('recordings.activitySection.camera', 'Camera'),
        // The camera NAME is this column's value — sorting by the numeric id
        // would order a column nobody reads as numbers. A cluster-wide row is
        // a real value ('cluster'), not a missing one, so it never sorts last.
        sortValue: (r) =>
          r.deviceId === null
            ? 'cluster'
            : (cameraName.get(r.deviceId) ?? `#${String(r.deviceId)}`),
        render: (r) =>
          r.deviceId === null ? (
            <span className="text-foreground-subtle">{t('common.cluster')}</span>
          ) : (
            <span className="text-foreground">
              {cameraName.get(r.deviceId) ?? `#${String(r.deviceId)}`}
            </span>
          ),
      },
      {
        key: 'items',
        header: t('recordings.activitySection.items', 'Items'),
        align: 'right',
        nowrap: true,
        sortValue: (r) => r.itemsAffected,
        render: (r) => <span className="tabular-nums">{r.itemsAffected.toLocaleString()}</span>,
      },
      {
        key: 'bytes',
        header: t('recordings.activitySection.reclaimed', 'Reclaimed'),
        align: 'right',
        nowrap: true,
        sortValue: (r) => r.bytesReclaimed,
        render: (r) => (
          <span className="tabular-nums">
            {r.bytesReclaimed > 0 ? formatBytes(r.bytesReclaimed) : '—'}
          </span>
        ),
      },
    ],
    [cameraName, t],
  )

  const isLoading = recLoading || evtLoading

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-1">
        {DOMAIN_FILTERS.map((f) => (
          <Button
            variant="unstyled"
            key={f.value}
            onClick={() => setDomain(f.value)}
            className={`rounded px-2 py-1 text-xs font-medium ${
              domain === f.value
                ? 'bg-primary/10 text-primary'
                : 'text-foreground-subtle hover:bg-muted'
            }`}
          >
            {t(f.labelKey)}
          </Button>
        ))}
      </div>

      {isLoading && rows.length === 0 ? (
        <div className="flex items-center gap-2 py-8 text-xs text-foreground-subtle">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('recordings.activitySection.loadingActivity', 'Loading activity…')}
        </div>
      ) : rows.length === 0 ? (
        failedDomains.length > 0 ? (
          <EmptyState
            icon={AlertTriangle}
            title={t(
              'recordings.activitySection.activityCouldNotBeRead',
              'Activity could not be read',
            )}
            description={t(
              'recordings.activitySection.theOpsLogDidNot',
              'The {{value1}} ops log did not answer. This is not "nothing happened" — retry, or check the node that owns it.',
              { value1: failedDomainNames },
            )}
          />
        ) : (
          <EmptyState
            icon={Activity}
            title={t('recordings.activitySection.noActivityYet', 'No activity yet')}
            description={t(
              'recordings.activitySection.pruneDeleteAndRescanOperations',
              'Prune, delete and rescan operations across recordings and events show up here.',
            )}
          />
        )
      ) : (
        <>
          {failedDomains.length > 0 && (
            <p className="flex items-center gap-1.5 text-[11px] text-amber-500">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              {t('recordings.activitySection.domainsMissing', {
                count: failedDomains.length,
                names: failedDomainNames,
              })}
            </p>
          )}
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            minWidthPx={720}
            maxBodyHeight={TABLE_SCROLL_MAX_H}
            defaultSort={DEFAULT_SORT}
          />
        </>
      )}
    </div>
  )
}
