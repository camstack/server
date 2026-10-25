/**
 * NodeDetail — right pane of the Pipeline page when a node is selected.
 *
 * Top-level tab bar is owned by `NodeAddonsSettingsPanel`: dynamic tabs
 * from `section.tab` values declared by each addon's
 * `globalSettingsSchema()` + the `extraTabs` we feed here
 * (assignments / tree / engines / logs). No custom bar or routing lives in this
 * file — adding a new tunable section is "stamp `tab: '<id>'` on it"
 * and adding a non-schema surface is "append an entry to `extraTabs`".
 */
import { useClusterNodes } from '@camstack/ui-library'
import { useSearchParams } from 'react-router-dom'
import { STEP_INSPECTOR_PARAMS } from '../../lib/step-url-selection'
import type { ExtraTab } from '../settings/NodeAddonsSettingsPanel'
import { NodeAddonsSettingsPanel } from '../settings/NodeAddonsSettingsPanel'
import { NodeDetailHeader } from './NodeDetailHeader'
import { PIPELINE_NODE_EXTRA_TAB_IDS } from './pipeline-node-extra-tabs'
import { NodeCamerasTab } from './tabs/NodeCamerasTab'
import { NodeEnginesTab } from './tabs/NodeEnginesTab'
import { NodeLogsTab } from './tabs/NodeLogsTab'
import { NodePipelineTab } from './tabs/NodePipelineTab'
import { useTranslation } from 'react-i18next'

// Non-decoder addons that contribute `globalSettingsSchema` sections to the
// Pipeline page. Discovery is explicit (rather than enumerating every installed
// addon) so the tab bar stays stable across hub/agent deployments that happen
// to have extra non-pipeline addons.
const BASE_PIPELINE_ADDONS = ['detection-pipeline', 'audio-analyzer', 'pipeline-runner'] as const

// The decoder surface is resolved by CAPABILITY, not a hardcoded addon id: we
// list whichever addon provides the `decoder` cap on THIS node (node-av by
// default). The panel renders that addon's own hwaccel/probe settings — no
// `decoder-ffmpeg`/`decoder-nodeav` literal. Its section is shown on the
// engine tab (`NODE_TAB_ALIASES`). There is no operator Decoder
// Backend selector; persisted `backend@<nodeId>` rows are left in the store
// and are not read.
const DEFAULT_DECODER_ADDON_ID = 'decoder-nodeav'

interface NodeDetailProps {
  readonly nodeId: string
  readonly refreshToken: number
}

/** `?ntab=` — the node's active tab, so a link (and a reload) lands on it. */
export const NODE_TAB_PARAM = 'ntab'

/**
 * The decoder has one or two settings; it shares the engine tab rather than
 * owning a tab of its own. `?ntab=decoder` (an old link) lands there too.
 */
export const NODE_TAB_ALIASES: Readonly<Record<string, string>> = { decoder: 'engine' }
const NODE_TAB_LABELS: Readonly<Record<string, string>> = { engine: 'Engine & decoder' }

/**
 * A node's page shows only what is stored FOR that node (`perNode` fields).
 * The runner tuning and the audio backend are one cluster value each, read by
 * every node — they are on Cluster → Settings → Runner defaults (audit B7).
 */
const NODE_EMPTY_MESSAGE =
  'Nothing here is set per node. Cluster-wide values are on Cluster → Settings.'

export function NodeDetail({ nodeId, refreshToken }: NodeDetailProps) {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  // Resolve the decoder addon by CAPABILITY for this node (cap-driven, no
  // addon-id literal), falling back to the seeded default (node-av) before the
  // roster loads. The ROSTER hook carries `capabilities` per addon, so the whole
  // cluster diagram is not required for this lookup (D317).
  const { nodes: clusterNodes } = useClusterNodes()
  const decoderAddonId =
    clusterNodes
      .find((n) => n.id === nodeId)
      ?.addons.find((a) => a.capabilities.includes('decoder'))?.addonId ?? DEFAULT_DECODER_ADDON_ID
  const pipelineAddons: readonly string[] = [...BASE_PIPELINE_ADDONS, decoderAddonId]
  const requestedTab = searchParams.get(NODE_TAB_PARAM)

  // Non-schema surfaces sharing the same tab bar as the settings tabs.
  // Order values sit around the WELL_KNOWN_TAB spectrum (see
  // config-ui.ts) so the final ordering stays predictable even when new
  // section.tab ids appear.
  const extraTabById: Record<(typeof PIPELINE_NODE_EXTRA_TAB_IDS)[number], ExtraTab> = {
    assignments: {
      id: 'assignments',
      label: t('pipeline.nodeDetail.assignments', 'Assignments'),
      order: -10,
      content: <NodeCamerasTab nodeId={nodeId} refreshToken={refreshToken} />,
    },
    tree: {
      id: 'tree',
      label: t('pipeline.nodeDetail.pipeline', 'Pipeline'),
      order: 39,
      content: <NodePipelineTab nodeId={nodeId} refreshToken={refreshToken} />,
    },
    engines: {
      id: 'engines',
      label: t('pipeline.nodeDetail.warmInstances', 'Warm instances'),
      order: 180,
      content: <NodeEnginesTab nodeId={nodeId} refreshToken={refreshToken} />,
    },
    logs: {
      id: 'logs',
      label: t('pipeline.nodeDetail.logs', 'Logs'),
      order: 300,
      content: <NodeLogsTab nodeId={nodeId} />,
    },
  }
  const extraTabs: readonly ExtraTab[] = PIPELINE_NODE_EXTRA_TAB_IDS.map((id) => extraTabById[id])

  // Per-device inference config is NOT here anymore — it moved to the ONE
  // cluster surface: Cluster → Load balancing → Accelerators (`NodeInferenceDevices`,
  // D748), rendered as a nodes→devices tree (Block D2). The #33
  // "Inference Engine" tab now shows only the engine forms + model-substitution
  // status; live engine-pool telemetry is on the "Warm instances" tab.
  // Per-node decode limits live on pipeline-runner's globalSettingsSchema
  // (`perNode: true`, tab engine) — not a parallel card.
  return (
    <div className="flex flex-col h-full">
      <NodeDetailHeader nodeId={nodeId} refreshToken={refreshToken} />
      <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6">
        <NodeAddonsSettingsPanel
          nodeId={nodeId}
          addonIds={pipelineAddons}
          level="global"
          fieldScope="perNode"
          emptyMessage={NODE_EMPTY_MESSAGE}
          tabAliases={NODE_TAB_ALIASES}
          tabLabelOverrides={NODE_TAB_LABELS}
          extraTabs={extraTabs}
          activeTab={
            requestedTab === null ? null : (NODE_TAB_ALIASES[requestedTab] ?? requestedTab)
          }
          onActiveTabChange={(tabId) =>
            setSearchParams(
              (prev) => {
                const next = new URLSearchParams(prev)
                next.set(NODE_TAB_PARAM, tabId)
                // The step matrix's open cell belongs to the Pipeline tab.
                for (const key of STEP_INSPECTOR_PARAMS) next.delete(key)
                return next
              },
              { replace: true },
            )
          }
        />
      </div>
    </div>
  )
}
