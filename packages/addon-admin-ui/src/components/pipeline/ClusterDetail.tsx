/**
 * ClusterDetail — right pane of the Pipeline page when the synthetic
 * "Cluster" entry is selected.
 *
 * Tabs:
 *  - Assignments:     WHICH camera runs WHERE — camera health strip + the
 *                     camera→node/device assignment matrix (node pin,
 *                     inference-device pin, resolved placement, live status,
 *                     per-row broker drill-down).
 *  - Load balancing:  HOW MUCH each node and accelerator carries (D748) — the
 *                     placement policy and reactive policies, live load, node
 *                     shares (target vs actual), max concurrent sessions, the
 *                     hardware suggestion, accelerators, stale pins, and what
 *                     Auto tune would pick under the shares.
 *  - Auto tune:   the cluster-wide detector recommendation (D745) —
 *                     plan, full diff, confirmed apply.
 *  - Roles (`?ctab=roles-nodes`): WHO does what — singleton cluster roles,
 *                     per-node capabilities, decode limits.
 *  - Settings:        cluster-wide settings, one card per subject — faces
 *                     & recognition, semantic search, crops, runner
 *                     defaults, failover (`cluster-settings-sections.ts`).
 *  - Logs:            live `pipeline-orchestrator` log stream.
 *  - Palette:         the cluster display palette — presets or a custom
 *                     table, one colour per kind on both themes (D939).
 *
 * Per-camera pipeline editing lives on Device → Detection pipeline. Recording
 * and event folders stay on Recordings. There are no pipeline templates (D759):
 * a stale `?ctab=templates` link lands on Assignments.
 */
import { Tabs, TabsList, TabsTrigger } from '@camstack/ui-library'
import { useSearchParams } from 'react-router-dom'
import { CLUSTER_SECTION_PARAM, CLUSTER_TAB_PARAM } from './pipeline-links'
import { ClusterAssignmentsTab } from './tabs/ClusterAssignmentsTab'
import { ClusterAutoTuneTab } from './tabs/ClusterAutoTuneTab'
import { ClusterLoadBalancingTab } from './tabs/ClusterLoadBalancingTab'
import { ClusterRolesNodesTab } from './tabs/ClusterRolesNodesTab'
import { ClusterSettingsTab } from './tabs/ClusterSettingsTab'
import { ClusterPaletteTab } from './tabs/ClusterPaletteTab'
import { ClusterOrchestratorLogsTab } from './tabs/ClusterOrchestratorLogsTab'
import { useTranslation } from 'react-i18next'

type ClusterTabId =
  | 'assignments'
  | 'load-balancing'
  | 'auto-tune'
  | 'roles-nodes'
  | 'settings'
  | 'logs'
  | 'palette'

const TABS: Array<{ id: ClusterTabId; labelKey: string }> = [
  { id: 'assignments', labelKey: 'pipeline.clusterDetail.tabAssignments' },
  { id: 'load-balancing', labelKey: 'pipeline.clusterDetail.tabLoadBalancing' },
  { id: 'auto-tune', labelKey: 'pipeline.clusterDetail.tabAutoTune' },
  // Tab id stays `roles-nodes` for stable deep links; label is "Roles" only.
  { id: 'roles-nodes', labelKey: 'pipeline.clusterDetail.tabRoles' },
  { id: 'settings', labelKey: 'common.settings' },
  { id: 'logs', labelKey: 'common.logs' },
  { id: 'palette', labelKey: 'pipeline.clusterDetail.tabPalette' },
]

interface ClusterDetailProps {
  readonly refreshToken: number
}

function isClusterTab(id: string | null): id is ClusterTabId {
  return TABS.some((t) => t.id === id)
}

export function ClusterDetail({ refreshToken }: ClusterDetailProps) {
  const { t } = useTranslation()
  // The tab lives in `?ctab=` so a link can land on it ("these knobs live in
  // Cluster → Settings → Faces & recognition") and a reload keeps it.
  const [searchParams, setSearchParams] = useSearchParams()
  const requested = searchParams.get(CLUSTER_TAB_PARAM)
  const tab: ClusterTabId = isClusterTab(requested) ? requested : 'assignments'
  const setTab = (next: ClusterTabId): void => {
    setSearchParams(
      (prev) => {
        const out = new URLSearchParams(prev)
        out.set(CLUSTER_TAB_PARAM, next)
        out.delete(CLUSTER_SECTION_PARAM)
        return out
      },
      { replace: true },
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 sm:px-6 py-4 border-b border-border">
        <h2 className="text-base font-semibold text-foreground">
          {t('pipeline.clusterDetail.clusterOrchestration', 'Cluster Orchestration')}
        </h2>
        <div className="text-[11px] text-foreground-subtle mt-1">
          {t(
            'pipeline.clusterDetail.cameraAssignmentsLoadBalancingThe',
            'Camera assignments, load balancing, the detector recommendation, cluster roles, settings and the display palette.',
          )}
        </div>
      </div>

      <Tabs
        value={tab}
        onValueChange={(next) => {
          if (isClusterTab(next)) setTab(next)
        }}
        className="px-4 sm:px-6"
      >
        <TabsList className="border-border">
          {TABS.map((item) => (
            <TabsTrigger key={item.id} value={item.id} className="h-auto py-2 border-b-2">
              {t(item.labelKey)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6 @container/clustertab">
        {tab === 'assignments' && <ClusterAssignmentsTab />}
        {tab === 'load-balancing' && (
          <ClusterLoadBalancingTab
            refreshToken={refreshToken}
            onOpenAutoTune={() => setTab('auto-tune')}
          />
        )}
        {tab === 'auto-tune' && <ClusterAutoTuneTab />}
        {tab === 'roles-nodes' && <ClusterRolesNodesTab />}
        {tab === 'settings' && <ClusterSettingsTab refreshToken={refreshToken} />}
        {tab === 'logs' && <ClusterOrchestratorLogsTab />}
        {tab === 'palette' && <ClusterPaletteTab />}
      </div>
    </div>
  )
}
