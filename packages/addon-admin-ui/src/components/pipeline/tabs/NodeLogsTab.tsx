/**
 * NodeLogsTab — per-node "Logs" tab on the Pipeline page.
 *
 * Live view of THIS node's `pipeline-runner` log lines (camera
 * attach/detach, engine phases, per-frame pipeline errors) via the
 * shared `LogStream` composite: one historical `logs.query` page
 * (tags.agentId = <nodeId>, tags.addonId = 'pipeline-runner', 200
 * entries) plus the `logs.subscribe` live tail — no timer polling
 * needed. Toolbar carries the level filter (info default) and
 * follow-the-tail; rows that carry a `deviceId` tag render an inline
 * device chip so lines interleaved across cameras stay attributable.
 */
import { LogStream } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'

const RUNNER_ADDON_ID = 'pipeline-runner'
const HISTORY_LIMIT = 200

interface NodeLogsTabProps {
  readonly nodeId: string
}

export function NodeLogsTab({ nodeId }: NodeLogsTabProps) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-1">
          {t('pipeline.nodeLogsTab.runnerLogs', 'Runner logs')}
        </h3>
        <p className="text-[11px] text-foreground-subtle">
          {t('pipeline.nodeLogsTab.description', { node: nodeId })}
        </p>
      </div>
      <div className="rounded-lg border border-border bg-surface overflow-hidden">
        <LogStream
          agentId={nodeId}
          addonId={RUNNER_ADDON_ID}
          limit={HISTORY_LIMIT}
          maxHeight="max-h-[calc(100vh-360px)]"
          showScope
          showDeviceChip
          showFilters={false}
          showSourceSelect
        />
      </div>
    </div>
  )
}
