/**
 * ClusterOrchestratorLogsTab — Pipeline → Cluster → "Logs" tab.
 *
 * Live view of the `pipeline-orchestrator` addon's log lines (dispatch
 * decisions, balancer moves, failover, session-time attach/detach) via
 * the shared `LogStream` composite: one historical `logs.query` page
 * (tags.addonId = 'pipeline-orchestrator', 200 entries) plus the
 * `logs.subscribe` live tail — no timer polling needed. Toolbar carries
 * the level filter (info default) and follow-the-tail; rows that carry
 * a `deviceId` tag render an inline device chip so the operator can
 * tell WHICH camera a dispatch line refers to at a glance.
 */
import { LogStream } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'

const ORCHESTRATOR_ADDON_ID = 'pipeline-orchestrator'
const HISTORY_LIMIT = 200

export function ClusterOrchestratorLogsTab() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-1">
          {t('pipeline.clusterOrchestratorLogsTab.orchestratorLogs', 'Orchestrator logs')}
        </h3>
        <p className="text-[11px] text-foreground-subtle">
          {t(
            'pipeline.clusterOrchestratorLogsTab.dispatchDecisionsBalancerMovesAnd',
            'Dispatch decisions, balancer moves and failover events from the pipeline orchestrator. Streaming live; the device chip on a line tells which camera it refers to.',
          )}
        </p>
      </div>
      <div className="rounded-lg border border-border bg-surface overflow-hidden">
        <LogStream
          addonId={ORCHESTRATOR_ADDON_ID}
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
