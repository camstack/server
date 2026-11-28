/**
 * Archive overview → Activity & health. Archive operations (both ops logs) and the
 * health digest's findings in one list, newest first. Filter by camera, function
 * and severity.
 *
 * An ops log that did not answer is said so; "nothing happened" is claimed only
 * from logs that answered with nothing (D315).
 */
import {
  type DataColumn,
  DataTable,
  EmptyState,
  ErrorBox,
  Select,
  TABLE_SCROLL_MAX_H,
  usePipelineAnalyticsListOpsLog,
  useRecordingArchiveListOpsLog,
} from '@dominevo/ui-library'
import { Activity } from 'lucide-react'
import { useMemo, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import {
  type ActivityFilter,
  type ActivityFunction,
  type ActivityItem,
  type ActivitySeverity,
  filterActivity,
  findingItem,
  opsLogItem,
} from './activity-feed'
import type { ArchiveData } from './use-archive-data'

const ALL = ''
const FUNCTIONS: readonly ActivityFunction[] = ['recording', 'events', 'detection', 'motion']
const SEVERITIES: readonly ActivitySeverity[] = ['info', 'warning', 'critical']

export function ArchiveActivity({
  data,
  deviceId,
}: {
  readonly data: ArchiveData
  /** Camera page: fixed to this camera and the camera filter is hidden. */
  readonly deviceId?: number
}): ReactElement {
  const { t } = useTranslation()
  const recLog = useRecordingArchiveListOpsLog({}, { refetchOnWindowFocus: false })
  const evtLog = usePipelineAnalyticsListOpsLog({}, { refetchOnWindowFocus: false })
  const [camera, setCamera] = useState(ALL)
  const [fn, setFn] = useState(ALL)
  const [severity, setSeverity] = useState(ALL)

  const items = useMemo<readonly ActivityItem[]>(() => {
    const ops = [...(recLog.data ?? []), ...(evtLog.data ?? [])].map(opsLogItem)
    const at = data.digestAtMs ?? 0
    const findings = (data.findings ?? []).map((f) => findingItem(f, at))
    return [...ops, ...findings]
  }, [recLog.data, evtLog.data, data.findings, data.digestAtMs])

  const filter = useMemo<ActivityFilter>(
    () => ({
      deviceId: deviceId ?? (camera === ALL ? null : Number(camera)),
      fn: FUNCTIONS.find((f) => f === fn) ?? null,
      minSeverity: SEVERITIES.find((s) => s === severity) ?? null,
    }),
    [deviceId, camera, fn, severity],
  )
  const rows = useMemo(() => filterActivity(items, filter), [items, filter])
  const nameById = useMemo(() => new Map(data.cameras.map((c) => [c.id, c.name])), [data.cameras])

  const unread: string[] = []
  if (recLog.isError) unread.push(t('archive.activity.footageLog', 'footage'))
  if (evtLog.isError) unread.push(t('archive.activity.eventLog', 'event'))

  const columns = useMemo<readonly DataColumn<ActivityItem>[]>(
    () => [
      {
        mobile: 'detail',
        key: 'at',
        header: t('archive.activity.when', 'When'),
        nowrap: true,
        sortValue: (r) => r.at,
        render: (r) => (
          <span className="tabular-nums text-foreground-subtle">
            {r.at === 0 ? '—' : new Date(r.at).toLocaleString()}
          </span>
        ),
      },
      {
        mobile: 'detail',
        key: 'severity',
        header: t('archive.activity.severity', 'Severity'),
        nowrap: true,
        sortValue: (r) => r.severity,
        render: (r) => (
          <span className={SEVERITY_TEXT[r.severity]}>
            {t(`archive.severity.${r.severity}`, r.severity)}
          </span>
        ),
      },
      {
        mobile: 'detail',
        key: 'camera',
        header: t('archive.activity.camera', 'Camera'),
        sortValue: (r) =>
          r.deviceId === null ? '' : (nameById.get(r.deviceId) ?? `#${String(r.deviceId)}`),
        render: (r) => (
          <span className="text-foreground">
            {r.deviceId === null
              ? t('archive.activity.cluster', 'Cluster')
              : (nameById.get(r.deviceId) ?? `#${String(r.deviceId)}`)}
          </span>
        ),
      },
      {
        mobile: 'primary',
        key: 'what',
        header: t('archive.activity.what', 'What'),
        render: (r) => (
          <div className="flex flex-col">
            <span className="text-foreground">{r.title}</span>
            {r.detail !== null && (
              <span className="text-[11px] text-foreground-subtle">{r.detail}</span>
            )}
          </div>
        ),
      },
    ],
    [t, nameById],
  )

  return (
    <div className="flex flex-col gap-3" data-testid="archive-activity">
      <div className="flex flex-wrap items-center gap-2">
        {deviceId === undefined && (
          <Select
            wrapperClassName="inline-block w-auto"
            value={camera}
            onChange={(e) => setCamera(e.target.value)}
            aria-label={t('archive.activity.filterCamera', 'Camera')}
          >
            <option value={ALL}>{t('archive.activity.allCameras', 'All cameras')}</option>
            {data.cameras.map((c) => (
              <option key={c.id} value={String(c.id)}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
        <Select
          wrapperClassName="inline-block w-auto"
          value={fn}
          onChange={(e) => setFn(e.target.value)}
          aria-label={t('archive.activity.filterFunction', 'Function')}
        >
          <option value={ALL}>{t('archive.activity.allFunctions', 'All functions')}</option>
          {FUNCTIONS.map((f) => (
            <option key={f} value={f}>
              {t(`archive.function.${f}`, f)}
            </option>
          ))}
        </Select>
        <Select
          wrapperClassName="inline-block w-auto"
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
          aria-label={t('archive.activity.filterSeverity', 'Severity')}
        >
          <option value={ALL}>{t('archive.activity.allSeverities', 'Any severity')}</option>
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {t('archive.activity.atLeast', 'At least {{severity}}', {
                severity: t(`archive.severity.${s}`, s),
              })}
            </option>
          ))}
        </Select>
      </div>
      {unread.length > 0 && (
        <ErrorBox
          variant="warning"
          message={t(
            'archive.activity.logUnread',
            'The {{names}} log did not answer. This is not "nothing happened".',
            { names: unread.join(' / ') },
          )}
        />
      )}
      {rows.length === 0 && unread.length === 0 ? (
        <EmptyState
          icon={Activity}
          title={t('archive.activity.none', 'No activity')}
          description={t(
            'archive.activity.noneHint',
            'Pruning, deletion and health findings show up here.',
          )}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          minWidthPx={640}
          maxBodyHeight={TABLE_SCROLL_MAX_H}
          pageSize={25}
        />
      )}
    </div>
  )
}

const SEVERITY_TEXT: Readonly<Record<ActivitySeverity, string>> = {
  info: 'text-foreground-subtle',
  warning: 'text-warning',
  critical: 'text-danger',
}
